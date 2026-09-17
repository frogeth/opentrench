import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE } from './manifest.js';
import { PluginRegistry } from './registry.js';
import { PluginState } from './state.js';

const FILE = `export const manifest = {"id":"hello-feed","name":"Hello feed","version":"1.0.0","api":1,"permissions":["feed:write"]};
export default function main(ot) {}`;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-'));
  const state = new PluginState(path.join(dir, 'plugins-state.json'));
  let cfg: any = { plugins: {}, pluginWatch: [] };
  const reg = new PluginRegistry(dir, state, { get: () => cfg, update: (fn: (c: any) => void) => fn(cfg) });
  return { dir, reg, state, cfg: () => cfg };
}

describe('PluginRegistry', () => {
  it('lists files in the folder with their manifest, hash and approval state', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    fs.writeFileSync(path.join(dir, 'broken.js'), 'export default 1;');
    reg.load();
    const list = reg.list();
    expect(list.map((p) => p.id).sort()).toEqual(['broken', 'hello-feed']);
    const ok = list.find((p) => p.id === 'hello-feed')!;
    expect(ok.manifest?.name).toBe('Hello feed');
    expect(ok.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.enabled).toBe(false);
    expect(ok.needsApproval).toBe(true);
    expect(list.find((p) => p.id === 'broken')!.error).toMatch(/no manifest/);
  });
  it('approve binds the hash; enable needs approval; a changed file drops back to needing it', () => {
    const { dir, reg, cfg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    expect(() => reg.enable('hello-feed')).toThrow('approve');
    reg.approve('hello-feed');
    reg.enable('hello-feed');
    expect(reg.list()[0]).toMatchObject({ enabled: true, needsApproval: false });
    expect(cfg().plugins['hello-feed'].approvedHash).toBe(reg.list()[0].hash);
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE + '\n// changed');
    reg.load();
    expect(reg.list()[0]).toMatchObject({ enabled: false, needsApproval: true });
  });
  it('add writes <id>.js after validating; remove deletes the file and its config', () => {
    const { dir, reg, cfg } = fresh();
    const info = reg.add(FILE);
    expect(info.id).toBe('hello-feed');
    expect(fs.existsSync(path.join(dir, 'hello-feed.js'))).toBe(true);
    expect(() => reg.add('nope')).toThrow('no manifest');
    reg.approve('hello-feed');
    reg.remove('hello-feed');
    expect(fs.existsSync(path.join(dir, 'hello-feed.js'))).toBe(false);
    expect(cfg().plugins['hello-feed']).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });
  it('a file whose manifest id does not match its name is an error, not a plugin', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'other.js'), FILE);
    reg.load();
    expect(reg.list()[0]).toMatchObject({ id: 'other', enabled: false });
    expect(reg.list()[0].error).toMatch(/hello-feed\.js/);
  });
  it('a broken file never evicts a valid plugin whose id its name would claim', () => {
    const { dir, reg, state } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    fs.writeFileSync(path.join(dir, 'hello_feed.js'), 'export default 1;');
    reg.load();
    reg.approve('hello-feed');
    reg.enable('hello-feed');
    const list = reg.list();
    expect(list.length).toBe(2);
    const ok = list.find((p) => p.id === 'hello-feed')!;
    expect(ok.error).toBeUndefined();
    expect(ok.enabled).toBe(true);
    expect(ok.file).toBe('hello-feed.js');
    expect(reg.code('hello-feed')).toBe(FILE);
    const junk = list.find((p) => p.id !== 'hello-feed')!;
    expect(junk.id).toMatch(/^hello-feed-[0-9a-f]{6}$/);
    expect(junk.file).toBe('hello_feed.js');
    expect(junk.error).toMatch(/no manifest/);
    expect(junk.chats).toEqual({});
    state.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'plugins-state.json'), 'utf8'));
    expect(saved[junk.id]).toBeUndefined();
  });
  it('two broken files whose names sanitize to the same id both show up', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'bad one.js'), 'export default 1;');
    fs.writeFileSync(path.join(dir, 'bad-one.js'), 'export default 2;');
    reg.load();
    const list = reg.list();
    expect(list.length).toBe(2);
    expect(list.every((p) => !!p.error)).toBe(true);
    expect(new Set(list.map((p) => p.id)).size).toBe(2);
    expect(list.map((p) => p.file).sort()).toEqual(['bad one.js', 'bad-one.js']);
  });
  it('code() serves an enabled plugin, but refuses a disabled one or a file changed since approval', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    expect(() => reg.code('hello-feed')).toThrow('not enabled');
    reg.approve('hello-feed');
    reg.enable('hello-feed');
    expect(reg.code('hello-feed')).toBe(FILE);
    // Swapped behind the registry's back: the approved hash no longer describes what is on disk.
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), `${FILE}\n// sneaky`);
    expect(() => reg.code('hello-feed')).toThrow('changed on disk');
    expect(reg.list()[0]).toMatchObject({ needsApproval: true, enabled: false });
  });
  it('does not read a symlink or an oversize file, and lists each as an error', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'secret.txt'), FILE);
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'x.js'));
    fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(MAX_FILE + 1));
    reg.load();
    const link = reg.list().find((p) => p.id === 'x')!;
    expect(link.error).toBe('not a regular file');
    expect(link.hash).toBe(''); // never opened
    expect(link.manifest).toBeUndefined();
    expect(reg.list().find((p) => p.id === 'big')!.error).toMatch(/too large/);
  });
  it('add() replaces a planted symlink with a real file instead of writing through it', () => {
    const { dir, reg } = fresh();
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.symlinkSync(outside, path.join(dir, 'hello-feed.js'));
    reg.add(FILE);
    const written = path.join(dir, 'hello-feed.js');
    expect(fs.lstatSync(written).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(written, 'utf8')).toBe(FILE);
    expect(fs.readFileSync(outside, 'utf8')).toBe('ORIGINAL');
  });
  it('remove() refuses an id that is not in the folder', () => {
    const { reg } = fresh();
    reg.load();
    expect(() => reg.remove('nope')).toThrow('unknown plugin');
  });
  it('forgetOrphan() clears what is left of a plugin whose file is already gone', () => {
    const { dir, reg, state, cfg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    reg.approve('hello-feed');
    reg.enable('hello-feed');
    reg.noteChat('hello-feed', 'plugin:hello-feed:alerts', 'Alerts');
    fs.rmSync(path.join(dir, 'hello-feed.js'));
    reg.load();
    reg.forgetOrphan('hello-feed');
    expect(cfg().plugins).toEqual({});
    expect(state.read('hello-feed').chats).toEqual({});
  });
  it('list() hands out a copy of the manifest', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    reg.list()[0].manifest!.permissions.push('actions');
    expect(reg.list()[0].manifest!.permissions).toEqual(['feed:write']);
  });
  it('ignores a log line for an id that is not loaded', () => {
    const { reg } = fresh();
    reg.load();
    reg.log('ghost', 'info', 'hi');
    expect(reg.logs('ghost')).toEqual([]);
  });
  it('remembers chats a plugin posted and keeps a bounded log', () => {
    const { dir, reg, state } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    reg.noteChat('hello-feed', 'plugin:hello-feed:alerts', 'Alerts');
    expect(reg.list()[0].chats).toEqual({ 'plugin:hello-feed:alerts': 'Alerts' });
    expect(state.read('hello-feed').chats).toEqual({ 'plugin:hello-feed:alerts': 'Alerts' });
    for (let i = 0; i < 250; i++) reg.log('hello-feed', 'info', `line ${i}`);
    expect(reg.logs('hello-feed').length).toBe(200);
    expect(reg.logs('hello-feed')[0].text).toBe('line 50');
  });
  it('caps a plugin at 32 distinct chats, but lets it rename the ones it has', () => {
    const { dir, reg } = fresh();
    fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
    reg.load();
    for (let i = 0; i < 32; i++) reg.noteChat('hello-feed', `plugin:hello-feed:c${i}`, `C${i}`);
    expect(Object.keys(reg.list()[0].chats).length).toBe(32);
    expect(() => reg.noteChat('hello-feed', 'plugin:hello-feed:c32', 'C32')).toThrow('too many chats (32 max)');
    expect(Object.keys(reg.list()[0].chats).length).toBe(32);
    reg.noteChat('hello-feed', 'plugin:hello-feed:c0', 'Renamed');
    expect(reg.list()[0].chats['plugin:hello-feed:c0']).toBe('Renamed');
  });
  it('storage is capped and settings/chats survive a reload of the state file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-'));
    const file = path.join(dir, 'plugins-state.json');
    const s1 = new PluginState(file);
    s1.setStorage('p', 'k', { a: 1 });
    s1.setSettings('p', { limit: 5 });
    s1.noteChat('p', 'plugin:p:c', 'C');
    expect(() => s1.setStorage('p', 'big', 'x'.repeat(300 * 1024))).toThrow('full');
    expect(s1.read('p').storage).toEqual({ k: { a: 1 } });
    s1.flush();
    const s2 = new PluginState(file);
    expect(s2.read('p')).toEqual({ storage: { k: { a: 1 } }, settings: { limit: 5 }, chats: { 'plugin:p:c': 'C' }, schema: [] });
  });
  it('reading an unknown plugin does not add a record to the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-'));
    const file = path.join(dir, 'plugins-state.json');
    const s = new PluginState(file);
    expect(s.read('ghost')).toEqual({ storage: {}, settings: {}, chats: {}, schema: [] });
    s.noteChat('real', 'plugin:real:c', 'C');
    s.flush();
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['real']);
  });
  it('a steady stream of writes still reaches disk within 2 s', () => {
    vi.useFakeTimers();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-'));
      const file = path.join(dir, 'plugins-state.json');
      const s = new PluginState(file);
      // Each write resets the 200 ms debounce, so on its own the timer would never fire.
      for (let i = 0; i < 15; i++) {
        s.setStorage('p', 'k', i);
        vi.advanceTimersByTime(100);
      }
      expect(fs.existsSync(file)).toBe(false);
      for (let i = 15; i < 25; i++) {
        s.setStorage('p', 'k', i);
        vi.advanceTimersByTime(100);
      }
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).p.storage).toHaveProperty('k');
    } finally {
      vi.useRealTimers();
    }
  });
});
