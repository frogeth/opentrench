import type { api as Api } from '../api';
import type { FeedMessage, PluginInfo, TokenInfo } from '../types';

export type Manifest = NonNullable<PluginInfo['manifest']>;

/** One field of a plugin's settings form, as the plugin declares it through `ot.settings.schema`. */
export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'secret';
  default?: unknown;
}

export interface PluginCall {
  method: string;
  args: unknown[];
}

export interface PluginContext {
  id: string;
  manifest: Manifest;
  api: typeof Api;
  actions: {
    openToken: (a: string) => void;
    jump: (msgId: string) => void;
    buy: (a: string) => void;
    research: (a: string) => void;
    copy: (t: string) => void;
    notify: (title: string, body: string) => void;
  };
  snapshot: { messages: () => FeedMessage[]; tokens: () => Record<string, TokenInfo> };
  ui: {
    setTitle: (t: string) => void;
    setSubtitle: (t: string) => void;
    badge: (n: number | null) => void;
    /** the settings form the plugin declared; the host keeps it, the backend never sees it */
    setSchema: (s: SettingField[]) => void;
  };
}

const need = (ctx: PluginContext, p: Manifest['permissions'][number]) => {
  if (!ctx.manifest.permissions.includes(p)) throw new Error(`this plugin did not ask for the ${p} permission`);
};

const str = (v: unknown, what: string, max = 4000): string => {
  if (typeof v !== 'string' || !v) throw new Error(`${what} must be a non-empty string`);
  return v.slice(0, max);
};

/** `str` where the empty string is a value of its own — clearing a title rather than an error. */
const strOrEmpty = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string') throw new Error(`${what} must be a string`);
  return v.slice(0, max);
};

/** Look a plugin's key up as data: `constructor` and `__proto__` are misses, not inherited members. */
const own = <T>(obj: Record<string, T>, key: string): T | null => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);

const FIELD_TYPES = ['text', 'number', 'toggle', 'secret'];
const KEY_RE = /^[a-z0-9_-]{1,40}$/i;
/** keys that would reach through a plain settings object instead of sitting in it */
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/** A settings form is small, flat and declared in full: anything else is refused rather than half-shown. */
const settingsSchema = (v: unknown): SettingField[] => {
  if (!Array.isArray(v) || v.length > 20) throw new Error('the settings schema must be an array of at most 20 fields');
  const seen = new Set<string>();
  return v.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) throw new Error(`settings field key ${JSON.stringify(f.key)} must be 1-40 letters, digits, _ or -`);
    if (RESERVED_KEYS.includes(f.key.toLowerCase())) throw new Error(`settings field key ${f.key} is reserved`);
    if (seen.has(f.key)) throw new Error(`settings field key ${f.key} appears twice`);
    seen.add(f.key);
    if (typeof f.label !== 'string' || !f.label || f.label.length > 60) throw new Error(`settings field ${f.key} needs a label of at most 60 characters`);
    if (typeof f.type !== 'string' || !FIELD_TYPES.includes(f.type)) throw new Error(`settings field ${f.key} has an unknown type; use ${FIELD_TYPES.join(', ')}`);
    const field: SettingField = { key: f.key, label: f.label, type: f.type as SettingField['type'] };
    if ('default' in f) field.default = f.default;
    return field;
  });
};

/** Only what the proxy takes, and only as strings: a plugin cannot smuggle a Request, a stream or credentials through. */
const fetchInit = (v: unknown): { method?: string; headers?: Record<string, string>; body?: string } => {
  const o = (v ?? {}) as Record<string, unknown>;
  const init: { method?: string; headers?: Record<string, string>; body?: string } = {};
  if (typeof o.method === 'string') init.method = o.method.slice(0, 20);
  if (o.headers && typeof o.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(o.headers as Record<string, unknown>)) if (typeof val === 'string') headers[k] = val;
    init.headers = headers;
  }
  if (typeof o.body === 'string') init.body = o.body;
  return init;
};

