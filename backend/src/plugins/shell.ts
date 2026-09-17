import { lookup as dnsLookup } from 'node:dns';
import { Agent, type Dispatcher } from 'undici';
import { isLocalHost, isLocalIp } from './hosts.js';

/** A proxied response as plugins see it. Bodies are text; binary sites are out of scope for v1. */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The body hit BODY_MAX and what the plugin gets is the front of it. */
  truncated: boolean;
}

export interface ProxyInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const BODY_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_HEADERS = 50;
const MAX_HEADER_LENGTH = 8 * 1024;
/** Consecutive unanswered calls before we treat the registered shell as gone and let a new one in. */
const MAX_FAILURES = 3;
const REDIRECT_STATUS = [301, 302, 303, 307, 308];

/**
 * What a plugin is allowed to learn from a response. An allow-list rather than a deny-list: a header we
 * have not thought about is more likely to carry something the plugin has no business with (a session,
 * an internal hostname, a debug trace) than something it needs.
 */
const RESPONSE_HEADER_ALLOW = new Set([
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'location',
  'cache-control',
  'date',
]);

/** Hop-by-hop headers and the ones the fetch layer owns; a plugin naming these is either confused or probing. */
const REQUEST_HEADER_STRIP = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'keep-alive',
  'cookie',
]);

/** Sent to the origin that was asked for, and to no other. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization']);

function isAllowedResponseHeader(key: string): boolean {
  // set-cookie is named even though the allow-list already excludes it: this is the line that must never move.
  if (key === 'set-cookie' || key === 'set-cookie2') return false;
  return RESPONSE_HEADER_ALLOW.has(key) || key.startsWith('x-ratelimit-');
}

function clean(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, MAX_HEADER_LENGTH);
}

/**
 * The single gate response headers pass through, whether they came off the wire here or out of the
 * shell's reply. Keys are lower-cased, cookies are dropped, everything unlisted is dropped, and the
 * count is capped so a hostile server cannot bury a plugin (or our logs) in headers.
 */
export function safeResponseHeaders(input: Headers | Record<string, unknown> | unknown): Record<string, string> {
  const entries: [unknown, unknown][] =
    input instanceof Headers
      ? [...input.entries()]
      : input && typeof input === 'object'
        ? Object.entries(input as Record<string, unknown>)
        : [];
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey ?? '').trim().toLowerCase();
    if (!key || !isAllowedResponseHeader(key)) continue;
    out[key] = clean(rawValue);
  }
  return out;
}

/** What we are willing to put on the wire on a plugin's behalf. `keepCredentials` goes false once a redirect leaves the origin the plugin asked for. */
function safeRequestHeaders(headers: Record<string, string> | undefined, keepCredentials: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey ?? '').trim().toLowerCase();
    if (!key || REQUEST_HEADER_STRIP.has(key)) continue;
    if (!keepCredentials && CREDENTIAL_HEADERS.has(key)) continue;
    out[key] = clean(rawValue);
  }
  return out;
}

function withoutHeader(headers: Record<string, string> | undefined, name: string): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.trim().toLowerCase() !== name));
}

const encoder = new TextEncoder();

function capText(text: string): { body: string; truncated: boolean; bytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= BODY_MAX) return { body: text, truncated: false, bytes: bytes.length };
  return { body: new TextDecoder().decode(bytes.subarray(0, BODY_MAX)), truncated: true, bytes: BODY_MAX };
}

/**
 * Read a body with a byte budget. We count bytes as they arrive and cancel the stream the moment we pass
 * BODY_MAX, so a server that answers with a hundred megabytes costs us four and then stops — `content-length`
 * is a claim, not a limit, and this path must hold whether the server declares a length or lies about it.
 */
