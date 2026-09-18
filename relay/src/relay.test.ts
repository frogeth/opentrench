import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { readEnv } from './env.js';
import { CLOSE_CODES, createRelay, type Relay, type RelayOptions } from './relay.js';

const id = () => randomBytes(16).toString('base64url'); // 22 chars, same shape the app uses
const ROOM = id();
const A = id();
const B = id();
const C = id();

type Frame = Record<string, any>;
type Client = {
  ws: WebSocket;
  /** Next frame from the relay, in order. */
  next: (ms?: number) => Promise<Frame>;
  /** Resolves with the close code once the relay hangs up. */
  closed: Promise<number>;
  send: (frame: Frame) => void;
};

type Harness = {
  port: number;
  relay: Relay;
  server: http.Server;
  connect: (room: string, member: string, access?: string, hello?: Frame, headers?: Record<string, string>) => Promise<Client>;
  /** Raw socket, nothing sent yet. */
  open: (headers?: Record<string, string>) => Promise<Client>;
  stop: () => Promise<void>;
};

const harnesses: Harness[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A member already in the room hears each body in turn: proves the relay has processed them, in that order. */
const hears = async (c: Client, bodies: string[]) => {
  for (const body of bodies) expect((await c.next()).body).toBe(body);
};
afterEach(async () => {
  vi.useRealTimers();
  while (harnesses.length) await harnesses.pop()!.stop();
});

async function start(opts: RelayOptions = {}): Promise<Harness> {
  const relay = createRelay(opts);
  const server = http.createServer();
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const clients: Client[] = [];
  const open = (headers: Record<string, string> = {}) =>
    new Promise<Client>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, { headers });
      const queue: Frame[] = [];
      const waiters: ((f: Frame) => void)[] = [];
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString());
        const w = waiters.shift();
        if (w) w(f);
        else queue.push(f);
      });
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      const next = (ms = 2000) =>
        new Promise<Frame>((res, rej) => {
          const q = queue.shift();
          if (q) return res(q);
          const t = setTimeout(() => rej(new Error('no frame within ' + ms + 'ms')), ms);
          waiters.push((f) => {
            clearTimeout(t);
            res(f);
          });
        });
      const c: Client = { ws, next, closed, send: (f) => ws.send(JSON.stringify(f)) };
      ws.once('error', reject);
      ws.once('open', () => {
        clients.push(c);
        resolve(c);
      });
    });
  const connect = async (room: string, member: string, access?: string, hello: Frame = {}, headers?: Record<string, string>) => {
    const c = await open(headers);
    c.send({ t: 'hello', v: 1, room, member, ...(access !== undefined ? { access } : {}), ...hello });
    return c;
  };
  const stop = async () => {
    for (const c of clients) c.ws.terminate();
    relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  const h = { port, relay, server, connect, open, stop };
  harnesses.push(h);
  return h;
}

describe('hello and welcome', () => {
  it('answers a good hello with who is here and an empty buffer', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    expect(await a.next()).toEqual({ t: 'welcome', v: 1, members: [], buffer: [] });
    expect(h.relay.rooms()).toBe(1);
    const b = await h.connect(ROOM, B);
    expect(await b.next()).toEqual({ t: 'welcome', v: 1, members: [A], buffer: [] });
  });

  it('names the side that is behind: an app above the relay gets too-old (the relay is), one below it too-new (the relay is)', async () => {
    const h = await start();
    const newerApp = await h.connect(ROOM, A, undefined, { v: 2 });
    expect(await newerApp.next()).toEqual({ t: 'error', code: 'too-old' });
    expect(await newerApp.closed).toBe(CLOSE_CODES['too-old']);
    const olderApp = await h.connect(ROOM, A, undefined, { v: 0 });
    expect(await olderApp.next()).toEqual({ t: 'error', code: 'too-new' });
    expect(await olderApp.closed).toBe(CLOSE_CODES['too-new']);
  });

  it('rejects a bad first frame: not hello, malformed ids, not JSON', async () => {
    const h = await start();
    const notHello = await h.open();
    notHello.send({ t: 'msg', body: 'abc' });
    expect(await notHello.next()).toEqual({ t: 'error', code: 'bad' });
    expect(await notHello.closed).toBe(CLOSE_CODES.bad);
    const shortRoom = await h.connect('short', A);
    expect(await shortRoom.next()).toEqual({ t: 'error', code: 'bad' });
    const badMember = await h.connect(ROOM, 'not base64url!!!!!!!!!');
    expect(await badMember.next()).toEqual({ t: 'error', code: 'bad' });
    const junk = await h.open();
    junk.ws.send('{nope');
    expect(await junk.next()).toEqual({ t: 'error', code: 'bad' });
    expect(h.relay.rooms()).toBe(0);
  });

  it('ignores frames after a rejected hello: a good hello on the same socket makes no room', async () => {
    const h = await start();
    const c = await h.open();
    c.send({ t: 'hello', v: 2, room: ROOM, member: A });
    c.send({ t: 'hello', v: 1, room: ROOM, member: A });
    expect(await c.next()).toEqual({ t: 'error', code: 'too-old' });
    expect(await c.closed).toBe(CLOSE_CODES['too-old']);
    await expect(c.next(100)).rejects.toThrow(/no frame/);
    expect(h.relay.rooms()).toBe(0);
  });

  it('rejects an unknown frame type after hello', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    await a.next();
    a.send({ t: 'wat' });
    expect(await a.next()).toEqual({ t: 'error', code: 'bad' });
    expect(await a.closed).toBe(CLOSE_CODES.bad);
  });
});

