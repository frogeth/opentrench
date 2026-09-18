import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay } from 'opentrench-relay/src/relay.js';
import { __setProbeDispatcher, createApi } from './api.js';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { RoomClient, type RoomClientOptions } from './rooms/client.js';
import { decodeInvite } from './rooms/crypto.js';
import { NO_RELAY_MESSAGE, RoomsManager } from './rooms/manager.js';
import { safeDispatcher } from './plugins/shell.js';

const APP = { 'x-requested-with': 'opentrench' } as const;
const JSON_ = { 'content-type': 'application/json' } as const;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  __setProbeDispatcher(undefined);
  while (cleanups.length) await cleanups.pop()!();
});

/** The real relay on a random port; the probe wants its `GET /` card, no socket is ever opened to it. */
async function startRelay(): Promise<{ url: string }> {
  const relay = createRelay();
  const server = http.createServer();
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `ws://localhost:${port}` };
}

/** Something on localhost that is not a relay: answers every request with `body`. */
async function startOther(body: string, status = 200): Promise<{ url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `ws://localhost:${port}` };
}

describe('rooms API', () => {
  let dir: string;
  let cfg: ConfigStore;
  let mgr: RoomsManager;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rooms-api-'));
    cfg = new ConfigStore(path.join(dir, 'config.json'));
    const hub = new MessageHub(10);
    // the real manager, with clients that never dial: these tests are about the routes, not the wire
    mgr = new RoomsManager({
      cfg,
      hub,
      version: 'test',
      name: () => 'tester',
      clientFactory: (o: RoomClientOptions) => {
        const c = new RoomClient(o);
        c.start = () => {};
        return c;
      },
    });
    const svc = { rooms: mgr, togetherPairings: () => [], syncTogether: async () => {} };
    const app = express();
    app.use('/api', createApi(cfg, hub, svc as any));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    cleanups.push(() => {
      mgr.stop();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = APP) =>
    fetch(`${base}${p}`, { method, headers: body === undefined ? headers : { ...headers, ...JSON_ }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('GET /together carries rooms, memberId, the relay preference and the default relay', async () => {
    const res = await call('GET', '/together');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toEqual([]);
    expect(body.memberId).toBe(cfg.get().together.memberId);
    expect(body.memberId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.relay).toBe('');
    expect(body).not.toHaveProperty('defaultRelay');
    expect(body.pairings).toEqual([]);
  });

  it('creates a room whose invite decodes, and lists it without the key', async () => {
    const res = await call('POST', '/together/rooms', { name: 'degens', relay: 'wss://relay.example:8443' });
    expect(res.status).toBe(200);
    const { room, status } = await res.json();
    expect(room).toMatchObject({ name: 'degens', relay: 'wss://relay.example:8443', hasAccess: false });
    const inv = decodeInvite(room.invite);
    expect(inv).toBeDefined();
    expect(inv!.id).toBe(room.id);
    expect(inv!.relay).toBe('wss://relay.example:8443');
    expect('status' in { status }).toBe(true);

    // the invite carries the key on purpose (it is the whole secret); a bare `key` field is what must not show
    expect(Object.keys(room).sort()).toEqual(['hasAccess', 'id', 'invite', 'joinedAt', 'name', 'relay']);
    const stored = cfg.get().together.rooms[0];
    expect(stored.key).toBe(inv!.key);
    expect(JSON.stringify({ room, status }).replace(room.invite, '')).not.toContain(stored.key);
    const list = await (await call('GET', '/together')).json();
    expect(list.rooms).toEqual([room]);
    expect(JSON.stringify(list).replace(room.invite, '')).not.toContain(stored.key);
  });

  it('a create with no relay and no remembered one is a 400 asking for a relay address', async () => {
    const res = await call('POST', '/together/rooms', { name: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(NO_RELAY_MESSAGE);
  });

  it('join with garbage is a 400 with the readable message', async () => {
    const res = await call('POST', '/together/rooms/join', { invite: 'hello there' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a room invite/);
  });

  it('join takes a name and an access code; leave, rotate and access work by id', async () => {
    const other = new ConfigStore(path.join(dir, 'other.json'));
    const theirs = new RoomsManager({ cfg: other, hub: new MessageHub(10), version: 't', name: () => 'o', clientFactory: (o) => Object.assign(new RoomClient(o), { start() {} }) });
    const { invite } = theirs.create('theirs', 'wss://relay.example');
    theirs.stop();

    const joined = await call('POST', '/together/rooms/join', { invite, name: 'friends', access: 'sesame' });
    expect(joined.status).toBe(200);
    const joinedBody = await joined.json();
    const { room } = joinedBody;
    expect(room).toMatchObject({ name: 'friends', relay: 'wss://relay.example', hasAccess: true, invite });
    const stored = cfg.get().together.rooms[0];
    expect(stored.access).toBe('sesame');
    // neither secret leaves in the response: the access code never, the key only inside the invite
    const wire = JSON.stringify(joinedBody);
    expect(wire).not.toContain('sesame');
    expect(wire.replace(invite, '')).not.toContain(stored.key);
    const listed = JSON.stringify(await (await call('GET', '/together')).json());
    expect(listed).not.toContain('sesame');
    expect(listed.replace(invite, '')).not.toContain(stored.key);

    const again = await call('POST', '/together/rooms/join', { invite });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already in that room/);

    const cleared = await call('PUT', `/together/rooms/${room.id}/access`, { access: '' });
    expect(await cleared.json()).toEqual({ ok: true });
    expect(cfg.get().together.rooms[0].access).toBeUndefined();

    const rotated = await call('POST', `/together/rooms/${room.id}/rotate`);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()).room;
    expect(next.id).not.toBe(room.id);
    expect(next.invite).not.toBe(invite);
    expect(decodeInvite(next.invite)!.id).toBe(next.id);
    expect(next.name).toBe('friends');

    const gone = await call('DELETE', `/together/rooms/${room.id}`);
    expect(gone.status).toBe(400);
    expect((await gone.json()).error).toMatch(/not in that room/);

    const left = await call('DELETE', `/together/rooms/${next.id}`);
    expect(left.status).toBe(200);
    expect((await left.json()).ok).toBe(true);
    expect(cfg.get().together.rooms).toEqual([]);
  });

  it('every mutating route refuses a request without the app header', async () => {
    const { room } = await (await call('POST', '/together/rooms', { name: 'x', relay: 'wss://relay.example' })).json();
    const attempts: [string, string, unknown?][] = [
      ['POST', '/together/rooms', { name: 'y' }],
      ['POST', '/together/rooms/join', { invite: room.invite }],
      ['DELETE', `/together/rooms/${room.id}`],
      ['POST', `/together/rooms/${room.id}/rotate`],
      ['PUT', `/together/rooms/${room.id}/access`, { access: 'a' }],
      ['PUT', '/together/relay', { relay: 'wss://relay.example' }],
    ];
    for (const [method, p, body] of attempts) {
      const res = await call(method, p, body, {});
      expect(res.status, `${method} ${p}`).toBe(403);
      expect((await res.json()).error).toMatch(/opentrench app/);
    }
    // and nothing changed
    expect(cfg.get().together.rooms.map((r) => r.id)).toEqual([room.id]);
    expect(cfg.get().together.rooms[0].access).toBeUndefined();
    expect(cfg.get().together.relay).toBe('');
    // (the header-bearing create above did not set the preference either: routes never touch it, only the UI does)
    // the listing carries every invite (the room keys), so it is app-only too; the probe stays open
    const listing = await call('GET', '/together', undefined, {});
    expect(listing.status).toBe(403);
    expect(JSON.stringify(await listing.json())).not.toContain(room.invite);
    expect((await call('GET', '/together')).status).toBe(200);
    expect((await call('GET', '/together/relay/probe?url=wss://10.0.0.1', undefined, {})).status).toBe(200);
  });

  it('PUT /together/relay validates, stores the canonical form and clears on an empty string', async () => {
    const bad = await call('PUT', '/together/relay', { relay: 'ws://relay.example' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/wss:\/\/ unless it is localhost/);
    expect(cfg.get().together.relay).toBe('');

    const good = await call('PUT', '/together/relay', { relay: ' WSS://Relay.Example:8443/ ' });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ relay: 'wss://relay.example:8443' });
    expect(cfg.get().together.relay).toBe('wss://relay.example:8443');
    expect((await (await call('GET', '/together')).json()).relay).toBe('wss://relay.example:8443');

    const clear = await call('PUT', '/together/relay', { relay: '' });
    expect(await clear.json()).toEqual({ relay: '' });
    expect(cfg.get().together.relay).toBe('');
  });

  it('probe finds an in-process relay', async () => {
    const { url } = await startRelay();
    const res = await call('GET', `/together/relay/probe?url=${encodeURIComponent(url)}`, undefined, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, v: 1, rooms: 0 });
  });

  it('probe refuses a private address without dialing, and a bad URL', async () => {
    for (const url of ['wss://10.0.0.1', 'wss://192.168.1.1:8443', 'wss://169.254.169.254', 'wss://[fd00::1]']) {
      const res = await call('GET', `/together/relay/probe?url=${encodeURIComponent(url)}`, undefined, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok, url).toBe(false);
      expect(body.error).toMatch(/inside your network/);
    }
    const bad = await (await call('GET', '/together/relay/probe?url=http://relay.example', undefined, {})).json();
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/wss:\/\//) });
    const none = await (await call('GET', '/together/relay/probe', undefined, {})).json();
    expect(none.ok).toBe(false);
  });

  it('a wss:// probe goes through the pinned dispatcher; a loopback ws:// one does not', async () => {
    // a dispatcher whose lookup refuses everything: the probe must fail through it, never around it
    const agent = safeDispatcher((_host, _opts, cb) => cb(new Error('refused by the test lookup')));
    const dispatch = vi.spyOn(agent, 'dispatch');
    __setProbeDispatcher(agent);
    cleanups.push(() => agent.close());

    const remote = await (await call('GET', '/together/relay/probe?url=wss://relay.example', undefined, {})).json();
    expect(remote).toEqual({ ok: false, error: expect.stringMatching(/could not reach relay\.example/) });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(String((dispatch.mock.calls[0][0] as { origin?: unknown }).origin)).toBe('https://relay.example');

    const { url } = await startRelay();
    const local = await (await call('GET', `/together/relay/probe?url=${encodeURIComponent(url)}`, undefined, {})).json();
    expect(local).toEqual({ ok: true, v: 1, rooms: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('probe of a server that is not a relay says so', async () => {
    const html = await startOther('<html><body>hi</body></html>');
    const res = await (await call('GET', `/together/relay/probe?url=${encodeURIComponent(html.url)}`, undefined, {})).json();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/not an opentrench relay/) });

    const wrongJson = await startOther(JSON.stringify({ name: 'something-else', v: 1, rooms: 0 }));
    const res2 = await (await call('GET', `/together/relay/probe?url=${encodeURIComponent(wrongJson.url)}`, undefined, {})).json();
    expect(res2.ok).toBe(false);

    const huge = await startOther('x'.repeat(64 * 1024));
    const res3 = await (await call('GET', `/together/relay/probe?url=${encodeURIComponent(huge.url)}`, undefined, {})).json();
    expect(res3.ok).toBe(false);

    const down = await (await call('GET', '/together/relay/probe?url=ws://localhost:1', undefined, {})).json();
    expect(down).toEqual({ ok: false, error: expect.stringMatching(/could not reach/) });
  });
});
