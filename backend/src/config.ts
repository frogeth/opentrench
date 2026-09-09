import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  discord: { token?: string; watch: string[] };
  telegram: { apiId?: number; apiHash?: string; session?: string; watch: string[] };
  cove: { amounts: number[] };
  /** caller names (case-insensitive, leading @ ignored) whose posts never count as calls */
  blacklist: string[];
  /** callers whose first-time calls ping you */
  favorites: string[];
  /** send pings to your own Telegram "Saved Messages" */
  pingTelegram: boolean;
  /** optional o1.exchange launchpad API key (keys start with o1_launch_) */
  o1ApiKey?: string;
}

const DEFAULT: Config = { discord: { watch: [] }, telegram: { watch: [] }, cove: { amounts: [25, 50, 100] }, blacklist: [], favorites: [], pingTelegram: true };

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
      favorites: this.cfg.favorites,
      pingTelegram: this.cfg.pingTelegram,
      hasO1Key: !!this.cfg.o1ApiKey,
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
        pingTelegram: raw.pingTelegram !== false,
        o1ApiKey: typeof raw.o1ApiKey === 'string' && raw.o1ApiKey.trim() ? raw.o1ApiKey.trim() : undefined,
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