describe('access code', () => {
  it('lets the right code in, refuses a wrong or missing one', async () => {
    const h = await start({ accessCode: 'secret' });
    const ok = await h.connect(ROOM, A, 'secret');
    expect((await ok.next()).t).toBe('welcome');
    const wrong = await h.connect(ROOM, B, 'nope');
    expect(await wrong.next()).toEqual({ t: 'error', code: 'access' });
    expect(await wrong.closed).toBe(CLOSE_CODES.access);
    const missing = await h.connect(ROOM, C);
    expect(await missing.next()).toEqual({ t: 'error', code: 'access' });
  });

  it('ignores the field when no code is configured', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A, 'whatever');
    expect((await a.next()).t).toBe('welcome');
  });
});

describe('messages', () => {
  it('fans out to every other member, not the sender, and stamps from and ts', async () => {
    let now = 1_000_000;
    const h = await start({ now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    await a.next(); // presence: B joined
    const c = await h.connect(ROOM, C);
    await c.next();
    await a.next();
    await b.next();
    now = 1_000_500;
    a.send({ t: 'msg', body: 'Y2lwaGVy' });
    expect(await b.next()).toEqual({ t: 'msg', from: A, body: 'Y2lwaGVy', ts: 1_000_500 });
    expect(await c.next()).toEqual({ t: 'msg', from: A, body: 'Y2lwaGVy', ts: 1_000_500 });
    await expect(a.next(150)).rejects.toThrow(/no frame/);
  });

  it('replays the buffer in order to a late joiner', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    await a.next();
    const c = await h.connect(ROOM, C);
    await c.next();
    await a.next(); // presence
    a.send({ t: 'msg', body: 'one' });
    a.send({ t: 'msg', body: 'two' });
    a.send({ t: 'msg', body: 'three' });
    await hears(c, ['one', 'two', 'three']);
    const b = await h.connect(ROOM, B);
    const w = await b.next();
    expect(w.members).toEqual([A, C]);
    expect(w.buffer.map((m: Frame) => m.body)).toEqual(['one', 'two', 'three']);
    expect(w.buffer.every((m: Frame) => m.from === A && typeof m.ts === 'number')).toBe(true);
  });

  it('trims the buffer by count', async () => {
    const h = await start({ bufferMax: 2 });
    const a = await h.connect(ROOM, A);
    await a.next();
    const c = await h.connect(ROOM, C);
    await c.next();
    await a.next();
    for (const body of ['one', 'two', 'three']) a.send({ t: 'msg', body });
    await hears(c, ['one', 'two', 'three']);
    const b = await h.connect(ROOM, B);
    expect((await b.next()).buffer.map((m: Frame) => m.body)).toEqual(['two', 'three']);
  });

  it('trims the buffer by age', async () => {
    let now = 10_000_000;
    const h = await start({ bufferHours: 1, now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    const c = await h.connect(ROOM, C);
    await c.next();
    await a.next();
    a.send({ t: 'msg', body: 'old' });
    await hears(c, ['old']);
    now += 30 * 60_000;
    a.send({ t: 'msg', body: 'fresh' });
    await hears(c, ['fresh']);
    now += 45 * 60_000; // 'old' is now 75 min old, 'fresh' 45
    const b = await h.connect(ROOM, B);
    expect((await b.next()).buffer.map((m: Frame) => m.body)).toEqual(['fresh']);
  });

  it('trims the buffer by bytes, oldest first; a body over the cap on its own is fanned out but not kept', async () => {
    const h = await start({ bufferBytes: 10 });
    const a = await h.connect(ROOM, A);
    await a.next();
    const c = await h.connect(ROOM, C);
    await c.next();
    await a.next();
    for (const body of ['aaaa', 'bbbb', 'cccc']) a.send({ t: 'msg', body });
    await hears(c, ['aaaa', 'bbbb', 'cccc']);
    const b = await h.connect(ROOM, B);
    expect((await b.next()).buffer.map((m: Frame) => m.body)).toEqual(['bbbb', 'cccc']);
    await a.next(); // presence: B joined
    await c.next();
    a.send({ t: 'msg', body: 'x'.repeat(11) });
    await hears(c, ['x'.repeat(11)]);
    expect((await b.next()).body).toBe('x'.repeat(11));
    const d = await h.connect(ROOM, id());
    expect((await d.next()).buffer).toEqual([]);
  });

  it('rejects a body that is not base64url', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    await a.next();
    a.send({ t: 'msg', body: 'not base64url!' });
    expect(await a.next()).toEqual({ t: 'error', code: 'bad' });
  });

  it('rejects a frame over maxMessageBytes', async () => {
    const h = await start({ maxMessageBytes: 200 });
    const a = await h.connect(ROOM, A);
    await a.next();
    a.send({ t: 'msg', body: 'a'.repeat(300) });
    expect(await a.next()).toEqual({ t: 'error', code: 'bad' });
    expect(await a.closed).toBe(CLOSE_CODES.bad);
  });

  it('rate-limits a member with a token bucket that survives a reconnect', async () => {
    let now = 5_000_000;
    const h = await start({ msgPerSec: 1, msgBurst: 2, now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    await a.next(); // presence
    a.send({ t: 'msg', body: 'x1' });
    a.send({ t: 'msg', body: 'x2' });
    await hears(b, ['x1', 'x2']);
    a.send({ t: 'msg', body: 'x3' });
    expect(await a.next()).toEqual({ t: 'error', code: 'rate' });
    expect(await a.closed).toBe(CLOSE_CODES.rate);
    expect((await b.next()).t).toBe('presence');
    // reconnecting at once does not hand out a fresh burst: the bucket lives in the room
    const again = await h.connect(ROOM, A);
    await again.next();
    expect((await b.next()).t).toBe('presence');
    again.send({ t: 'msg', body: 'x4' });
    expect(await again.next()).toEqual({ t: 'error', code: 'rate' });
    await again.closed;
    expect((await b.next()).t).toBe('presence');
    // a second later one token has refilled
    now += 1000;
    const later = await h.connect(ROOM, A);
    await later.next();
    expect((await b.next()).t).toBe('presence');
    later.send({ t: 'msg', body: 'x5' });
    expect((await b.next()).body).toBe('x5');
  });
});

describe('presence', () => {
  it('tells the room when someone joins and leaves, listing each member once', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    expect(await a.next()).toEqual({ t: 'presence', members: [A, B] });
    // the same member on a second device: still one entry
    const b2 = await h.connect(ROOM, B);
    expect((await b2.next()).members).toEqual([A]);
    expect((await a.next()).members).toEqual([A, B]);
    b.ws.close();
    // B still has a device online, so nothing changes for A yet
    b2.ws.close();
    let seen: Frame;
    do seen = await a.next();
    while (seen.members.includes(B));
    expect(seen).toEqual({ t: 'presence', members: [A] });
  });
});

describe('limits', () => {
  it('refuses a member beyond maxMembers', async () => {
    const h = await start({ maxMembers: 2 });
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    const c = await h.connect(ROOM, C);
    expect(await c.next()).toEqual({ t: 'error', code: 'full' });
    expect(await c.closed).toBe(CLOSE_CODES.full);
    // a member already in the room may add a device though
    const a2 = await h.connect(ROOM, A);
    expect((await a2.next()).t).toBe('welcome');
  });

  it('refuses a new room beyond maxRooms, but not a known one', async () => {
    const h = await start({ maxRooms: 1 });
    const a = await h.connect(ROOM, A);
    await a.next();
    const other = await h.connect(id(), B);
    expect(await other.next()).toEqual({ t: 'error', code: 'full' });
    const again = await h.connect(ROOM, B);
    expect((await again.next()).t).toBe('welcome');
  });

  it('limits hellos to helloPerMin per rolling minute per IP', async () => {
    let now = 7_000_000;
    const h = await start({ helloPerMin: 2, now: () => now });
    const a = await h.connect(ROOM, A);
    expect((await a.next()).t).toBe('welcome');
    now += 30_000;
    const b = await h.connect(ROOM, B);
    expect((await b.next()).t).toBe('welcome');
    const c = await h.connect(ROOM, C);
    expect(await c.next()).toEqual({ t: 'error', code: 'rate' });
    expect(await c.closed).toBe(CLOSE_CODES.rate);
    now += 30_001; // the first hello has left the window, one slot is free again
    const d = await h.connect(ROOM, C);
    expect((await d.next()).t).toBe('welcome');
    const e = await h.connect(ROOM, id());
    expect(await e.next()).toEqual({ t: 'error', code: 'rate' });
  });

  it('caps sockets that have not said hello at 16 per IP, and frees the slot once one does or closes', async () => {
    const h = await start({ helloPerMin: 100 });
    const idle: Client[] = [];
    for (let i = 0; i < 16; i++) idle.push(await h.open());
    const over = await h.open();
    expect(await over.next()).toEqual({ t: 'error', code: 'rate' });
    expect(await over.closed).toBe(CLOSE_CODES.rate);
    // one of them joins a room: it no longer counts, so the next newcomer is let in and left to say hello
    idle[0]!.send({ t: 'hello', v: 1, room: ROOM, member: A });
    expect((await idle[0]!.next()).t).toBe('welcome');
    const next = await h.open();
    await expect(next.next(100)).rejects.toThrow(/no frame/);
    // ...and a closed one frees its slot too
    idle[1]!.ws.close();
    await idle[1]!.closed;
    await sleep(20);
    const another = await h.open();
    await expect(another.next(100)).rejects.toThrow(/no frame/);
  });

  it('ignores forwarding headers unless trustProxy is on', async () => {
    const h = await start({ helloPerMin: 1 });
    const a = await h.connect(ROOM, A, undefined, {}, { 'x-forwarded-for': '1.1.1.1', 'fly-client-ip': '1.1.1.1' });
    expect((await a.next()).t).toBe('welcome');
    const b = await h.connect(ROOM, B, undefined, {}, { 'x-forwarded-for': '2.2.2.2', 'fly-client-ip': '2.2.2.2' });
    expect(await b.next()).toEqual({ t: 'error', code: 'rate' });
  });

  it('with trustProxy takes fly-client-ip, else the last x-forwarded-for entry', async () => {
    const h = await start({ helloPerMin: 1, trustProxy: true });
    const a = await h.connect(ROOM, A, undefined, {}, { 'fly-client-ip': '1.1.1.1' });
    expect((await a.next()).t).toBe('welcome');
    const b = await h.connect(ROOM, B, undefined, {}, { 'fly-client-ip': '2.2.2.2' });
    expect((await b.next()).t).toBe('welcome');
    // the client-chosen first entry is spoofable; the proxy appends the real one last
    const c = await h.connect(ROOM, C, undefined, {}, { 'x-forwarded-for': '9.9.9.9, 3.3.3.3' });
    expect((await c.next()).t).toBe('welcome');
    const d = await h.connect(ROOM, id(), undefined, {}, { 'x-forwarded-for': '8.8.8.8, 3.3.3.3' });
    expect(await d.next()).toEqual({ t: 'error', code: 'rate' });
    const e = await h.connect(ROOM, id(), undefined, {}, { 'x-forwarded-for': '3.3.3.3, 4.4.4.4' });
    expect((await e.next()).t).toBe('welcome');
  });

  it('drops a room nobody has visited for idleDays, keeps one that was', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const base = 1_000_000_000;
    let offset = 0;
    const h = await start({ idleDays: 7, now: () => base + offset });
    const a = await h.connect(ROOM, A);
    await a.next();
    const other = id();
    const b = await h.connect(other, B);
    await b.next();
    a.ws.close();
    await a.closed;
    // The relay sees the close a beat after the client does, and its leave
    // stamps lastSeen with now(): jump the clock only inside each sweep tick
    // (synchronous), so the leave itself always lands at `base`.
    for (let i = 0; i < 100 && h.relay.rooms() === 2; i++) {
      offset = 8 * 86_400_000;
      vi.advanceTimersByTime(10 * 60_000);
      offset = 0;
      if (h.relay.rooms() === 2) await sleep(5);
    }
    expect(h.relay.rooms()).toBe(1); // the one B still sits in
  });
});

describe('http', () => {
  const get = (port: number, p: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }).on('error', reject);
    });

  it('GET / reports name, version and room count', async () => {
    const h = await start();
    const a = await h.connect(ROOM, A);
    await a.next();
    const r = await get(h.port, '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(r.body)).toEqual({ name: 'opentrench-relay', v: 1, rooms: 1 });
  });

  it('GET /v1 without an upgrade is 426, anything else 404', async () => {
    const h = await start();
    expect((await get(h.port, '/v1')).status).toBe(426);
    const r = await get(h.port, '/nope');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toBe('application/json');
  });
});

