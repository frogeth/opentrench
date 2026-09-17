import fs from 'node:fs';
import path from 'node:path';

export interface PluginRecord {
  storage: Record<string, unknown>;
  settings: Record<string, unknown>;
  chats: Record<string, string>;
}
const EMPTY = (): PluginRecord => ({ storage: {}, settings: {}, chats: {} });
const MAX_STORAGE_BYTES = 256 * 1024;

/** `plugins-state.json` next to the config: per-plugin storage, settings values and the chats it has posted. Debounced writes. */
export class PluginState {
  private data: Record<string, PluginRecord> = {};
  private timer: NodeJS.Timeout | undefined;
  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, r] of Object.entries<any>(raw ?? {})) this.data[id] = { storage: r?.storage ?? {}, settings: r?.settings ?? {}, chats: r?.chats ?? {} };
    } catch {
      /* first run */
    }
  }
  read(id: string): PluginRecord {
    return this.data[id] ?? (this.data[id] = EMPTY());
  }
  setStorage(id: string, key: string, value: unknown): void {
    const r = this.read(id);
    const prev = r.storage[key];
    const had = key in r.storage;
    if (value === undefined) delete r.storage[key];
    else r.storage[key] = value;
    if (JSON.stringify(r.storage).length > MAX_STORAGE_BYTES) {
      if (had) r.storage[key] = prev;
      else delete r.storage[key];
      throw new Error('plugin storage is full (256 KB)');
    }
    this.save();
  }
  setSettings(id: string, values: Record<string, unknown>): void {
    this.read(id).settings = values;
    this.save();
  }
  noteChat(id: string, chatId: string, name: string): void {
    this.read(id).chats[chatId] = name;
    this.save();
  }
  forget(id: string): void {
    delete this.data[id];
    this.save();
  }
  /** Write now (tests, shutdown). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.warn('[plugins] state save failed', e?.message ?? e);
    }
  }
  private save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }
}
