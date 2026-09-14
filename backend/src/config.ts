import fs from 'node:fs';
import { SecretBox, isSealed } from './secrets.js';
import path from 'node:path';
import type { BotPolicy } from './types.js';

/** One column of the terminal. `chats` are `<source>:<id>` keys of watched chats; empty = every watched chat. */
export interface ColumnDef {
  id: string;
  type: 'calls' | 'chat' | 'callers' | 'trending' | 'cove' | 'salpha' | 'j7' | 'web' | 'mints' | 'nftvol' | 'osmint' | 'tgbot';
  title: string;
  chats: string[];
  /** web columns: the page to embed (http/https only) */
  url?: string;
  /** tgbot columns: the bot's username (no @) whose conversation this column shows */
  bot?: string;
  /** nftvol: which OpenSea list, and which rolling window */
  ranking?: 'trending' | 'top';
  timeframe?: '1h' | '1d';
  /** a second column stacked under this one (one level only), sharing its width */
  split?: { bottom: ColumnDef; ratio?: number };
  /** fixed width in px (drag-resized); unset = share the space */
  width?: number;
  /** callers leaderboard window (24h/7d/30d) or trending window (5m/1h/6h/24h) */
  window?: '5m' | '1h' | '6h' | '24h' | '7d' | '30d';
  /** content scale for this column only (ctrl/⌘ + wheel), 0.5–1.5; unset = 1 */
  zoom?: number;
  /** play a sound when a new call lands in this column */
  alert?: { on: boolean; sound: string };
  /** per-column filters (shape owned by the UI; values are strings, numbers, booleans or string arrays) */
  filters?: Record<string, string | number | boolean | string[]>;
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'calls', type: 'calls', title: 'All Calls', chats: [] },
  { id: 'chats', type: 'chat', title: 'All Chats', chats: [] },
];

const TYPES = ['calls', 'callers', 'trending', 'cove', 'salpha', 'j7', 'web', 'chat', 'mints', 'nftvol', 'osmint', 'tgbot'] as const;
const DEFAULT_TITLE: Record<ColumnDef['type'], string> = {
  calls: 'Calls',
  callers: 'Top Callers',
  trending: 'Trending',
  cove: 'Cove',
  salpha: 'Salpha',
  j7: 'J7',
  web: 'Web',
  chat: 'Chats',
  mints: 'MintGo',
  nftvol: 'OpenSea Volume',
  osmint: 'OpenSea Mint',
  tgbot: 'Telegram bot',
};
export const MINT_CHAINS = ['ethereum', 'robinhood', 'ink'] as const;

/** One column definition from untrusted input; `allowSplit` is false for a stacked bottom (one level only). */
function parseColumn(r: unknown, seen: Set<string>, allowSplit: boolean): ColumnDef | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const raw = r as any;
  const id = String(raw.id ?? '').trim().slice(0, 40);
  const type: ColumnDef['type'] = (TYPES as readonly string[]).includes(raw.type) ? raw.type : 'chat';
  const title = String(raw.title ?? '').trim().slice(0, 40) || DEFAULT_TITLE[type];
  // empty = every watched chat; the 'none' sentinel = nothing selected (a column being set up)
  const chats = Array.isArray(raw.chats) ? raw.chats.map(String).filter((k: string) => /^(discord|telegram):/.test(k) || k === 'none').slice(0, 200) : [];
  if (!id || seen.has(id)) return undefined;
  seen.add(id);
  const col: ColumnDef = { id, type, title, chats };
  const w = Number(raw.width);
  if (Number.isFinite(w) && w >= 320 && w <= 1600) col.width = Math.round(w);
  if (['5m', '1h', '6h', '24h', '7d', '30d'].includes(raw.window)) col.window = raw.window;
  // per-column zoom (ctrl/⌘ + wheel over the column), 50%–150%; 1 = default and is not stored
  const z = Number(raw.zoom);
  if (Number.isFinite(z) && z >= 0.5 && z <= 1.5 && Math.round(z * 100) !== 100) col.zoom = Math.round(z * 100) / 100;
  const al = raw.alert;
  if (al && typeof al === 'object') col.alert = { on: !!al.on, sound: String(al.sound ?? 'ping').slice(0, 20) || 'ping' };
  if (type === 'web') {
    const u = String(raw.url ?? '').trim().slice(0, 2000);
    if (/^https?:\/\//i.test(u)) col.url = u;
  }
  if (type === 'tgbot') {
    const b = String(raw.bot ?? '').trim().replace(/^@/, '');
    if (/^[A-Za-z0-9_]{3,32}$/.test(b)) col.bot = b;
  }
  if (type === 'nftvol') {
    col.ranking = raw.ranking === 'top' ? 'top' : 'trending';
    col.timeframe = raw.timeframe === '1d' ? '1d' : '1h';
  }
  const f = raw.filters;
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const out: NonNullable<ColumnDef['filters']> = {};
    for (const [k, v] of Object.entries(f).slice(0, 60)) {
      if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) continue;
      if (typeof v === 'string') out[k] = v.slice(0, 200);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.map(String).map((x) => x.slice(0, 80)).slice(0, 300);
    }
    if (type === 'mints') {
      if (Array.isArray(out.chains)) {
        out.chains = (out.chains as string[]).filter((c) => (MINT_CHAINS as readonly string[]).includes(c));
        if (out.chains.length === 0) delete out.chains;
      } else delete out.chains;
      if (typeof out.minQty === 'number') {
        out.minQty = Math.round(out.minQty);
        if (out.minQty < 1 || out.minQty > 1000) delete out.minQty;
      }
    } else {
      delete out.minQty;
      // chains is also a valid token-network filter for calls/chat columns; only the others lose it
      if (type !== 'calls' && type !== 'chat') delete out.chains;
    }
    if (Object.keys(out).length) col.filters = out;
  }
  if (allowSplit && raw.split && typeof raw.split === 'object') {
    const bottom = parseColumn(raw.split.bottom, seen, false);
    if (bottom) {
      const ratio = Number(raw.split.ratio);
      col.split = { bottom, ...(Number.isFinite(ratio) ? { ratio: Math.min(0.8, Math.max(0.2, ratio)) } : {}) };
    }
  }
  return col;
}