describe('http robustness', () => {
  const raw = (port: number, request: string) =>
    new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(request));
      let out = '';
      sock.on('data', (d) => (out += d));
      sock.on('close', () => resolve(out));
      sock.on('error', reject);
      setTimeout(() => sock.destroy(), 500).unref();
    });

  it('survives an absolute-form request target that URL parsing would throw on', async () => {
    const h = await start();
    for (const target of ['http://[/', 'http://[/v1', '*', 'nonsense']) {
      await raw(h.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      await raw(h.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    }
    const a = await h.connect(ROOM, A);
    expect((await a.next()).t).toBe('welcome');
  });
});

describe('env', () => {
  it('reads the documented variables, falls back with a warning on junk', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(readEnv({}, warn)).toEqual({ port: 8080, options: { trustProxy: false } });
    const r = readEnv({ PORT: '9000', RELAY_ACCESS_CODE: 'sesame', RELAY_MAX_ROOMS: '5', RELAY_MAX_MEMBERS: '3', RELAY_DATA_DIR: '/data', RELAY_BUFFER_HOURS: '48', RELAY_BUFFER_BYTES: '1048576', RELAY_TRUST_PROXY: '1' }, warn);
    expect(r).toEqual({ port: 9000, options: { accessCode: 'sesame', maxRooms: 5, maxMembers: 3, dataDir: '/data', bufferHours: 48, bufferBytes: 1048576, trustProxy: true } });
    expect(warnings).toEqual([]);
    const bad = readEnv({ PORT: '0', RELAY_MAX_ROOMS: 'lots', RELAY_MAX_MEMBERS: '-1', RELAY_BUFFER_HOURS: '1.5', RELAY_BUFFER_BYTES: '4MB', RELAY_TRUST_PROXY: 'yes' }, warn);
    expect(bad).toEqual({ port: 8080, options: { trustProxy: false } });
    expect(warnings).toHaveLength(6);
    expect(warnings.some((w) => /PORT="0"/.test(w))).toBe(true);
  });
});

