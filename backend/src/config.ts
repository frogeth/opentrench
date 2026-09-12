import fs from 'node:fs';
import path from 'node:path';
import type { BotPolicy } from './types.js';

/** One column of the terminal. `chats` are `<source>:<id>` keys of watched chats; empty = every watched chat. */
export interface ColumnDef {
  id: string;
  type: 'calls' | 'chat' | 'callers' | 'cove' | 'salpha' | 'j7' | 'web' | 'mints' | 'nftvol' | 'osmint';
  title: string;
  chats: string[];
  /** web columns: the page to embed (http/https only) */
  url?: string;
  /** nftvol: which OpenSea list, and which rolling window */
  ranking?: 'trending' | 'top';
  timeframe?: '1h' | '1d';
  /** a second column stacked under this one (one level only), sharing its width */
  split?: { bottom: ColumnDef; ratio?: number };
  /** fixed width in px (drag-resized); unset = share the space */
  width?: number;
  /** callers leaderboard window */
  window?: '24h' | '7d' | '30d';
  /** play a sound when a new call lands in this column */
  alert?: { on: boolean; sound: string };
  /** per-column filters (shape owned by the UI; values are strings, numbers, booleans or string arrays) */
  filters?: Record<string, string | number | boolean | string[]>;
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'calls', type: 'calls', title: 'All Calls', chats: [] },
  { id: 'chats', type: 'chat', title: 'All Chats', chats: [] },
];

const TYPES = ['calls', 'callers', 'cove', 'salpha', 'j7', 'web', 'chat', 'mints', 'nftvol', 'osmint'] as const;
const DEFAULT_TITLE: Record<ColumnDef['type'], string> = {
  calls: 'Calls',
  callers: 'Top Callers',
  cove: 'Cove',
  salpha: 'Salpha',
  j7: 'J7',
  web: 'Web',
  chat: 'Chats',
  mints: 'MintGo',
  nftvol: 'OpenSea Volume',
  osmint: 'OpenSea Mint',
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
  if (['24h', '7d', '30d'].includes(raw.window)) col.window = raw.window;
  const al = raw.alert;
  if (al && typeof al === 'object') col.alert = { on: !!al.on, sound: String(al.sound ?? 'ping').slice(0, 20) || 'ping' };
  if (type === 'web') {
    const u = String(raw.url ?? '').trim().slice(0, 2000);
    if (/^https?:\/\//i.test(u)) col.url = u;
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

export function sanitizeColumns(raw: unknown): ColumnDef[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  const out: ColumnDef[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 8)) {
    const col = parseColumn(r, seen, true);
    if (col) out.push(col);
  }
  return out.length ? out : DEFAULT_COLUMNS.map((c) => ({ ...c }));
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
  /** call cards the user has marked as seen (inbox style); newest last, capped */
  seenTokens: string[];
  /** J7Tracker: the account's session id (from its web app), read-only tweet stream */
  j7: { token?: string; /** X handles (no @) whose tweets ping you */ favorites: string[] };
  /** OpenSea mint window: one wallet key (0x + 64 hex) and RPC overrides by OpenSea chain identifier */
  opensea: { walletKey?: string; rpc: Record<string, string> };
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
  seenTokens: [],
  j7: { favorites: [] },
  opensea: { rpc: {} },
};

export class ConfigStore {
  private cfg: Config;

  constructor(private file: string) {
    this.cfg = this.load();
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
      j7: { hasToken: !!this.cfg.j7.token, favorites: this.cfg.j7.favorites },
      seenTokens: this.cfg.seenTokens,
      opensea: { hasWallet: !!this.cfg.opensea.walletKey, rpc: this.cfg.opensea.rpc },
    };
  }

  private load(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        discord: {
          token: typeof raw.discord?.token === 'string' && raw.discord.token.trim() ? raw.discord.token.trim() : undefined,
          watch: Array.isArray(raw.discord?.watch) ? raw.discord.watch.map(String) : [],
          send: raw.discord?.send === true,
        },
        telegram: { ...DEFAULT.telegram, ...raw.telegram },
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
        o1ApiKey: typeof raw.o1ApiKey === 'string' && raw.o1ApiKey.trim() ? raw.o1ApiKey.trim() : undefined,
        railOrder: Array.isArray(raw.railOrder) ? raw.railOrder.map(String) : [],
        columns: sanitizeColumns(raw.columns),
        j7: {
          token: typeof raw.j7?.token === 'string' && raw.j7.token.trim() ? raw.j7.token.trim() : undefined,
          favorites: Array.isArray(raw.j7?.favorites) ? [...new Set((raw.j7.favorites as unknown[]).map((h) => String(h).replace(/^@/, '').trim().toLowerCase()).filter((h) => h.length > 0))].slice(0, 500) : [],
        },
        seenTokens: Array.isArray(raw.seenTokens) ? raw.seenTokens.map(String).slice(-3000) : [],
        opensea: {
          walletKey: (() => {
            const wk = raw.opensea?.walletKey;
            if (wk === undefined || wk === null) return undefined;
            if (/^0x[0-9a-fA-F]{64}$/.test(String(wk))) return String(wk);
            console.warn('[config] ignoring invalid opensea.walletKey');
            return undefined;
          })(),
          rpc: Object.fromEntries(
            Object.entries(raw.opensea?.rpc ?? {})
              .filter(([k, v]) => /^[a-z0-9_]{1,30}$/.test(k) && /^https?:\/\//i.test(String(v)))
              .slice(0, 40)
              .map(([k, v]) => [k, String(v).slice(0, 500)]),
          ),
        },
      };
    } catch {
      return structuredClone(DEFAULT);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }
}