/** A saved arrangement of the column terminal. Columns carry their own channel scope, splits, widths and filters. */
export interface Layout {
  id: string;
  name: string;
  columns: ColumnDef[];
}
export const MAX_LAYOUTS = 12;
export const LAYOUT_NAME_MAX = 30;

export function sanitizeLayouts(raw: unknown): Layout[] {
  if (!Array.isArray(raw)) return [];
  const out: Layout[] = [];
  const ids = new Set<string>();
  for (const r of raw.slice(0, MAX_LAYOUTS)) {
    if (!r || typeof r !== 'object') continue;
    const id = String((r as any).id ?? '').trim().slice(0, 40);
    const name = String((r as any).name ?? '').trim().slice(0, LAYOUT_NAME_MAX);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    out.push({ id, name, columns: sanitizeColumns((r as any).columns) });
  }
  return out;
}

export function sanitizeColumns(raw: unknown): ColumnDef[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  const out: ColumnDef[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 8)) {
    const col = parseColumn(r, seen, true);
    if (col) out.push(col);
  }
  // an explicitly empty list is a choice (every column removed to start a layout from scratch), not a fallback
  return out;
}

export interface Config {
  /** `send`: the user explicitly enabled composing messages from the app (Discord: after the ToS warning) */
  /** Discord: the Vencord bridge needs nothing stored; a legacy user token gives read-only access without the plugin */
  discord: { token?: string; watch: string[]; send?: boolean };
  telegram: { apiId?: number; apiHash?: string; session?: string; watch: string[]; send?: boolean };
  /** Cove one-click amounts (the affiliate is opentrench's own, fixed in code) */
  cove: { amounts: number[] };
  /** which bot the buy buttons and right-click → Buy use */
  buy: { provider: 'cove' | 'basedbot' };
  /** caller names (case-insensitive, leading @ ignored) whose posts never count as calls */
  blacklist: string[];
  /** bots: hide everything except `allow`, or show everything except the blacklist */
  bots: BotPolicy;
  /** callers whose first-time calls ping you */
  favorites: string[];
  /** send pings to your own Telegram "Saved Messages" */
  pingTelegram: boolean;
  /** optional o1.exchange launchpad API key (keys start with o1_launch_) */
  o1ApiKey?: string;
  /** user-arranged order of rail items: g:<guildId> and t:<chatId> */
  railOrder: string[];
  /** the column terminal: what each column shows, in order */
  columns: ColumnDef[];
  /** named snapshots of the column terminal, switched from the header's Layouts menu */
  layouts: Layout[];
  /** call cards the user has marked as seen (inbox style); newest last, capped */
  seenTokens: string[];
  /** call cards hidden from the calls columns; the token keeps being tracked (calls, trending, callers) */
  hiddenTokens: string[];
  /** J7Tracker: the account's session id (from its web app), read-only tweet stream */
  j7: { token?: string; /** X handles (no @) whose tweets ping you */ favorites: string[] };
  /** OpenSea mint window: one wallet key (0x + 64 hex) and RPC overrides by OpenSea chain identifier.
   * RPC overrides must be https (or http to localhost/127.0.0.1/[::1]): a plaintext RPC over the
   * network can be tampered with in transit — a quoted balance/fee can be lied about, and a
   * broadcast transaction can be silently dropped. */
  opensea: { walletKey?: string; rpc: Record<string, string> };
  /** TrenchTogether: share my calls on the LAN (token = the pairing secret), and the friends I follow */
  together: { share: boolean; name: string; token: string; peers: { host: string; port: number; token: string; name: string }[] };
}