describe('persistence', () => {
  it('writes each room to dataDir and loads it back on the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentrench-relay-'));
    const h = await start({ dataDir: dir });
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    a.send({ t: 'msg', body: 'kept' });
    expect((await b.next()).body).toBe('kept');
    const file = path.join(dir, `${ROOM}.json`);
    expect(fs.existsSync(file)).toBe(false); // debounced, not on every message
    await sleep(2300);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.buffer.map((m: Frame) => m.body)).toEqual(['kept']);
    a.send({ t: 'msg', body: 'later' });
    expect((await b.next()).body).toBe('later');
    await h.stop(); // close() flushes what the debounce still holds
    harnesses.pop();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.buffer.map((m: Frame) => m.body)).toEqual(['kept', 'later']);
    expect(typeof saved.lastSeen).toBe('number');

    const logs: string[] = [];
    fs.writeFileSync(path.join(dir, `${id()}.json`), '{corrupt');
    const h2 = await start({ dataDir: dir, log: (m) => logs.push(m) });
    expect(h2.relay.rooms()).toBe(1);
    expect(logs.some((l) => /corrupt|skip/i.test(l))).toBe(true);
    const c = await h2.connect(ROOM, C);
    const w = await c.next();
    expect(w.members).toEqual([]);
    expect(w.buffer).toEqual(saved.buffer);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it('trims a loaded buffer by count and age', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentrench-relay-'));
    const now = 50_000_000_000;
    const entry = (body: string, ts: number) => ({ from: A, body, ts });
    fs.writeFileSync(path.join(dir, `${ROOM}.json`), JSON.stringify({ buffer: [entry('stale', now - 3_600_000 * 2), entry('one', now - 1000), entry('two', now - 900), entry('three', now - 800)], lastSeen: now }));
    const h = await start({ dataDir: dir, bufferMax: 2, bufferHours: 1, now: () => now });
    const c = await h.connect(ROOM, C);
    expect((await c.next()).buffer.map((m: Frame) => m.body)).toEqual(['two', 'three']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
