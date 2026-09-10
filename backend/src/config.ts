import fs from 'node:fs';
import path from 'node:path';
import type { BotPolicy } from './types.js';

/** One column of the terminal. `chats` are `<source>:<id>` keys of watched chats; empty = every watched chat. */
export interface ColumnDef {
  id: string;
  type: 'calls' | 'chat';
  title: string;
  chats: string[];
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'calls', type: 'calls', title: 'All Calls', chats: [] },
  { id: 'chats', type: 'chat', title: 'All Chats', chats: [] },
];

export function sanitizeColumns(raw: unknown): ColumnDef[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  const out: ColumnDef[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 8)) {
    if (!r || typeof r !== 'object') continue;
    const id = String((r as any).id ?? '').trim().slice(0, 40);
    const type = (r as any).type === 'calls' ? 'calls' : 'chat';
    const title = String((r as any).title ?? '').trim().slice(0, 40) || (type === 'calls' ? 'Calls' : 'Chats');
    const chats = Array.isArray((r as any).chats) ? (r as any).chats.map(String).filter((k: string) => /^(discord|telegram):/.test(k)).slice(0, 200) : [];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, type, title, chats });
  }
  return out.length ? out : DEFAULT_COLUMNS.map((c) => ({ ...c }));
}

export interface Config {
  discord: { token?: string; watch: string[] };
  telegram: { apiId?: number; apiHash?: string; session?: string; watch: string[] };
  cove: { amounts: number[] };
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
}

const DEFAULT: Config = { discord: { watch: [] }, telegram: { watch: [] }, cove: { amounts: [25, 50, 100] }, blacklist: [], bots: { default: 'hide', allow: [] }, favorites: [], pingTelegram: true, railOrder: [], columns: DEFAULT_COLUMNS.map((c) => ({ ...c })) };

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
      discord: { hasToken: !!this.cfg.discord.token, watch: this.cfg.discord.watch },
      telegram: {
        apiId: this.cfg.telegram.apiId ?? null,
        hasApiHash: !!this.cfg.telegram.apiHash,
        hasSession: !!this.cfg.telegram.session,
        watch: this.cfg.telegram.watch,
      },
      cove: { amounts: this.cfg.cove.amounts },
      blacklist: this.cfg.blacklist,
      bots: this.cfg.bots,
      favorites: this.cfg.favorites,
      pingTelegram: this.cfg.pingTelegram,
      hasO1Key: !!this.cfg.o1ApiKey,
      railOrder: this.cfg.railOrder,
      columns: this.cfg.columns,
    };
  }

  private load(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        discord: { ...DEFAULT.discord, ...raw.discord },
        telegram: { ...DEFAULT.telegram, ...raw.telegram },
        cove: { amounts: Array.isArray(raw.cove?.amounts) ? raw.cove.amounts.map(Number) : DEFAULT.cove.amounts },
        blacklist: Array.isArray(raw.blacklist) ? raw.blacklist.map(String) : [],
        favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String) : [],
        bots: {
          default: raw.bots?.default === 'show' ? 'show' : 'hide',
          allow: Array.isArray(raw.bots?.allow) ? raw.bots.allow.map(String) : [],
        },
        pingTelegram: raw.pingTelegram !== false,
        o1ApiKey: typeof raw.o1ApiKey === 'string' && raw.o1ApiKey.trim() ? raw.o1ApiKey.trim() : undefined,
        railOrder: Array.isArray(raw.railOrder) ? raw.railOrder.map(String) : [],
        columns: sanitizeColumns(raw.columns),
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
