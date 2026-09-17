import fs from 'node:fs';
import path from 'node:path';

/** One field of the settings form a plugin declares at runtime; the app renders these, the state file keeps them. */
export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'secret';
  default?: unknown;
}
export interface PluginRecord {
  storage: Record<string, unknown>;
  settings: Record<string, unknown>;
  chats: Record<string, string>;
  /** the last form the plugin declared, so the user can fill it in while the plugin is switched off */
  schema: SettingField[];
}
// The storage bag is keyed by whatever a plugin asks for, so it gets no prototype to walk into.
const EMPTY = (): PluginRecord => ({ storage: Object.create(null), settings: {}, chats: {}, schema: [] });
const MAX_STORAGE_BYTES = 256 * 1024;
/** the settings form a plugin may declare: small, flat, and every field named once */
const SCHEMA_FIELDS_MAX = 20;
const SCHEMA_KEY_RE = /^[a-z0-9_-]{1,40}$/i;
const SCHEMA_LABEL_MAX = 60;
const SCHEMA_TYPES = ['text', 'number', 'toggle', 'secret'];
const SCHEMA_BYTES_MAX = 16 * 1024;
/** key names that would reach through a plain settings object instead of sitting in it */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The app validates a schema before it ever reaches the backend, but the route is reachable on its
 * own and the state file can be edited by hand, so both doors check the same things: what is stored
 * is what the settings form will render, field for field.
 */
export function settingFields(raw: unknown): SettingField[] {
  if (!Array.isArray(raw) || raw.length > SCHEMA_FIELDS_MAX) throw new Error(`the settings schema must be an array of at most ${SCHEMA_FIELDS_MAX} fields`);
  if (Buffer.byteLength(JSON.stringify(raw ?? null)) > SCHEMA_BYTES_MAX) throw new Error(`the settings schema is too large (${SCHEMA_BYTES_MAX / 1024} KB max)`);
  const seen = new Set<string>();
  return raw.map((entry) => {
    const f = (entry ?? {}) as Record<string, unknown>;
    if (typeof f.key !== 'string' || !SCHEMA_KEY_RE.test(f.key)) throw new Error(`settings field key ${JSON.stringify(f.key)} must be 1-40 letters, digits, _ or -`);
    if (RESERVED_KEYS.has(f.key.toLowerCase())) throw new Error(`settings field key ${f.key} is reserved`);
    if (seen.has(f.key)) throw new Error(`settings field key ${f.key} appears twice`);
    seen.add(f.key);
    if (typeof f.label !== 'string' || !f.label || f.label.length > SCHEMA_LABEL_MAX) throw new Error(`settings field ${f.key} needs a label of at most ${SCHEMA_LABEL_MAX} characters`);
    if (typeof f.type !== 'string' || !SCHEMA_TYPES.includes(f.type)) throw new Error(`settings field ${f.key} has an unknown type; use ${SCHEMA_TYPES.join(', ')}`);
    const field: SettingField = { key: f.key, label: f.label, type: f.type as SettingField['type'] };
    // a default is one of the values an input can hold; an object or an array is neither
    if ('default' in f) {
      const d = f.default;
      if (typeof d !== 'string' && typeof d !== 'number' && typeof d !== 'boolean') throw new Error(`settings field ${f.key} needs a default that is text, a number or true/false`);
      field.default = d;
    }
    return field;
  });
}

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
        // The file is ours, but it is a file: a schema that no longer validates is dropped rather
        // than handed to the settings form, which trusts what it is given.
        let schema: SettingField[] = [];
        try {
          schema = settingFields(r?.schema ?? []);
        } catch (e: any) {
          console.warn(`[plugins] ${id}: stored settings form dropped —`, e?.message ?? e);
        }
        this.data[id] = { storage: Object.assign(Object.create(null), r?.storage ?? {}), settings: r?.settings ?? {}, chats: r?.chats ?? {}, schema };
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
  setSchema(id: string, schema: SettingField[]): void {
    this.ensure(id).schema = schema;
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
