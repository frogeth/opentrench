import { Router, json, type Request, type Response } from 'express';
import { fetch as undiciFetch } from 'undici';
import { jsonErrors } from '../http.js';
import type { MessageHub } from '../hub.js';
import type { FeedMessage, ServerEvent } from '../types.js';
import { cleanText, POSTS_PER_WINDOW, POST_WINDOW_MS, PostLimiter, toFeedMessage, toMedia, type PluginPost } from './feed.js';
import { isLocalHost, isLoopbackIp } from './hosts.js';
import { CREDENTIAL_HEADERS, HEADER_NAME_RE, REDIRECT_STATUS, REQUEST_HEADER_STRIP } from './http.js';
import { MAX_FILE, MAX_FILE_MESSAGE } from './manifest.js';
import { RegistryError, type PluginRegistry } from './registry.js';
import { safeDispatcher, type ShellLink } from './shell.js';
import type { PluginState } from './state.js';

/** The slice of ConfigStore these routes need (keeps tests free of the real store). */
export interface WatchConfig {
  get(): { plugins: Record<string, { enabled: boolean; approvedHash?: string }>; pluginWatch: string[] };
  update(fn: (c: { plugins: Record<string, { enabled: boolean; approvedHash?: string }>; pluginWatch: string[] }) => void): void;
}

export interface PluginsApiOptions {
  /** the downloader `add-url` uses; undici's own fetch by default, so `safeDispatcher()` applies */
  fetchImpl?: typeof fetch;
}

/** A plugin's own fetches: 120 a minute is generous for polling and cheap to refuse. */
const FETCHES_PER_WINDOW = 120;
const FETCH_WINDOW_MS = 60_000;
/** …and only this many at once, so one plugin cannot hold every socket (and every shell round trip) open. */
const FETCH_IN_FLIGHT_MAX = 4;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const HEADER_VALUE_MAX = 4000;
const HEADERS_MAX = 40;
const FETCH_BODY_MAX = 1024 * 1024;
/** A plugin's settings live in the config the user reads and the state file; they are values, not a database. */
const SETTINGS_MAX = 64 * 1024;
/** Key names that mean something to an object rather than to the plugin storing them. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ADD_URL_TIMEOUT_MS = 15_000;

/**
 * Is the peer on this machine? `/shell/hello` hands out the socket a plugin's site-authenticated
 * fetches go out on, so only a process on this box may claim it — not the LAN, and not a machine
 * that merely looks local. Loopback and nothing else, in every spelling a socket reports it.
 */
export function isLoopbackCaller(address: string): boolean {
  return isLoopbackIp(String(address ?? ''));
}

/** What a plugin is allowed to put on the wire. `ShellLink` decides what it may see coming back. */
export function pluginHeaders(raw: unknown, viaShell: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= HEADERS_MAX) break;
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey).trim().toLowerCase();
    if (!HEADER_NAME_RE.test(key) || REQUEST_HEADER_STRIP.has(key)) continue;
    // Going through the shell, the site's login is the shell's to attach: a plugin must not add its own on top.
    if (viaShell && CREDENTIAL_HEADERS.has(key)) continue;
    const value = String(rawValue).slice(0, HEADER_VALUE_MAX);
    if (/[\r\n\0]/.test(value)) continue; // a value that carries a line break is a second header
    out[key] = value;
  }
  return out;
}

/** A proxied request body is a string and no larger than this; anything else is no body at all. */
export function proxyBody(body: unknown): string | undefined {
  return typeof body === 'string' ? body.slice(0, FETCH_BODY_MAX) : undefined;
}

/** Download a plugin file with a byte budget: `content-length` is a claim, so the bytes are counted as they land. */
async function download(url: string, fetchImpl: typeof fetch, dispatcher: unknown): Promise<string> {
  const res = await fetchImpl(url, {
    redirect: 'manual', // a redirect can leave the host the user typed; make them paste the final URL instead
    signal: AbortSignal.timeout(ADD_URL_TIMEOUT_MS),
    dispatcher,
  } as RequestInit & { dispatcher: unknown });
  if (REDIRECT_STATUS.includes(res.status)) throw new Error('the link redirects; use the final URL');
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_FILE) throw new Error(MAX_FILE_MESSAGE);
    return text;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > MAX_FILE) throw new Error(MAX_FILE_MESSAGE);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `/api/plugins/*` and `/api/shell/hello`. Every plugin-facing route checks the plugin is enabled. */
