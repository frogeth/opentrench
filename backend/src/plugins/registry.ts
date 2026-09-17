import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginInfo } from '../types.js';
import { extractManifest, ManifestError, MAX_FILE, MAX_FILE_MESSAGE, type PluginManifest } from './manifest.js';
import type { PluginState } from './state.js';

interface Loaded {
  id: string;
  file: string;
  hash: string;
  manifest?: PluginManifest;
  error?: string;
}
export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
/** The slice of ConfigStore the registry needs (keeps tests free of the real store). */
export interface PluginConfig {
  get(): { plugins: Record<string, { enabled: boolean; approvedHash?: string }> };
  update(fn: (c: { plugins: Record<string, { enabled: boolean; approvedHash?: string }> }) => void): void;
}
const LOG_MAX = 200;

/** An id for a broken file that no other entry holds: its name, else the name plus a slice of its hash, else a counter. */
function freeId(taken: Map<string, Loaded>, base: string, hash: string): string {
  if (!taken.has(base)) return base;
  if (hash) {
    const withHash = `${base}-${hash.slice(0, 6)}`;
    if (!taken.has(withHash)) return withHash;
  }
  for (let n = 2; ; n++) {
    const numbered = `${base}-${n}`;
    if (!taken.has(numbered)) return numbered;
  }
}

/** The plugins folder: what is in it, whether each file is approved and enabled, and what each plugin has been doing. */
export class PluginRegistry {
  private loaded = new Map<string, Loaded>();
  private logLines = new Map<string, LogLine[]>();
  /** sites with a shell session; filled in by the shell link */
  signedIn: () => string[] = () => [];
  onChange: () => void = () => {};

  constructor(readonly dir: string, private state: PluginState, private cfg: PluginConfig) {}

