import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MessageHub } from '../hub.js';
import { PluginRegistry } from './registry.js';
import { PluginState } from './state.js';
import { ShellLink } from './shell.js';
import { createPluginsApi, isLoopbackCaller, pluginHeaders, proxyBody } from './api.js';
import { jsonErrors } from '../http.js';

/** a plugin that may write the feed but stores nothing, for the refusals that need one */
const LOUD = `export const manifest = {"id":"loud-feed","name":"Loud feed","version":"1.0.0","api":1,"sites":["https://example.com"],"permissions":["feed:write"]};
export default function main(ot) {}`;

/** a file that will not parse: an id the folder has, with nothing usable behind it */
const BROKEN = 'export default function main(ot) {}';

/** a second plugin in the folder with no feed:write, for the refusals that need one */
const QUIET = `export const manifest = {"id":"quiet-feed","name":"Quiet feed","version":"1.0.0","api":1,"sites":["https://example.com"],"permissions":["storage"]};
export default function main(ot) {}`;

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
  /** how many plain outbound fetches the fake shell has started */
  outbound: { started: number };
  j: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  close: () => void;
}

/** One backend's worth of plugin routes on a random port, with a fake shell and a fake downloader. */
const tmpDirs: string[] = [];

function harness(opts: { blacklist?: string[]; download?: (url: string) => Response | Promise<Response>; hold?: () => Promise<void>; quiet?: boolean; loud?: boolean; broken?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-plugins-api-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'hello-feed.js'), FILE);
  if (opts.quiet) fs.writeFileSync(path.join(dir, 'quiet-feed.js'), QUIET);
  if (opts.loud) fs.writeFileSync(path.join(dir, 'loud-feed.js'), LOUD);
  if (opts.broken) fs.writeFileSync(path.join(dir, 'broken-feed.js'), BROKEN);
  const cfg: any = { plugins: {}, pluginWatch: [] };
  const store = { get: () => cfg, update: (fn: (c: any) => void) => fn(cfg) };
  const state = new PluginState(path.join(dir, 'plugins-state.json'));
  const reg = new PluginRegistry(dir, state, store);
  reg.load();
  const hub = new MessageHub(500, undefined, opts.blacklist ? { blacklist: () => opts.blacklist! } : {});
  const shellCalls: ShellCall[] = [];
  const outbound = { started: 0 };
  const shell = new ShellLink(async (url: any, init: any) => {
    const at = String(url);
    // Anything not addressed to the shell's own callback is a plain outbound fetch.
    if (!at.startsWith('http://127.0.0.1:')) {
      outbound.started++;
      if (opts.hold) await opts.hold();
      return new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
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
  return { base, dir, cfg, hub, reg, state, shellCalls, outbound, j, close: () => server.close() };
}

let h: Harness;
beforeAll(() => {
  h = harness();
});
afterAll(() => {
  h.close();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
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
  it('goodbye hands the link back, but only from loopback and only with the right token', async () => {
    const t = harness();
    try {
      expect((await t.j('POST', '/shell/hello', { port: 45678, token: 'right' })).status).toBe(200);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: true });

      // Not the LAN, even with the right token.
      expect((await t.j('POST', '/shell/goodbye', { token: 'right' }, { 'x-test-remote': '192.168.1.5' })).status).toBe(403);
      // Not a token that is merely the same length, and not one that is not.
      expect((await t.j('POST', '/shell/goodbye', { token: 'wrong' })).status).toBe(403);
      expect((await t.j('POST', '/shell/goodbye', { token: 'much longer than the real one' })).status).toBe(403);
      expect((await t.j('POST', '/shell/goodbye', {})).status).toBe(400);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: true });

      expect((await t.j('POST', '/shell/goodbye', { token: 'right' })).status).toBe(200);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: false });
      // And a second goodbye has nothing left to hand back.
      expect((await t.j('POST', '/shell/goodbye', { token: 'right' })).status).toBe(403);

      // The link is free again, so the next shell to start gets it.
      expect((await t.j('POST', '/shell/hello', { port: 45679, token: 'another' })).status).toBe(200);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: true });
    } finally {
      t.close();
    }
  });
  it('a goodbye token of the same length in characters but not in bytes is refused, not thrown at', async () => {
    const t = harness();
    try {
      // The real token is what the shell generates: 48 characters of hex, one byte each.
      const real = 'a'.repeat(48);
      expect((await t.j('POST', '/shell/hello', { port: 45678, token: real })).status).toBe(200);
      // 48 characters too, but 96 bytes. timingSafeEqual throws on buffers of different sizes, so a
      // length check counting characters lets this through to a 500 instead of answering 403.
      const r = await t.j('POST', '/shell/goodbye', { token: 'é'.repeat(48) });
      expect(r.status).toBe(403);
      expect((await t.j('GET', '/plugins/shell')).body).toEqual({ available: true });
      expect((await t.j('POST', '/shell/goodbye', { token: real })).status).toBe(200);
    } finally {
      t.close();
    }
  });
  it('hello is loopback only: not the LAN, not a name, in every spelling of loopback', async () => {
    expect(isLoopbackCaller('127.0.0.1')).toBe(true);
    expect(isLoopbackCaller('127.0.0.53')).toBe(true);
    expect(isLoopbackCaller('::1')).toBe(true);
    expect(isLoopbackCaller('::1%lo0')).toBe(true);
    expect(isLoopbackCaller('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackCaller('[::ffff:7f00:1]')).toBe(true);
    expect(isLoopbackCaller('192.168.1.5')).toBe(false); // the LAN is not this machine
    expect(isLoopbackCaller('10.0.0.4')).toBe(false);
    expect(isLoopbackCaller('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackCaller('203.0.113.5')).toBe(false);
    expect(isLoopbackCaller('')).toBe(false);
    const t = harness();
    try {
      expect((await t.j('POST', '/shell/hello', { port: 45678, token: 't' }, { 'x-test-remote': '192.168.1.5' })).status).toBe(403);
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
  it('the fetch header and body caps', () => {
    const many = Object.fromEntries([...Array(60)].map((_, n) => [`x-h${n}`, 'v']));
    expect(Object.keys(pluginHeaders(many, false))).toHaveLength(40);
    expect(pluginHeaders({ 'x-long': 'y'.repeat(9000) }, false)['x-long']).toHaveLength(4000);
    // the fetch layer's own headers never come from the plugin, and a value carrying a line break
    // would be a second header
    expect(
      pluginHeaders({ cookie: 'a=1', host: 'elsewhere.example.com', te: 'trailers', upgrade: 'h2c', 'keep-alive': '1', 'proxy-connection': 'keep-alive', 'x-ok': 'v\r\nx-evil: 1', 'bad name': 'v' }, false),
    ).toEqual({});
    expect(pluginHeaders({ authorization: 'Bearer own' }, false)).toEqual({ authorization: 'Bearer own' });
    // going through the shell, the site's login is the shell's to attach and a plugin adds neither kind
    expect(pluginHeaders({ authorization: 'Bearer own', 'proxy-authorization': 'Basic own' }, true)).toEqual({});
    expect(pluginHeaders({ 'proxy-authorization': 'Basic own' }, false)).toEqual({ 'proxy-authorization': 'Basic own' });
    expect(proxyBody('z'.repeat(2 * 1024 * 1024))).toHaveLength(1024 * 1024);
    expect(proxyBody({ not: 'a string' })).toBeUndefined();
  });
  it('a plugin may have four fetches out at once, and the fifth waits its turn', async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = () => r()));
    const t = harness({ hold: () => held });
    try {
      await approved(t);
      const four = [...Array(4)].map(() => t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' }));
      const deadline = Date.now() + 2000;
      while (t.outbound.started < 4) {
        if (Date.now() > deadline) throw new Error(`only ${t.outbound.started} of the four fetches ever reached the shell`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const fifth = await t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' });
      expect(fifth.status).toBe(429);
      expect(fifth.body.error).toMatch(/at once/);
      release();
      expect((await Promise.all(four)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
      // and the slot is free again once they land
      expect((await t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://plain.example.com/api' })).status).toBe(200);
    } finally {
      release();
      t.close();
    }
  });
  it('the header caps hold over the wire too', async () => {
    const t = harness();
    try {
      await approved(t);
      await t.j('POST', '/shell/hello', { port: 45678, token: 't' });
      t.shellCalls.length = 0;
      const headers: Record<string, string> = { 'x-long': 'y'.repeat(9000) };
      for (let n = 0; n < 60; n++) headers[`x-h${n}`] = 'v';
      expect((await t.j('POST', '/plugins/hello-feed/fetch', { url: 'https://example.com/api', init: { headers } })).status).toBe(200);
      const sent = t.shellCalls.find((c) => c.url.endsWith('/fetch'))!.body.init.headers;
      expect(Object.keys(sent)).toHaveLength(40);
      expect(sent['x-long']).toHaveLength(4000);
    } finally {
      t.close();
    }
  });
  it('a body the parser refuses answers as json, not an html stack page', async () => {
    const t = harness();
    try {
      const big = await fetch(`${t.base}/plugins/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'x'.repeat(2 * 1024 * 1024) }),
      });
      expect(big.status).toBe(413);
      expect(big.headers.get('content-type')).toMatch(/json/);
      expect((await big.json()).error).toMatch(/too large/);
      const bad = await fetch(`${t.base}/plugins/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type')).toMatch(/json/);
      expect((await bad.json()).error).toMatch(/not valid json/);
    } finally {
      t.close();
    }
  });
  it('a failure after the body has started streaming closes the connection instead of hanging', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/boom', (_req, res, next) => {
      res.status(200).type('text/plain');
      res.write('partial');
      next(new Error('kaboom'));
    });
    app.use(jsonErrors('[test]'));
    const server = app.listen(0);
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/boom`;
    try {
      const r = await fetch(at, { signal: AbortSignal.timeout(1500) });
      expect(r.status).toBe(200); // the headers were already on the wire; there is no answer to send
      const err = await r.text().then(() => null, (e: any) => e);
      expect(err).toBeTruthy(); // the body ended abruptly…
      expect(err.name).not.toBe('TimeoutError'); // …rather than leaving the client waiting it out
      expect(err.name).not.toBe('AbortError');
    } finally {
      server.close();
      quiet.mockRestore();
    }
  });
  it('a 500 says nothing about the machine it happened on', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/boom', () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/secret/config.json'"), { code: 'ENOENT' });
    });
    app.use(jsonErrors('[test]'));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/boom`);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'server error' });
      expect(quiet.mock.calls[0][1]).toMatch(/secret/); // the detail is in the log, not the answer
    } finally {
      server.close();
      quiet.mockRestore();
    }
  });
  it('settings need a plugin that is loaded, enabled to write, and stay under the size cap', async () => {
    const t = harness();
    try {
      expect((await t.j('GET', '/plugins/nope/settings')).status).toBe(404);
      expect((await t.j('PUT', '/plugins/nope/settings', { values: { a: 1 } })).status).toBe(404);
      // filling in a key is what one does before enabling, so a loaded plugin is enough
      expect((await t.j('PUT', '/plugins/hello-feed/settings', { values: { a: 1 } })).status).toBe(200);
      await approved(t);
      expect((await t.j('PUT', '/plugins/hello-feed/settings', { values: [1, 2] })).status).toBe(400);
      const over = await t.j('PUT', '/plugins/hello-feed/settings', { values: { blob: 'x'.repeat(80 * 1024) } });
      expect(over.status).toBe(400);
      expect(over.body.error).toMatch(/too large/);
      expect((await t.j('PUT', '/plugins/hello-feed/settings', { values: { limit: 5 } })).status).toBe(200);
      expect((await t.j('GET', '/plugins/hello-feed/settings')).body).toEqual({ limit: 5 });
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
  it('an edit needs the same permission, limiter and cleaning as a post', async () => {
    const t = harness({ quiet: true });
    try {
      await t.j('POST', '/plugins/quiet-feed/approve');
      await t.j('POST', '/plugins/quiet-feed/enable');
      const noWrite = await t.j('POST', '/plugins/quiet-feed/patch', { id: 'plugin:quiet-feed:alerts:1', text: 'hi' });
      expect(noWrite.status).toBe(403);
      expect(noWrite.body.error).toMatch(/feed:write/);
      await approved(t);
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:other:alerts:1', text: 'hi' })).status).toBe(400);
      await t.j('POST', '/plugins/hello-feed/post', { id: '1', chat: 'Alerts', text: 'first' });
      // the right-to-left override would let an edit rewrite how the whole line reads
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', text: 'safe \u202Etxt.exe' })).status).toBe(200);
      const m = t.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:1')!;
      expect(m.text).toBe('safe  txt.exe');
      // and an edit that adds a contract has it detected, without counting as a fresh call
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', text: 'now 0xdac17f958d2ee523a2206206994597c13d831ec7' })).status).toBe(200);
      expect(t.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:1')!.contracts).toEqual([
        expect.objectContaining({ address: '0xdac17f958d2ee523a2206206994597c13d831ec7' }),
      ]);
      // …but an edit is not a call: nothing is registered against the token and nobody is pinged
      expect(t.hub.hello().tokens).toEqual([]);
      expect(t.hub.hello().mentions).toEqual([]);
      // an attachment list that arrives empty clears the images rather than leaving them on screen
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', attachments: [{ url: 'https://example.com/a.png' }] })).status).toBe(200);
      expect(t.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:1')).toMatchObject({ hasAttachment: true, media: [{ kind: 'image', url: 'https://example.com/a.png' }] });
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', attachments: [] })).status).toBe(200);
      expect(t.hub.hello().messages.find((m) => m.id === 'plugin:hello-feed:alerts:1')).toMatchObject({ hasAttachment: false, media: [] });
      const offSite = await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', attachments: [{ url: 'https://elsewhere.example.com/a.png' }] });
      expect(offSite.status).toBe(400);
      expect(offSite.body.error).toMatch(/sites/);
    } finally {
      t.close();
    }
  });
  it('posts and edits share one 60-a-minute allowance', async () => {
    const t = harness();
    try {
      await approved(t);
      for (let n = 1; n <= 60; n++) {
        expect((await t.j('POST', '/plugins/hello-feed/post', { id: String(n), chat: 'Alerts', text: 'hi' })).status).toBe(200);
      }
      const over = await t.j('POST', '/plugins/hello-feed/post', { id: '61', chat: 'Alerts', text: 'hi' });
      expect(over.status).toBe(429);
      expect(over.body.error).toMatch(/too many posts/);
      // the edit route draws from the same allowance, so it is refused too
      expect((await t.j('POST', '/plugins/hello-feed/patch', { id: 'plugin:hello-feed:alerts:1', text: 'edit' })).status).toBe(429);
    } finally {
      t.close();
    }
  });
  it('log lines are kept per plugin, and an id we do not have is a 404', async () => {
    const t = harness();
    try {
      await approved(t);
      expect((await t.j('POST', '/plugins/hello-feed/log', { level: 'warn', text: 'careful' })).status).toBe(200);
      const logs = (await t.j('GET', '/plugins/hello-feed/logs')).body;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ level: 'warn', text: 'careful' });
      expect((await t.j('GET', '/plugins/nope/logs')).status).toBe(404);
      expect((await t.j('POST', '/plugins/nope/log', { text: 'x' })).status).toBe(404);
    } finally {
      t.close();
    }
  });
  it('storage needs the permission to read as well as write, and refuses a key that names a prototype', async () => {
    const t = harness({ quiet: true, loud: true });
    try {
      await approved(t);
      expect((await t.j('PUT', '/plugins/hello-feed/storage/__proto__', { value: { polluted: true } })).status).toBe(400);
      expect((await t.j('PUT', '/plugins/hello-feed/storage/constructor', { value: 1 })).status).toBe(400);
      expect((await t.j('PUT', '/plugins/hello-feed/storage/prototype', { value: 1 })).status).toBe(400);
      expect(({} as any).polluted).toBeUndefined();
      // quiet-feed has the storage permission, loud-feed does not: reading is gated like writing
      await t.j('POST', '/plugins/quiet-feed/approve');
      await t.j('POST', '/plugins/quiet-feed/enable');
      expect((await t.j('GET', '/plugins/quiet-feed/storage')).status).toBe(200);
      await t.j('POST', '/plugins/loud-feed/approve');
      await t.j('POST', '/plugins/loud-feed/enable');
      const denied = await t.j('GET', '/plugins/loud-feed/storage');
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatch(/storage permission/);
      expect((await t.j('PUT', '/plugins/loud-feed/storage/k', { value: 1 })).status).toBe(403);
    } finally {
      t.close();
    }
  });
  it('a watch key has to name a chat some plugin has posted', async () => {
    const t = harness();
    try {
      await approved(t);
      expect((await t.j('PUT', '/plugins/watch', { key: 'plugin:hello-feed:alerts', on: true })).status).toBe(400);
      await t.j('POST', '/plugins/hello-feed/post', { id: '1', chat: 'Alerts', text: 'hi' });
      expect((await t.j('PUT', '/plugins/watch', { key: 'plugin:hello-feed:alerts', on: false })).status).toBe(200);
      expect(t.cfg.pluginWatch).toEqual([]);
      expect((await t.j('PUT', '/plugins/watch', { key: 'plugin:hello-feed:made-up', on: true })).status).toBe(400);
      expect((await t.j('PUT', '/plugins/watch', { key: 'nonsense', on: true })).status).toBe(400);
      // switching off is always allowed: a key left over from a plugin that is gone has to be clearable
      t.cfg.pluginWatch.push('plugin:gone-feed:old');
      expect((await t.j('PUT', '/plugins/watch', { key: 'plugin:gone-feed:old', on: false })).status).toBe(200);
      expect(t.cfg.pluginWatch).toEqual([]);
    } finally {
      t.close();
    }
  });
  it('a file that will not parse is listed, and answers 422 with what is wrong with it', async () => {
    const t = harness({ broken: true });
    try {
      const listed = (await t.j('GET', '/plugins')).body.find((p: any) => p.id === 'broken-feed');
      expect(listed.error).toMatch(/no manifest/);
      for (const route of ['approve', 'enable']) {
        const r = await t.j('POST', `/plugins/broken-feed/${route}`);
        expect(r.status).toBe(422); // the id is real; the file behind it is not
        expect(r.body.error).toMatch(/no manifest/);
      }
      // and an id the folder does not have at all is still a 404
      expect((await t.j('POST', '/plugins/never-existed/approve')).status).toBe(404);
    } finally {
      t.close();
    }
  });
  it('mounted ahead of a router with a smaller parser, each keeps its own limit', async () => {
    // What index.ts does: the plugins router first, so a plugin file gets the 1mb parser, and the
    // rest of /api still refuses anything over its own 64kb.
    const t = harness();
    const standIn = express.Router();
    standIn.use(express.json({ limit: '64kb' }));
    standIn.put('/cove', (req, res) => res.json({ ok: true, n: req.body?.amounts?.length ?? 0 }));
    const app = express();
    app.use('/api', createPluginsApi(t.reg, t.state, t.hub, new ShellLink(async () => new Response('plain'), {}), { get: () => t.cfg, update: (fn: any) => fn(t.cfg) } as any));
    app.use('/api', standIn);
    const server = app.listen(0);
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const send = (p: string, method: string, body: unknown) =>
      fetch(at + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const cove = await send('/cove', 'PUT', { amounts: [25, 50] });
      expect(cove.status).toBe(200);
      expect(await cove.json()).toEqual({ ok: true, n: 2 });
      expect((await send('/cove', 'PUT', { amounts: 'x'.repeat(100 * 1024) })).status).toBe(413);
      const big = `${FILE.replace(/hello-feed/g, 'big-feed')}\n// ${'x'.repeat(200 * 1024)}`;
      expect((await send('/plugins/add', 'POST', { source: big })).status).toBe(200);
    } finally {
      server.close();
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