const DEFAULT: Config = {
  discord: { watch: [] },
  telegram: { watch: [] },
  cove: { amounts: [25, 50, 100] },
  buy: { provider: 'cove' },
  blacklist: [],
  bots: { default: 'hide', allow: [] },
  favorites: [],
  pingTelegram: true,
  railOrder: [],
  columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
  layouts: [],
  seenTokens: [],
  hiddenTokens: [],
  j7: { favorites: [] },
  opensea: { rpc: {} },
  together: { share: false, name: '', token: '', peers: [] },
};

/** The fields that are sealed on disk when a key is available (see secrets.ts). */
type SecretPath = 'discord.token' | 'telegram.apiHash' | 'telegram.session' | 'o1ApiKey' | 'j7.token' | 'opensea.walletKey';

export class ConfigStore {
  private cfg: Config;
  /** Sealed values this backend has no key for: kept verbatim on disk so the desktop app still finds them. */
  private locked: Partial<Record<SecretPath, string>> = {};

  constructor(
    private file: string,
    private box: SecretBox = new SecretBox(),
  ) {
    this.cfg = this.load();
    if (this.plainOnDisk) {
      // a file from before sealing (or written by a keyless dev backend): seal it now, not on the next edit
      this.save();
      this.plainOnDisk = false;
    }
    const n = Object.keys(this.locked).length;
    if (n) console.warn(`[config] ${n} secret(s) in ${this.file} are sealed with a key this backend was not given; they stay on disk but are unavailable`);
  }
  private plainOnDisk = false;

  /**
   * A secret as read from disk: plain text (legacy, migrated on the next save), sealed and opened,
   * or sealed by a key this backend lacks (kept aside in `locked`, absent from the config).
   */
  private secret(v: unknown, at: SecretPath): string | undefined {
    if (isSealed(v)) {
      const open = this.box.open(v);
      if (open === undefined) this.locked[at] = v;
      return open;
    }
    if (typeof v !== 'string' || !v.trim()) return undefined;
    if (this.box.hasKey) this.plainOnDisk = true;
    return v.trim();
  }

  get(): Config {
    return this.cfg;
  }

  update(fn: (c: Config) => void): void {
    fn(this.cfg);
    this.save();
  }

  /** Tokens/sessions replaced with booleans, safe to send to the UI. */
  masked() {
    return {
      discord: { hasToken: !!this.cfg.discord.token, watch: this.cfg.discord.watch, canSend: !!this.cfg.discord.send },
      telegram: {
        apiId: this.cfg.telegram.apiId ?? null,
        hasApiHash: !!this.cfg.telegram.apiHash,
        hasSession: !!this.cfg.telegram.session,
        watch: this.cfg.telegram.watch,
        canSend: !!this.cfg.telegram.send,
      },
      cove: { amounts: this.cfg.cove.amounts },
      buy: { provider: this.cfg.buy.provider },
      blacklist: this.cfg.blacklist,
      bots: this.cfg.bots,
      favorites: this.cfg.favorites,
      pingTelegram: this.cfg.pingTelegram,
      hasO1Key: !!this.cfg.o1ApiKey,
      railOrder: this.cfg.railOrder,
      columns: this.cfg.columns,
      layouts: this.cfg.layouts,
      j7: { hasToken: !!this.cfg.j7.token, favorites: this.cfg.j7.favorites },
      seenTokens: this.cfg.seenTokens,
      hiddenTokens: this.cfg.hiddenTokens,
      opensea: { hasWallet: !!this.cfg.opensea.walletKey, rpc: this.cfg.opensea.rpc },
      together: { share: this.cfg.together.share, name: this.cfg.together.name, peers: this.cfg.together.peers.map((p) => ({ host: p.host, port: p.port, name: p.name })) },
    };
  }