  /**
   * Rescan the folder. Errors are per file: a broken plugin never hides the others.
   * Two passes, because a broken file's id is guessed from its name and could collide with a real
   * plugin's: valid plugins claim their manifest id first, then the broken ones take what is left.
   */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const next = new Map<string, Loaded>();
    const broken: Loaded[] = [];
    for (const name of fs.readdirSync(this.dir).filter((f) => f.endsWith('.js')).sort()) {
      const file = path.join(this.dir, name);
      const stem = name.replace(/\.js$/, '');
      const fallbackId = stem.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'plugin';
      let bytes: Buffer;
      try {
        // lstat, not stat: a symlink here would otherwise let the folder reach any file on the box.
        const st = fs.lstatSync(file);
        if (!st.isFile()) throw new Error('not a regular file');
        if (st.size > MAX_FILE) throw new ManifestError(MAX_FILE_MESSAGE);
        bytes = fs.readFileSync(file);
      } catch (e: any) {
        broken.push({ id: fallbackId, file, hash: '', error: e?.message ?? String(e) });
        continue;
      }
      // Hash the bytes, not the decoded text: two different files can decode to the same string.
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const source = bytes.toString('utf8');
      try {
        const manifest = extractManifest(source);
        if (manifest.id !== stem) throw new Error(`file name must be ${manifest.id}.js`);
        next.set(manifest.id, { id: manifest.id, file, hash, manifest });
      } catch (e: any) {
        broken.push({ id: fallbackId, file, hash, error: e?.message ?? String(e) });
      }
    }
    for (const bad of broken) {
      const id = freeId(next, bad.id, bad.hash);
      next.set(id, { ...bad, id });
    }
    this.loaded = next;
    this.onChange();
  }

  list(): PluginInfo[] {
    const cfg = this.cfg.get().plugins;
    const signed = new Set(this.signedIn());
    return [...this.loaded.values()].map((p) => {
      const c = cfg[p.id];
      const needsApproval = !c?.approvedHash || c.approvedHash !== p.hash;
      return {
        id: p.id,
        file: path.basename(p.file),
        hash: p.hash,
        manifest: p.manifest && { ...p.manifest, sites: [...p.manifest.sites], permissions: [...p.manifest.permissions] },
        error: p.error,
        enabled: !!c?.enabled && !needsApproval && !p.error,
        needsApproval,
        // Only a real plugin gets a state record; a junk file must not add one to plugins-state.json.
        chats: p.manifest ? { ...this.state.read(p.id).chats } : {},
        signedIn: (p.manifest?.sites ?? []).filter((s) => signed.has(s)),
      };
    });
  }
  get(id: string): PluginInfo | undefined {
    return this.list().find((p) => p.id === id);
  }
  manifest(id: string): PluginManifest {
    const p = this.loaded.get(id);
    if (!p?.manifest) throw new Error(p?.error ?? 'unknown plugin');
    return p.manifest;
  }
  /**
   * The file's text, for the iframe to import. Only an enabled plugin's code leaves the folder, and
   * only the exact bytes the user approved: the file is re-hashed here, because the scan that
   * approved it may be seconds or days old and the file can have been swapped since.
   */
  code(id: string): string {
    const p = this.get(id);
    if (!p?.enabled) throw new Error('plugin is not enabled');
    const entry = this.loaded.get(id)!;
    const bytes = fs.readFileSync(entry.file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.hash) {
      this.load(); // so the next list() shows it as needing approval again
      throw new Error('the plugin file changed on disk; approve this version first');
    }
    return bytes.toString('utf8');
  }
  approve(id: string): void {
    const p = this.loaded.get(id);
    if (!p?.manifest) throw new Error(p?.error ?? 'unknown plugin');
    this.cfg.update((c) => {
      c.plugins[id] = { ...(c.plugins[id] ?? { enabled: false }), approvedHash: p.hash };
    });
    this.onChange();
  }
  enable(id: string): void {
    const p = this.loaded.get(id);
    if (!p?.manifest) throw new Error(p?.error ?? 'unknown plugin');
    if (this.cfg.get().plugins[id]?.approvedHash !== p.hash) throw new Error('approve this version of the plugin first');
    this.cfg.update((c) => {
      c.plugins[id] = { ...c.plugins[id], enabled: true };
    });
    this.onChange();
  }
  disable(id: string): void {
    this.cfg.update((c) => {
      if (c.plugins[id]) c.plugins[id].enabled = false;
    });
    this.onChange();
  }
  /** Validate, then write `<id>.js`. Replacing an existing file drops its approval (the hash changes). */
  add(source: string): PluginInfo {
    const m = extractManifest(source);
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${m.id}.js`);
    try {
      // Never write *through* a symlink someone planted in the folder: drop whatever is in the way
      // unless it is an ordinary file we are meant to replace.
      if (!fs.lstatSync(target).isFile()) fs.rmSync(target, { force: true, recursive: true });
    } catch {
      /* nothing there yet */
    }
    fs.writeFileSync(target, source, { mode: 0o600 });
    this.load();
    return this.get(m.id)!;
  }
  remove(id: string): void {
    const p = this.loaded.get(id);
    if (!p) throw new Error('unknown plugin');
    fs.rmSync(p.file, { force: true });
    this.cfg.update((c) => {
      delete c.plugins[id];
    });
    this.state.forget(id);
    this.logLines.delete(id);
    this.load();
  }
  noteChat(id: string, chatId: string, name: string): void {
    if (this.state.read(id).chats[chatId] === name) return;
    this.state.noteChat(id, chatId, name);
    this.onChange();
  }
  log(id: string, level: LogLine['level'], text: string): void {
    if (!this.loaded.has(id)) return;
    const lines = this.logLines.get(id) ?? [];
    lines.push({ ts: Date.now(), level, text: text.slice(0, 2000) });
    if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
    this.logLines.set(id, lines);
  }
  logs(id: string): LogLine[] {
    return [...(this.logLines.get(id) ?? [])];
  }
}