async function readCapped(res: Response): Promise<{ body: string; truncated: boolean; bytes: number }> {
  if (!res.body) return capText(await res.text());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (total + value.length > BODY_MAX) {
        chunks.push(value.subarray(0, BODY_MAX - total));
        total = BODY_MAX;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return { body: new TextDecoder().decode(joined), truncated, bytes: total };
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
export type LookupResolver = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * The name check happens before we connect; this is the check that happens *as* we connect. A name the
 * plugin is allowed to fetch can still answer 127.0.0.1 — or answer honestly for our check and locally for
 * the socket a moment later (DNS rebinding). So we resolve once, refuse every local answer, and hand the
 * resolved addresses straight to the connection: what we validated is what gets dialled.
 */
export function makeSafeLookup(resolve: LookupResolver = dnsLookup as unknown as LookupResolver) {
  return (hostname: string, options: { all?: boolean; family?: number; hints?: number } | undefined, callback: LookupCallback): void => {
    resolve(hostname, { all: true, family: options?.family, hints: options?.hints }, (err, addresses) => {
      if (err) return callback(err);
      const found = (addresses ?? []).filter((a) => a && typeof a.address === 'string');
      if (found.length === 0) return callback(new Error(`could not resolve ${hostname}`));
      const local = found.find((a) => isLocalIp(a.address));
      if (local) return callback(new Error(`fetch must not point at a local address (${hostname} resolves to ${local.address})`));
      if (options?.all) return callback(null, found);
      callback(null, found[0].address, found[0].family);
    });
  };
}

/** A dispatcher whose connections are pinned to addresses `makeSafeLookup` has cleared. Task 6's add-url uses this too. */
export function safeDispatcher(lookup = makeSafeLookup()): Dispatcher {
  return new Agent({ connect: { lookup: lookup as never }, connectTimeout: TIMEOUT_MS });
}

type FetchInit = RequestInit & { dispatcher?: unknown };

/**
 * The desktop shell registers a local callback (`hello`) when it starts or attaches. Site-authenticated
 * fetches and sign-in windows go there, so cookies never leave the shell's session partitions. Without a
 * shell (a checkout running the backend on its own) fetches go out plain and sign-in is unavailable.
 *
 * Trust: `hello` is first-come while the registered shell keeps answering — a second one is ignored until
 * the first has missed MAX_FAILURES calls in a row (or called `goodbye`), so a late arrival cannot take
 * over a live shell's fetches. The route that carries `hello` must accept it only from a loopback caller
 * (Task 6). A hostile process already on this machine is outside the threat model: it can read the
 * backend's config.json and impersonate whatever it likes regardless of what this class does.
 */
export class ShellLink {
  private port: number | null = null;
  private token = '';
  private failures = 0;
  private dispatcher: unknown;

  constructor(
    private fetchImpl: typeof fetch = fetch,
    dispatcher?: unknown,
  ) {
    this.dispatcher = dispatcher;
  }

  /** Register the shell's callback. Ignored while a registered shell is still answering. */
  hello(port: number, token: string): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('hello needs a port');
    if (!token) throw new Error('hello needs a token');
    if (this.available()) return; // the shell that got here first keeps the link until it stops answering
    this.port = port;
    this.token = token;
    this.failures = 0;
  }

  /** The shell is going away (quit, or handing over). Fetches fall back to plain and sign-in stops being offered. */
  goodbye(): void {
    this.port = null;
    this.token = '';
    this.failures = 0;
  }

  available(): boolean {
    return this.port !== null;
  }

  private agent(): unknown {
    return (this.dispatcher ??= safeDispatcher());
  }

  private noteFailure(): void {
    if (++this.failures >= MAX_FAILURES) this.goodbye(); // stopped answering: let the next shell register
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    const port = this.port;
    if (port === null) throw new Error(`shell ${path}: no shell is registered`);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`shell unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new Error(`shell ${path} ${res.status}`);
      const { body: text, truncated } = await readCapped(res);
      if (truncated) throw new Error(`shell ${path} sent a reply over the size cap`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`shell ${path} sent a reply that is not json`);
      }
      this.failures = 0;
      return parsed;
    } catch (err) {
      this.noteFailure();
      throw err;
    }
  }

  /** Which of `sites` have a session in the shell right now. */
  async signedIn(sites: string[]): Promise<string[]> {
    if (!this.available() || sites.length === 0) return [];
    try {
      const answer = (await this.call('/status', { sites })) as { signedIn?: unknown };
      const listed: unknown[] = Array.isArray(answer?.signedIn) ? answer.signedIn : [];
      return sites.filter((site) => listed.includes(site));
    } catch {
      return []; // a shell that has gone away just means no sessions
    }
  }

  async signIn(site: string): Promise<void> {
    if (!this.available()) {
      throw new Error('signing in to a site needs the desktop app (the backend is running on its own)');
    }
    await this.call('/signin', { site });
  }

  /**
   * `viaShell`: the host is one of the plugin's sites and the shell is there → the shell fetches with that
   * site's cookies, and we shape its answer the same way we shape our own. Plain fetches follow redirects by
   * hand (max 5) so every hop is re-checked: http(s) only, no downgrade to http, never a local address, and
   * credentials dropped the moment the chain leaves the origin the plugin asked for. Bodies are capped at
   * BODY_MAX, and the whole chain shares one timeout.
   */
  async fetch(url: string, init: ProxyInit, viaShell: boolean): Promise<ProxyResponse> {
    if (viaShell && this.available()) {
      return shapeShellResponse(await this.call('/fetch', { url, init }));
    }
    const signal = AbortSignal.timeout(TIMEOUT_MS); // one budget for the chain, not one per hop
    let current = url;
    let cur: ProxyInit = init;
    let keepCredentials = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const at = new URL(current);
      if (at.protocol !== 'http:' && at.protocol !== 'https:') {
        throw new Error(`fetch speaks http and https only, not ${at.protocol}`);
      }
      if (isLocalHost(at.hostname)) throw new Error('fetch must not point at a local address');
      const res = await this.fetchImpl(current, {
        method: cur.method ?? 'GET',
        headers: safeRequestHeaders(cur.headers, keepCredentials),
        body: cur.body,
        signal,
        redirect: 'manual',
        dispatcher: this.agent(), // resolves and pins the address before the socket opens
      } as FetchInit);
      const location = res.headers.get('location');
      if (REDIRECT_STATUS.includes(res.status) && location) {
        if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
        const next = new URL(location, current);
        // named here as well as at the top of the loop so the refusal says which rule the hop broke
        if (isLocalHost(next.hostname)) throw new Error('fetch must not point at a local address');
        if (at.protocol === 'https:' && next.protocol === 'http:') {
          throw new Error('insecure redirect: https must not hand off to http');
        }
        if (next.origin !== at.origin) keepCredentials = false; // a new origin never inherits the old one's login
        const method = (cur.method ?? 'GET').toUpperCase();
        // 303, and 301/302 on POST, become GET; the body goes, and its content-type goes with it
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          cur = { ...cur, method: 'GET', body: undefined, headers: withoutHeader(cur.headers, 'content-type') };
        }
        current = next.toString();
        continue;
      }
      const { body, truncated, bytes } = await readCapped(res);
      const headers = safeResponseHeaders(res.headers);
      headers['content-length'] = String(bytes); // what we actually hand over, not what the server claimed
      return { status: res.status, headers, body, truncated };
    }
    // Unreachable: the loop returns on a non-redirect and throws at hop === MAX_REDIRECTS. Here for the type.
    throw new Error('too many redirects');
  }
}

/** The shell is a separate process that can be upgraded independently, so its reply is checked, not trusted. */
function shapeShellResponse(reply: unknown): ProxyResponse {
  const r = (reply ?? {}) as { status?: unknown; headers?: unknown; body?: unknown };
  const status = Number(r.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`shell /fetch answered with a bad status: ${String(r.status)}`);
  }
  if (r.body !== null && r.body !== undefined && typeof r.body !== 'string') {
    throw new Error('shell /fetch answered with a body that is not text');
  }
  const { body, truncated, bytes } = capText(typeof r.body === 'string' ? r.body : '');
  const headers = safeResponseHeaders(r.headers);
  headers['content-length'] = String(bytes);
  return { status, headers, body, truncated };
}
