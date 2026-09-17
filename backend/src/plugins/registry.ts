import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginInfo } from '../types.js';
import { extractManifest, MAX_FILE, type PluginManifest } from './manifest.js';
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

/** The plugins folder: what is in it, whether each file is approved and enabled, and what each plugin has been doing. */
export class PluginRegistry {
  private loaded = new Map<string, Loaded>();
  private logLines = new Map<string, LogLine[]>();
  /** sites with a shell session; filled in by the shell link */
  signedIn: () => string[] = () => [];
  onChange: () => void = () => {};

  constructor(readonly dir: string, private state: PluginState, private cfg: PluginConfig) {}

  /** Rescan the folder. Errors are per file: a broken plugin never hides the others. */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const next = new Map<string, Loaded>();
    for (const name of fs.readdirSync(this.dir).filter((f) => f.endsWith('.js')).sort()) {
      const file = path.join(this.dir, name);
      const fallbackId = name.replace(/\.js$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'plugin';
      let source = '';
      try {
        if (fs.statSync(file).size > MAX_FILE) throw new Error(`plugin file is too large (${MAX_FILE / 1024} KB max)`);
        source = fs.readFileSync(file, 'utf8');
      } catch (e: any) {
        next.set(fallbackId, { id: fallbackId, file, hash: '', error: e?.message ?? String(e) });
        continue;
      }
      const hash = crypto.createHash('sha256').update(source).digest('hex');
      try {
        const manifest = extractManifest(source);
        if (manifest.id !== name.replace(/\.js$/, '')) throw new Error(`file name must be ${manifest.id}.js`);
        next.set(manifest.id, { id: manifest.id, file, hash, manifest });
      } catch (e: any) {
        next.set(fallbackId, { id: fallbackId, file, hash, error: e?.message ?? String(e) });
      }
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
        manifest: p.manifest,
        error: p.error,
        enabled: !!c?.enabled && !needsApproval && !p.error,
        needsApproval,
        chats: { ...this.state.read(p.id).chats },
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
  /** The file's text, for the iframe to import. Only an enabled plugin's code leaves the folder. */
  code(id: string): string {
    const p = this.get(id);
    if (!p?.enabled) throw new Error('plugin is not enabled');
    return fs.readFileSync(this.loaded.get(id)!.file, 'utf8');
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
    fs.writeFileSync(path.join(this.dir, `${m.id}.js`), source);
    this.load();
    return this.get(m.id)!;
  }
  remove(id: string): void {
    const p = this.loaded.get(id);
    if (p) fs.rmSync(p.file, { force: true });
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
    const lines = this.logLines.get(id) ?? [];
    lines.push({ ts: Date.now(), level, text: text.slice(0, 2000) });
    if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
    this.logLines.set(id, lines);
  }
  logs(id: string): LogLine[] {
    return [...(this.logLines.get(id) ?? [])];
  }
}