  private load(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        discord: {
          token: this.secret(raw.discord?.token, 'discord.token'),
          watch: Array.isArray(raw.discord?.watch) ? raw.discord.watch.map(String) : [],
          send: raw.discord?.send === true,
        },
        telegram: { ...DEFAULT.telegram, ...raw.telegram, apiHash: this.secret(raw.telegram?.apiHash, 'telegram.apiHash'), session: this.secret(raw.telegram?.session, 'telegram.session') },
        cove: { amounts: Array.isArray(raw.cove?.amounts) ? raw.cove.amounts.map(Number) : DEFAULT.cove.amounts }, // any old affiliateId in the file is ignored
        buy: { provider: raw.buy?.provider === 'basedbot' ? 'basedbot' : 'cove' }, // any old basedbotReferral is ignored
        blacklist: Array.isArray(raw.blacklist) ? raw.blacklist.map(String) : [],
        favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String) : [],
        bots: {
          default: raw.bots?.default === 'show' ? 'show' : 'hide',
          allow: Array.isArray(raw.bots?.allow) ? raw.bots.allow.map(String) : [],
          calls: raw.bots?.calls === 'allow' ? 'allow' : 'all',
          pings: raw.bots?.pings === 'all' || raw.bots?.pings === 'allow' ? raw.bots.pings : 'none',
          pingAllow: Array.isArray(raw.bots?.pingAllow) ? raw.bots.pingAllow.map(String) : [],
        },
        pingTelegram: raw.pingTelegram !== false,
        o1ApiKey: this.secret(raw.o1ApiKey, 'o1ApiKey'),
        railOrder: Array.isArray(raw.railOrder) ? raw.railOrder.map(String) : [],
        // a config that never had columns gets the two defaults; a saved empty list stays empty
        columns: raw.columns === undefined ? DEFAULT_COLUMNS.map((c) => ({ ...c })) : sanitizeColumns(raw.columns),
        layouts: sanitizeLayouts(raw.layouts),
        j7: {
          token: this.secret(raw.j7?.token, 'j7.token'),
          favorites: Array.isArray(raw.j7?.favorites) ? [...new Set((raw.j7.favorites as unknown[]).map((h) => String(h).replace(/^@/, '').trim().toLowerCase()).filter((h) => h.length > 0))].slice(0, 500) : [],
        },
        seenTokens: Array.isArray(raw.seenTokens) ? raw.seenTokens.map(String).slice(-3000) : [],
        hiddenTokens: Array.isArray(raw.hiddenTokens) ? raw.hiddenTokens.map(String).slice(-3000) : [],
        opensea: {
          walletKey: (() => {
            const wk = this.secret(raw.opensea?.walletKey, 'opensea.walletKey');
            if (wk === undefined) return undefined;
            if (/^0x[0-9a-fA-F]{64}$/.test(String(wk))) return String(wk);
            console.warn('[config] ignoring invalid opensea.walletKey');
            return undefined;
          })(),
          // https only (or http to localhost/loopback): a plaintext RPC can be tampered with in
          // transit — a lied-about balance/fee, or a broadcast silently dropped.
          rpc: Object.fromEntries(
            Object.entries(raw.opensea?.rpc ?? {})
              .filter(([k, v]) => /^[a-z0-9_]{1,30}$/.test(k) && (/^https:\/\//i.test(String(v)) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(String(v))))
              .slice(0, 40)
              .map(([k, v]) => [k, String(v).slice(0, 500)]),
          ),
        },
        together: {
          share: raw.together?.share === true,
          name: String(raw.together?.name ?? '').trim().slice(0, 40),
          token: typeof raw.together?.token === 'string' ? raw.together.token.trim().slice(0, 100) : '',
          peers: (Array.isArray(raw.together?.peers) ? raw.together.peers : [])
            .filter((p: any) => p && typeof p.host === 'string' && typeof p.token === 'string' && Number.isInteger(Number(p.port)))
            .map((p: any) => ({ host: String(p.host).slice(0, 120), port: Number(p.port), token: String(p.token).slice(0, 100), name: String(p.name ?? '').slice(0, 40) }))
            .slice(0, 20),
        },
      };
    } catch {
      return structuredClone(DEFAULT);
    }
  }

  /** What goes on disk: the config with each secret sealed (when there is a key), or the locked ciphertext when this backend holds no value for it. */
  private toDisk(): Record<string, unknown> {
    const c = this.cfg;
    const put = (v: string | undefined, at: SecretPath) => (v !== undefined ? this.box.seal(v) : this.locked[at]);
    return {
      ...c,
      discord: { ...c.discord, token: put(c.discord.token, 'discord.token') },
      telegram: { ...c.telegram, apiHash: put(c.telegram.apiHash, 'telegram.apiHash'), session: put(c.telegram.session, 'telegram.session') },
      o1ApiKey: put(c.o1ApiKey, 'o1ApiKey'),
      j7: { ...c.j7, token: put(c.j7.token, 'j7.token') },
      opensea: { ...c.opensea, walletKey: put(c.opensea.walletKey, 'opensea.walletKey') },
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.toDisk(), null, 2), { mode: 0o600 });
    try {
      // writeFileSync's mode only applies when the file is created; an existing file (e.g. one left
      // world-readable by an older version) keeps its old permissions unless we chmod it explicitly.
      // Windows has no real POSIX mode bits and can throw here — that's fine, nothing to tighten.
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best-effort */
    }
  }
}