export function createPluginsApi(
  reg: PluginRegistry,
  state: PluginState,
  hub: MessageHub,
  shell: ShellLink,
  cfg: WatchConfig,
  opts: PluginsApiOptions = {},
): Router {
  const r = Router();
  // Its own parser: createApi's 64kb is too small for a plugin's file (up to 512 KB) or a proxied
  // request body. Scoped to these two namespaces, not the whole router: this router is mounted at
  // /api ahead of createApi (whichever parser runs first wins, and the other skips the body), and
  // the rest of the API must keep its own, smaller limit.
  r.use(['/plugins', '/shell'], json({ limit: '1mb' }));
  const posts = new PostLimiter(POSTS_PER_WINDOW, POST_WINDOW_MS);
  const fetches = new PostLimiter(FETCHES_PER_WINDOW, FETCH_WINDOW_MS);
  const inFlight = new Map<string, number>();
  const fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  let addUrlAgent: unknown;
  // An injected fetch (tests, and anything else standing in for the network) never dials a socket,
  // so it gets no dispatcher and undici's Agent is never built.
  const addUrlDispatcher = () => (opts.fetchImpl ? undefined : (addUrlAgent ??= safeDispatcher()));
  const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  /** The registry says why it refused; the status follows from that, not from the wording. */
  const statusFor = (e: unknown, fallback: number): number => {
    const code = e instanceof RegistryError ? e.code : undefined;
    // 'broken' is 422: the id is real and the request was well formed, but the file behind it will not parse.
    return code === 'unknown' ? 404 : code === 'not-enabled' ? 403 : code === 'changed' ? 409 : code === 'broken' ? 422 : fallback;
  };
  const enabled = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    const p = reg.get(id);
    if (!p) {
      fail(res, 404, 'unknown plugin');
      return null;
    }
    if (!p.enabled) {
      fail(res, 403, 'plugin is not enabled');
      return null;
    }
    return id;
  };
  /** The plugin has to be in the folder, but need not be enabled (reading its settings, say). */
  const loaded = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    if (!reg.get(id)) {
      fail(res, 404, 'unknown plugin');
      return null;
    }
    return id;
  };
  let signedInCache: string[] = [];
  const broadcast = () => hub.emit('event', { type: 'plugins', plugins: reg.list() } satisfies ServerEvent);
  const refreshSignedIn = async (): Promise<void> => {
    try {
      const sites = [...new Set(reg.list().flatMap((p) => p.manifest?.sites ?? []))];
      signedInCache = await shell.signedIn(sites);
      broadcast();
    } catch (e) {
      console.warn('[plugins] sign-in refresh failed', why(e));
    }
  };
  reg.onChange = broadcast;
  reg.signedIn = () => signedInCache;

  r.get('/plugins', (_req, res) => res.json(reg.list()));
  r.get('/plugins/shell', (_req, res) => res.json({ available: shell.available() }));
  r.post('/shell/hello', async (req, res) => {
    // Loopback callers only: this is the socket a plugin's site-authenticated fetches go out on.
    if (!isLoopbackCaller(String(req.socket?.remoteAddress ?? ''))) return fail(res, 403, 'local callers only');
    const port = Number(req.body?.port);
    const token = String(req.body?.token ?? '');
    if (!Number.isInteger(port) || port <= 0 || !token) return fail(res, 400, 'port and token');
    try {
      // hello is async: it probes the shell already registered (if any) before handing the link over,
      // and concurrent hellos queue, so the route waits rather than firing and forgetting.
      await shell.hello(port, token);
    } catch (e) {
      return fail(res, 400, why(e));
    }
    void refreshSignedIn();
    res.json({ ok: true });
  });
  r.post('/plugins/reload', (_req, res) => {
    reg.load();
    res.json(reg.list());
  });
  r.post('/plugins/add', (req, res) => {
    try {
      const source = typeof req.body?.source === 'string' ? req.body.source : '';
      if (!source) return fail(res, 400, 'source');
      res.json(reg.add(source));
    } catch (e) {
      fail(res, 400, why(e));
    }
  });
  r.post('/plugins/add-url', async (req, res) => {
    const url = String(req.body?.url ?? '');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return fail(res, 400, 'an https URL to a .js file');
    }
    if (u.protocol !== 'https:') return fail(res, 400, 'an https URL to a .js file');
    if (isLocalHost(u.hostname)) return fail(res, 400, 'local addresses are off limits');
    try {
      const source = await download(u.toString(), fetchImpl, addUrlDispatcher());
      res.json(reg.add(source));
    } catch (e) {
      fail(res, 400, why(e));
    }
  });
  r.post('/plugins/:id/approve', (req, res) => {
    try {
      reg.approve(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      fail(res, statusFor(e, 400), why(e));
    }
  });
  r.post('/plugins/:id/enable', (req, res) => {
    try {
      reg.enable(String(req.params.id));
      void refreshSignedIn();
      res.json({ ok: true });
    } catch (e) {
      fail(res, statusFor(e, 400), why(e));
    }
  });
  r.post('/plugins/:id/disable', (req, res) => {
    reg.disable(String(req.params.id));
    res.json({ ok: true });
  });
  r.delete('/plugins/:id', (req, res) => {
    const id = String(req.params.id);
    try {
      // Not in the folder any more (deleted by hand, or never loaded): there is nothing to unlink,
      // but its config entry, stored data and watch keys are still ours to clean up.
      if (reg.get(id)) reg.remove(id);
      else reg.forgetOrphan(id);
    } catch (e) {
      return fail(res, 400, why(e));
    }
    posts.forget(id);
    fetches.forget(id);
    cfg.update((c) => {
      c.pluginWatch = c.pluginWatch.filter((k) => !k.startsWith(`plugin:${id}:`));
    });
    res.json({ ok: true });
  });
  r.get('/plugins/:id/code', (req, res) => {
    const id = enabled(req, res);
    if (!id) return;
    let source: string;
    try {
      source = reg.code(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return fail(res, 404, 'the plugin file is gone; reload the plugins folder');
      // 'changed': the file is there but no longer the bytes the user approved, so the UI asks again.
      return fail(res, statusFor(e, 400), why(e));
    }
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(source);
  });
  r.get('/plugins/:id/logs', (req, res) => {
    const id = loaded(req, res);
    if (!id) return;
    res.json(reg.logs(id));
  });
  r.post('/plugins/:id/log', (req, res) => {
    const id = enabled(req, res);
    if (!id) return;
    const level = req.body?.level === 'error' ? 'error' : req.body?.level === 'warn' ? 'warn' : 'info';
    reg.log(id, level, String(req.body?.text ?? ''));
    res.json({ ok: true });
  });

  // ---- feed
  r.post('/plugins/:id/post', (req, res) => {
    // The id is the registry's, from the path; nothing in the body ever names the plugin.
    const id = enabled(req, res);
    if (!id) return;
    const manifest = reg.manifest(id);
    if (!manifest.permissions.includes('feed:write')) return fail(res, 403, 'plugin lacks the feed:write permission');
    if (!posts.take(id)) return fail(res, 429, `too many posts (${POSTS_PER_WINDOW} a minute)`);
    let msg;
    try {
      msg = toFeedMessage(id, manifest, req.body as PluginPost);
    } catch (e) {
      return fail(res, 400, why(e));
    }
    // noteChat first, and inside the try: it enforces the 32-chats-per-plugin cap and throws
    // ('too many chats (32 max)'), which must refuse the post with a 400 before anything reaches the hub.
    try {
      reg.noteChat(id, msg.chatId, msg.chatName);
    } catch (e) {
      return fail(res, 400, why(e));
    }
    cfg.update((c) => {
      if (!c.pluginWatch.includes(msg.chatId)) c.pluginWatch.push(msg.chatId);
    });
    hub.push(msg);
    res.json({ ok: true, id: msg.id });
  });
  r.post('/plugins/:id/patch', (req, res) => {
    // An edit is a post by another name: same permission, same limiter, same cleaning of what it carries.
    const id = enabled(req, res);
    if (!id) return;
    const manifest = reg.manifest(id);
    if (!manifest.permissions.includes('feed:write')) return fail(res, 403, 'plugin lacks the feed:write permission');
    const msgId = String(req.body?.id ?? '');
    if (!msgId.startsWith(`plugin:${id}:`)) return fail(res, 400, "not this plugin's message");
    if (!posts.take(id)) return fail(res, 429, `too many posts (${POSTS_PER_WINDOW} a minute)`);
    const patch: Partial<FeedMessage> = {};
    if (typeof req.body?.text === 'string') patch.text = cleanText(req.body.text);
    if (req.body?.attachments !== undefined) {
      try {
        const media = toMedia(manifest, req.body.attachments);
        // An empty list is an instruction, not a missing field: `undefined` would drop out of the
        // patch on the way to the client and leave the old images on screen.
        patch.media = media;
        patch.hasAttachment = media.length > 0;
      } catch (e) {
        return fail(res, 400, why(e));
      }
    }
    // The hub re-scans edited text for contracts; it does not register a fresh call for one that
    // appears in an edit, so a plugin cannot turn an old message into a new call by editing it.
    hub.patch(msgId, patch);
    res.json({ ok: true });
  });
  r.put('/plugins/watch', (req, res) => {
    const key = String(req.body?.key ?? '');
    if (!/^plugin:[a-z0-9-]+:[a-z0-9-]+$/.test(key)) return fail(res, 400, 'key');
    // Switching one on needs a chat a plugin has actually posted: the watch list is what the pickers
    // and columns read, and a key with nothing behind it is a row no one can name. Switching off is
    // always allowed — that is how a leftover key gets cleared.
    if (req.body?.on && !reg.list().some((p) => key in p.chats)) return fail(res, 400, 'no plugin has posted that chat');
    cfg.update((c) => {
      c.pluginWatch = c.pluginWatch.filter((k) => k !== key);
      if (req.body?.on) c.pluginWatch.push(key);
    });
    res.json({ ok: true });
  });

  // ---- storage and settings
  r.get('/plugins/:id/storage', (req, res) => {
    const id = enabled(req, res);
    if (!id) return;
    if (!reg.manifest(id).permissions.includes('storage')) return fail(res, 403, 'plugin lacks the storage permission');
    res.json(state.read(id).storage);
  });
  r.put('/plugins/:id/storage/:key', (req, res) => {
    const id = enabled(req, res);
    if (!id) return;
    if (!reg.manifest(id).permissions.includes('storage')) return fail(res, 403, 'plugin lacks the storage permission');
    const key = String(req.params.key).slice(0, 100);
    if (!key || PROTOTYPE_KEYS.has(key)) return fail(res, 400, 'that key name is not allowed');
    try {
      state.setStorage(id, key, req.body?.value);
      res.json({ ok: true });
    } catch (e) {
      fail(res, 400, why(e));
    }
  });
  r.get('/plugins/:id/settings', (req, res) => {
    const id = loaded(req, res);
    if (!id) return;
    res.json(state.read(id).settings);
  });
  r.put('/plugins/:id/settings', (req, res) => {
    // Settings are the user's answers to the plugin's schema, and filling in a key is often what one
    // does *before* enabling it — so this needs a plugin we have, not an enabled one.
    const id = loaded(req, res);
    if (!id) return;
    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return fail(res, 400, 'values');
    if (Buffer.byteLength(JSON.stringify(values)) > SETTINGS_MAX) return fail(res, 400, `settings are too large (${SETTINGS_MAX / 1024} KB max)`);
    state.setSettings(id, values);
    res.json({ ok: true });
  });

  // ---- network
  r.post('/plugins/:id/fetch', async (req, res) => {
    const id = enabled(req, res);
    if (!id) return;
    const url = String(req.body?.url ?? '');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return fail(res, 400, 'url');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail(res, 400, 'only http(s) URLs');
    if (isLocalHost(u.hostname)) return fail(res, 400, 'local addresses are off limits'); // the same rule the fetch path enforces
    const init = req.body?.init ?? {};
    const method = METHODS.includes(String(init.method).toUpperCase()) ? String(init.method).toUpperCase() : 'GET';
    const viaShell = reg.manifest(id).sites.includes(u.origin);
    // The site's cookies live in the shell, and a fetch the plugin asked to make *as the signed-in
    // user* is a different request without them: never quietly send it plain instead.
    if (viaShell && !shell.available()) return fail(res, 503, 'the desktop app is not connected');
    const headers = pluginHeaders(init.headers, viaShell);
    const body = proxyBody(init.body);
    // The concurrency check comes first: a request refused for arriving while four others are still
    // out has not been sent, so it must not spend the plugin's minute either.
    const open = inFlight.get(id) ?? 0;
    if (open >= FETCH_IN_FLIGHT_MAX) return fail(res, 429, `too many fetches at once (${FETCH_IN_FLIGHT_MAX} at a time)`);
    if (!fetches.take(id)) return fail(res, 429, `too many fetches (${FETCHES_PER_WINDOW} a minute)`);
    inFlight.set(id, open + 1);
    try {
      res.json(await shell.fetch(u.toString(), { method, headers, body }, viaShell));
    } catch (e) {
      fail(res, 502, why(e));
    } finally {
      const left = (inFlight.get(id) ?? 1) - 1;
      if (left > 0) inFlight.set(id, left);
      else inFlight.delete(id);
    }
  });
  r.get('/plugins/:id/sites', async (req, res) => {
    const id = String(req.params.id);
    let sites: string[];
    try {
      sites = reg.manifest(id).sites;
    } catch (e) {
      return fail(res, 404, why(e));
    }
    res.json({ sites, signedIn: await shell.signedIn(sites), available: shell.available() });
  });
  r.post('/plugins/:id/sites/signin', async (req, res) => {
    // Opening a sign-in window is the plugin acting on the user's behalf: only an enabled one may.
    const id = enabled(req, res);
    if (!id) return;
    const site = String(req.body?.site ?? '');
    const sites = reg.manifest(id).sites;
    if (!sites.includes(site)) return fail(res, 400, "not one of this plugin's sites");
    try {
      await shell.signIn(site);
      // The window the shell opens is the user's to finish; look again once they plausibly have.
      setTimeout(() => void refreshSignedIn(), 15_000).unref();
      res.json({ ok: true });
    } catch (e) {
      fail(res, 400, why(e));
    }
  });
  // Last in the stack, so a body the parser refused (too large, not json) and anything a route threw
  // answer the way every other refusal here does: a JSON message, no HTML page, no stack.
  r.use(jsonErrors('[plugins]'));
  return r;
}
