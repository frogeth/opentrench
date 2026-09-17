import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(s2.read('p')).toEqual({ storage: { k: { a: 1 } }, settings: { limit: 5 }, chats: { 'plugin:p:c': 'C' } });
  });
});
