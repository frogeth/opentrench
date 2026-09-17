import fs from 'node:fs';
import path from 'node:path';

export interface PluginRecord {
  storage: Record<string, unknown>;
  settings: Record<string, unknown>;
  chats: Record<string, string>;
}
// The storage bag is keyed by whatever a plugin asks for, so it gets no prototype to walk into.
const EMPTY = (): PluginRecord => ({ storage: Object.create(null), settings: {}, chats: {} });
const MAX_STORAGE_BYTES = 256 * 1024;
/** distinct chats one plugin may name; each one becomes a watch key and a row in the pickers */
const CHATS_MAX = 32;
/** Coalesce a burst of writes… */
const DEBOUNCE_MS = 200;
/** …but never let a steady stream of them hold the file back longer than this. */
const MAX_DEBOUNCE_MS = 2000;
/** How long to wait before trying again after a write that failed. */
const RETRY_MS = 2000;

/** `plugins-state.json` next to the config: per-plugin storage, settings values and the chats it has posted. Debounced writes. */
export class PluginState {
  private data: Record<string, PluginRecord> = {};
  private timer: NodeJS.Timeout | undefined;
  /** when the oldest unsaved change came in, 0 when everything is on disk */
  private firstDirtyAt = 0;
  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [id, r] of Object.entries<any>(raw ?? {})) {
        this.data[id] = { storage: Object.assign(Object.create(null), r?.storage ?? {}), settings: r?.settings ?? {}, chats: r?.chats ?? {} };
      }
    } catch {
      /* first run */
    }
  }
  /** Read-only view. An id with nothing stored reads as empty without being written down. */
  read(id: string): PluginRecord {
    return this.data[id] ?? EMPTY();
  }
  private ensure(id: string): PluginRecord {
    return (this.data[id] ??= EMPTY());
  }
  setStorage(id: string, key: string, value: unknown): void {
    const r = this.ensure(id);
    const prev = r.storage[key];
    const had = key in r.storage;
    if (value === undefined) delete r.storage[key];
    else r.storage[key] = value;
    if (Buffer.byteLength(JSON.stringify(r.storage)) > MAX_STORAGE_BYTES) {
      if (had) r.storage[key] = prev;
      else delete r.storage[key];
      throw new Error(`plugin storage is full (${MAX_STORAGE_BYTES / 1024} KB)`);
    }
    this.save();
  }
  setSettings(id: string, values: Record<string, unknown>): void {
    this.ensure(id).settings = values;
    this.save();
  }
  noteChat(id: string, chatId: string, name: string): void {
    const p = this.ensure(id);
    // one plugin naming endless chats would fill the config's watch list and the sidebar; renames are free
    if (p.chats[chatId] === undefined && Object.keys(p.chats).length >= CHATS_MAX) throw new Error(`too many chats (${CHATS_MAX} max)`);
    p.chats[chatId] = name;
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
    this.firstDirtyAt = 0;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        // The mode above only applies when the tmp file is created; rename carries it over, but a
        // file left world-readable by an older version keeps its mode, so tighten it explicitly.
        // Windows has no real POSIX mode bits and can throw here — nothing to tighten there.
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* best-effort */
      }
    } catch (e: any) {
      console.warn('[plugins] state save failed', e?.message ?? e);
      // The change is still only in memory: a full disk or a passing EPERM must not turn into a
      // silent loss, so the file stays dirty and another write is queued.
      this.firstDirtyAt = Date.now();
      this.timer = setTimeout(() => this.flush(), RETRY_MS);
      this.timer.unref?.();
    }
  }
  private save(): void {
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    // A plugin writing every tick would reset the debounce forever and lose everything on a crash.
    if (now - this.firstDirtyAt >= MAX_DEBOUNCE_MS) {
      this.flush();
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    this.timer.unref?.();
  }
}