/** One bridge call from a plugin → one app-side effect. Pure apart from what it calls on `ctx`; permissions live here and nowhere else. */
export async function routeCall(ctx: PluginContext, call: PluginCall): Promise<unknown> {
  const [a0, a1] = call.args ?? [];
  switch (call.method) {
    // newest first, as the feed itself is ordered; messages the feed hides (blacklisted authors, bots the
    // bot policy refuses) are not the plugin's to read, so they never appear here
    case 'feed.messages': {
      const o = (a0 ?? {}) as { chat?: string; limit?: number };
      let list = ctx.snapshot.messages().filter((m) => !m.hidden);
      if (o.chat) list = list.filter((m) => m.chatName === o.chat || m.chatId === o.chat);
      return list.slice(0, Math.min(500, Math.max(1, Number(o.limit) || 100)));
    }
    case 'feed.tokens':
      return Object.values(ctx.snapshot.tokens()).slice(0, 2000);
    case 'feed.token':
      return own(ctx.snapshot.tokens(), str(a0, 'address', 120));
    case 'feed.post':
      need(ctx, 'feed:write');
      return ctx.api.pluginPost(ctx.id, a0);
    case 'feed.patch':
      need(ctx, 'feed:write');
      return ctx.api.pluginPatch(ctx.id, str(a0, 'id', 200), a1 ?? {});
    case 'fetch':
      return ctx.api.pluginFetch(ctx.id, str(a0, 'url', 2048), fetchInit(a1));
    case 'sites.status': {
      const site = str(a0, 'site', 200);
      const s = await ctx.api.pluginSites(ctx.id);
      return { signedIn: s.signedIn.includes(site), available: s.available };
    }
    case 'sites.signIn':
      return ctx.api.pluginSignIn(ctx.id, str(a0, 'site', 200));
    case 'storage.get':
      need(ctx, 'storage');
      return own(await ctx.api.pluginStorage(ctx.id), str(a0, 'key', 100));
    case 'storage.set':
      need(ctx, 'storage');
      return ctx.api.pluginStorageSet(ctx.id, str(a0, 'key', 100), a1);
    case 'storage.remove':
      need(ctx, 'storage');
      return ctx.api.pluginStorageSet(ctx.id, str(a0, 'key', 100), undefined);
    case 'settings.schema':
      ctx.ui.setSchema(settingsSchema(a0));
      return null;
    case 'settings.get':
      return ctx.api.pluginSettings(ctx.id);
    case 'ui.setTitle':
      ctx.ui.setTitle(strOrEmpty(a0, 'title', 60));
      return null;
    case 'ui.setSubtitle':
      ctx.ui.setSubtitle(typeof a0 === 'string' ? a0.slice(0, 120) : '');
      return null;
    case 'ui.badge':
      ctx.ui.badge(a0 === null || a0 === undefined ? null : Math.min(9999, Math.max(0, Math.trunc(Number(a0)) || 0)));
      return null;
    case 'actions.openToken':
      need(ctx, 'actions');
      ctx.actions.openToken(str(a0, 'address', 120));
      return null;
    case 'actions.jump':
      need(ctx, 'actions');
      ctx.actions.jump(str(a0, 'messageId', 200));
      return null;
    // `buy` and `research` never act: they are "ask the user" hooks. The host raises a confirmation bar
    // naming the plugin and the address, and only the user's own click sends anything to a bot.
    case 'actions.buy':
      need(ctx, 'actions');
      ctx.actions.buy(str(a0, 'address', 120));
      return null;
    case 'actions.research':
      need(ctx, 'actions');
      ctx.actions.research(str(a0, 'address', 120));
      return null;
    // allowed, but the host toasts who did it — a silent clipboard write is how an address gets swapped
    case 'actions.copy':
      need(ctx, 'actions');
      ctx.actions.copy(str(a0, 'text', 10_000));
      return null;
    // the plugin's name leads the title: a notification cannot be dressed up as the app's own
    case 'actions.notify':
      need(ctx, 'actions');
      ctx.actions.notify(`[${ctx.manifest.name}] ${str(a0, 'title', 120)}`, typeof a1 === 'string' ? a1.slice(0, 400) : '');
      return null;
    case 'log':
      ctx.api
        .pluginLog(
          ctx.id,
          a0 === 'warn' || a0 === 'error' ? a0 : 'info',
          (call.args ?? []).slice(1).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '),
        )
        .catch(() => {});
      return null;
    default:
      throw new Error(`unknown method ${call.method}`);
  }
}
