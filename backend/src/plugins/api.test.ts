import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MessageHub } from '../hub.js';
import { PluginRegistry } from './registry.js';
import { PluginState } from './state.js';
import { ShellLink } from './shell.js';
import { createPluginsApi, isLoopbackCaller } from './api.js';

const FILE = `export const manifest = {"id":"hello-feed","name":"Hello feed","version":"1.0.0","api":1,"sites":["https://example.com"],"permissions":["feed:write","storage"]};
export default function main(ot) {}`;

interface ShellCall {
  url: string;
  body: any;
}
interface Harness {
  base: string;
  dir: string;
  cfg: any;
  hub: MessageHub;
  reg: PluginRegistry;
  state: PluginState;
  shellCalls: ShellCall[];
  j: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  close: () => void;
}

/** One backend's worth of plugin routes on a random port, with a fake shell and a fake downloader. */
function harness(opts: { blacklist?: string[]; download?: (url: string) => Response | Promise<Response> } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-api-'));
  fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
  const cfg: any = { plugins: {}, pluginWatch: [] };
  const store = { get: () => cfg, update: (fn: (c: any) => void) => fn(cfg) };
  const state = new PluginState(path.join(dir, 'plugins-state.json'));
  const reg = new PluginRegistry(dir, state, store);
  reg.load();
  const hub = new MessageHub(500, undefined, opts.blacklist ? { blacklist: () => opts.blacklist! } : {});
  const shellCalls: ShellCall[] = [];
  const shell = new ShellLink(async (url: any, init: any) => {
    const at = String(url);
    // Anything not addressed to the shell's own callback is a plain outbound fetch.
    if (!at.startsWith('http://127.0.0.1:')) return new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } });
    shellCalls.push({ url: at, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (at.endsWith('/status')) return new Response(JSON.stringify({ signedIn: [] }), { status: 200 });
    if (at.endsWith('/signin')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'shell' }), { status: 200 });
  }, {});
  const app = express();
  // A spoofable peer address, so the loopback-only guard on /shell/hello can be exercised over a real socket.
  app.use((req, _res, next) => {
    const spoof = req.headers['x-test-remote'];
    if (typeof spoof === 'string') Object.defineProperty(req, 'socket', { value: { remoteAddress: spoof }, configurable: true });
    next();
  });
  const fetchImpl = opts.download ? ((async (u: any) => opts.download!(String(u))) as unknown as typeof fetch) : undefined;
  app.use('/api', createPluginsApi(reg, state, hub, shell, store as any, { fetchImpl }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const j = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { base, dir, cfg, hub, reg, state, shellCalls, j, close: () => server.close() };
}

let h: Harness;
beforeAll(() => {
  h = harness();
});
afterAll(() => h.close());
const j: Harness['j'] = (...args) => h.j(...args);

describe('plugins api', () => {
  it('lists, refuses code and posts before approval, then approve + enable make both work', async () => {
    expect((await j('GET', '/plugins')).body[0]).toMatchObject({ id: 'hello-feed', enabled: false, needsApproval: true });
    expect((await j('GET', '/plugins/hello-feed/code')).status).toBe(403);
    expect((await j('POST', '/plugins/hello-feed/post', { id: '1', chat: 'Alerts', author: 'x', text: 'hi' })).status).toBe(403);
    expect((await j('POST', '/plugins/hello-feed/approve')).status).toBe(200);
    expect((await j('POST', '/plugins/hello-feed/enable')).status).toBe(200);
    const code = await fetch(h.base + '/plugins/hello-feed/code');
    expect(code.headers.get('content-type')).toMatch(/javascript/);
    expect(await code.text()).toBe(FILE);
  });
  it('posts land in the hub as plugin messages, the chat is remembered and auto-watched, duplicates are dropped', async () => {
    const r = await j('POST', '/plugins/hello-feed/post', { id: '7', chat: 'Alerts', author: 'x', text: 'call 0xdac17f958d2ee523a2206206994597c13d831ec7' });
    expect(r.status).toBe(200);
    const m = h.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:7')!;
    expect(m).toMatchObject({ source: 'plugin', chatName: 'Alerts', contracts: [{ address: '0xdac17f958d2ee523a2206206994597c13d831ec7' }] });
    expect(h.cfg.pluginWatch).toEqual(['plugin:hello-feed:alerts']);
    expect((await j('GET', '/plugins')).body[0].chats).toEqual({ 'plugin:hello-feed:alerts': 'Alerts' });
    await j('POST', '/plugins/hello-feed/post', { id: '7', chat: 'Alerts', author: 'x', text: 'again' });
    expect(h.hub.hello().messages.filter((m) => m.id === 'plugin:hello-feed:alerts:7').length).toBe(1);
  });
  it('storage round-trips and settings save', async () => {
    expect((await j('PUT', '/plugins/hello-feed/storage/k', { value: { a: 1 } })).status).toBe(200);
    expect((await j('GET', '/plugins/hello-feed/storage')).body).toEqual({ k: { a: 1 } });
    expect((await j('PUT', '/plugins/hello-feed/settings', { values: { limit: 5 } })).status).toBe(200);
    expect((await j('GET', '/plugins/hello-feed/settings')).body).toEqual({ limit: 5 });
  });
  it("fetch goes out plain off the plugin's sites; javascript: and local addresses are refused", async () => {
    const ok = await j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' });
    expect(ok.body).toMatchObject({ status: 200, body: 'plain' });
    expect((await j('POST', '/plugins/hello-feed/fetch', { url: 'javascript:1' })).status).toBe(400);
    expect((await j('POST', '/plugins/hello-feed/fetch', { url: 'http://127.0.0.1:3210/api/config' })).status).toBe(400);
  });
  it('a fetch of one of the plugin\'s own sites needs the desktop app and never falls back', async () => {
    const r = await j('POST', '/plugins/hello-feed/fetch', { url: 'https://example.com/api' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/desktop app/);
  });
  it('the shell hello registers and status reports availability', async () => {
    expect((await j('GET', '/plugins/shell')).body).toEqual({ available: false });
    expect((await j('POST', '/shell/hello', { port: 45678, token: 't' })).status).toBe(200);
    expect((await j('GET', '/plugins/shell')).body).toEqual({ available: true });
  });
  it('a site fetch goes through the shell with the plugin\'s own credentials stripped', async () => {
    h.shellCalls.length = 0;
    const r = await j('POST', '/plugins/hello-feed/fetch', {
      url: 'https://example.com/api',
      init: { method: 'post', headers: { Cookie: 'sid=1', authorization: 'Bearer stolen', Host: 'elsewhere.example.com', 'X-Ok': 'yes', 'bad header': 'no' }, body: '{}' },
    });
    expect(r.body).toMatchObject({ status: 200, body: 'shell' });
    const call = h.shellCalls.find((c) => c.url.endsWith('/fetch'))!;
    expect(call.body.url).toBe('https://example.com/api');
    expect(call.body.init.headers).toEqual({ 'x-ok': 'yes' });
    expect(call.body.init.method).toBe('POST');
  });
  it('sites lists the manifest sites and sign-in is refused for any other host', async () => {
    expect((await j('GET', '/plugins/hello-feed/sites')).body).toMatchObject({ sites: ['https://example.com'], available: true });
    expect((await j('POST', '/plugins/hello-feed/sites/signin', { site: 'https://elsewhere.example.com' })).status).toBe(400);
    expect((await j('POST', '/plugins/hello-feed/sites/signin', { site: 'https://example.com' })).status).toBe(200);
  });
  it('disable, watch toggles and remove', async () => {
    expect((await j('PUT', '/plugins/watch', { key: 'plugin:hello-feed:alerts', on: false })).status).toBe(200);
    expect(h.cfg.pluginWatch).toEqual([]);
    expect((await j('POST', '/plugins/hello-feed/disable')).status).toBe(200);
    expect((await j('GET', '/plugins')).body[0].enabled).toBe(false);
    expect((await j('DELETE', '/plugins/hello-feed')).status).toBe(200);
    expect((await j('GET', '/plugins')).body).toEqual([]);
  });
});

describe('plugins api guards', () => {
  const approved = async (t: Harness) => {
    await t.j('POST', '/plugins/hello-feed/approve');
    await t.j('POST', '/plugins/hello-feed/enable');
  };

  it('a post from a blacklisted author lands hidden', async () => {
    const t = harness({ blacklist: ['x'] });
    try {
      await approved(t);
      expect((await t.j('POST', '/plugins/hello-feed/post', { id: '1', chat: 'Alerts', author: 'x', text: 'hi' })).status).toBe(200);
      expect(t.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:1')!.hidden).toBe(true);
    } finally {
      t.close();
    }
  });
  it('a plugin may name 32 chats; the 33rd is refused and never reaches the feed', async () => {
    const t = harness();
    try {
      await approved(t);
      for (let n = 1; n <= 32; n++) {
        expect((await t.j('POST', '/plugins/hello-feed/post', { id: String(n), chat: `chat ${n}`, text: 'hi' })).status).toBe(200);
      }
      const over = await t.j('POST', '/plugins/hello-feed/post', { id: '33', chat: 'chat 33', text: 'hi' });
      expect(over.status).toBe(400);
      expect(over.body.error).toMatch(/too many chats/);
      expect(t.hub.hello().messages.some((m) => m.chatId === 'plugin:hello-feed:chat-33')).toBe(false);
      expect(t.cfg.pluginWatch).toHaveLength(32);
    } finally {
      t.close();
    }
  });
  it('fetches are capped per plugin and per minute', async () => {
    const t = harness();
    try {
      await approved(t);
      for (let n = 0; n < 120; n++) {
        expect((await t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' })).status).toBe(200);
      }
      const over = await t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' });
      expect(over.status).toBe(429);
      expect(over.body.error).toMatch(/too many fetches/);
    } finally {
      t.close();
    }
  });
  it('hello is loopback only', async () => {
    expect(isLoopbackCaller('127.0.0.1')).toBe(true);
    expect(isLoopbackCaller('::1')).toBe(true);
    expect(isLoopbackCaller('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackCaller('203.0.113.5')).toBe(false);
    expect(isLoopbackCaller('')).toBe(false);
    const t = harness();
    try {
      const r = await t.j('POST', '/shell/hello', { port: 45678, token: 't' }, { 'x-test-remote': '203.0.113.5' });
      expect(r.status).toBe(403);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: false });
      expect((await t.j('POST', '/shell/hello', { port: 0, token: 't' })).status).toBe(400);
      expect((await t.j('POST', '/shell/hello', { port: 45678, token: '' })).status).toBe(400);
    } finally {
      t.close();
    }
  });
  it('code answers 409 when the file changed and 404 when it is gone', async () => {
    const t = harness();
    try {
      await approved(t);
      fs.writeFileSync(path.join(t.dir, 'hello-feed.js'), `${FILE}\n// changed`);
      const changed = await t.j('GET', '/plugins/hello-feed/code');
      expect(changed.status).toBe(409);
      expect(changed.body.error).toMatch(/approve this version/);
      // the file is back to the approved bytes but then disappears under us
      fs.writeFileSync(path.join(t.dir, 'hello-feed.js'), FILE);
      await approved(t);
      fs.rmSync(path.join(t.dir, 'hello-feed.js'));
      const gone = await t.j('GET', '/plugins/hello-feed/code');
      expect(gone.status).toBe(404);
      expect(gone.body.error).toMatch(/gone/);
    } finally {
      t.close();
    }
  });
  it('add-url takes https only, no local hosts, no redirects, and nothing over the size cap', async () => {
    const other = FILE.replace(/hello-feed/g, 'other-feed');
    const t = harness({
      download: (url) => {
        if (url === 'https://example.com/redirect.js') return new Response(null, { status: 302, headers: { location: 'https://example.com/other-feed.js' } });
        if (url === 'https://example.com/huge.js') return new Response('x'.repeat(600 * 1024), { status: 200 });
        return new Response(other, { status: 200 });
      },
    });
    try {
      expect((await t.j('POST', '/plugins/add-url', { url: 'http://example.com/other-feed.js' })).status).toBe(400);
      expect((await t.j('POST', '/plugins/add-url', { url: 'https://127.0.0.1/other-feed.js' })).status).toBe(400);
      expect((await t.j('POST', '/plugins/add-url', { url: 'https://localhost/other-feed.js' })).status).toBe(400);
      const redirected = await t.j('POST', '/plugins/add-url', { url: 'https://example.com/redirect.js' });
      expect(redirected.status).toBe(400);
      expect(redirected.body.error).toMatch(/redirects/);
      const big = await t.j('POST', '/plugins/add-url', { url: 'https://example.com/huge.js' });
      expect(big.status).toBe(400);
      expect(big.body.error).toMatch(/too large/);
      const added = await t.j('POST', '/plugins/add-url', { url: 'https://example.com/other-feed.js' });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ id: 'other-feed', needsApproval: true });
      expect(fs.readFileSync(path.join(t.dir, 'other-feed.js'), 'utf8')).toBe(other);
    } finally {
      t.close();
    }
  });
  it('add takes a plugin file far bigger than the rest of the API allows', async () => {
    const t = harness();
    try {
      // 200 KB: past createApi's 64kb parser, inside this router's own 1mb one and the 512 KB file cap.
      const big = `${FILE.replace(/hello-feed/g, 'big-feed')}\n// ${'x'.repeat(200 * 1024)}`;
      const added = await t.j('POST', '/plugins/add', { source: big });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ id: 'big-feed' });
      expect((await t.j('POST', '/plugins/add', { source: 'export default 1;' })).status).toBe(400);
    } finally {
      t.close();
    }
  });
  it('removing an id that is not in the folder still forgets its config, state and watches', async () => {
    const t = harness();
    try {
      await approved(t);
      await t.j('POST', '/plugins/hello-feed/post', { id: '1', chat: 'Alerts', text: 'hi' });
      expect(t.cfg.pluginWatch).toEqual(['plugin:hello-feed:alerts']);
      fs.rmSync(path.join(t.dir, 'hello-feed.js'));
      t.reg.load();
      expect((await t.j('DELETE', '/plugins/hello-feed')).status).toBe(200);
      expect(t.cfg.plugins).toEqual({});
      expect(t.cfg.pluginWatch).toEqual([]);
      expect(t.state.read('hello-feed').chats).toEqual({});
    } finally {
      t.close();
    }
  });
});
