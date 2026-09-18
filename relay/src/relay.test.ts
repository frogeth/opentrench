import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
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
  connect: (room: string, member: string, access?: string, hello?: Frame) => Promise<Client>;
  /** Raw socket, nothing sent yet. */
  open: () => Promise<Client>;
  stop: () => Promise<void>;
};

const harnesses: Harness[] = [];
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
  const open = () =>
    new Promise<Client>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`);
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
  const connect = async (room: string, member: string, access?: string, hello: Frame = {}) => {
    const c = await open();
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

  it('rejects v below 1 as too-old and above 1 as too-new', async () => {
    const h = await start();
    const old = await h.connect(ROOM, A, undefined, { v: 0 });
    expect(await old.next()).toEqual({ t: 'error', code: 'too-old' });
    expect(await old.closed).toBe(CLOSE_CODES['too-old']);
    const young = await h.connect(ROOM, A, undefined, { v: 2 });
    expect(await young.next()).toEqual({ t: 'error', code: 'too-new' });
    expect(await young.closed).toBe(CLOSE_CODES['too-new']);
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
    a.send({ t: 'msg', body: 'one' });
    a.send({ t: 'msg', body: 'two' });
    a.send({ t: 'msg', body: 'three' });
    // wait for the relay to have seen them: a second member echoing back proves ordering
    await new Promise((r) => setTimeout(r, 50));
    const b = await h.connect(ROOM, B);
    const w = await b.next();
    expect(w.members).toEqual([A]);
    expect(w.buffer.map((m: Frame) => m.body)).toEqual(['one', 'two', 'three']);
    expect(w.buffer.every((m: Frame) => m.from === A && typeof m.ts === 'number')).toBe(true);
  });

  it('trims the buffer by count', async () => {
    const h = await start({ bufferMax: 2 });
    const a = await h.connect(ROOM, A);
    await a.next();
    for (const body of ['one', 'two', 'three']) a.send({ t: 'msg', body });
    await new Promise((r) => setTimeout(r, 50));
    const b = await h.connect(ROOM, B);
    expect((await b.next()).buffer.map((m: Frame) => m.body)).toEqual(['two', 'three']);
  });

  it('trims the buffer by age', async () => {
    let now = 10_000_000;
    const h = await start({ bufferHours: 1, now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    a.send({ t: 'msg', body: 'old' });
    await new Promise((r) => setTimeout(r, 50));
    now += 30 * 60_000;
    a.send({ t: 'msg', body: 'fresh' });
    await new Promise((r) => setTimeout(r, 50));
    now += 45 * 60_000; // 'old' is now 75 min old, 'fresh' 45
    const b = await h.connect(ROOM, B);
    expect((await b.next()).buffer.map((m: Frame) => m.body)).toEqual(['fresh']);
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

  it('rate-limits a member with a token bucket', async () => {
    let now = 5_000_000;
    const h = await start({ msgPerSec: 1, msgBurst: 2, now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    const b = await h.connect(ROOM, B);
    await b.next();
    await a.next(); // presence
    a.send({ t: 'msg', body: 'x1' });
    a.send({ t: 'msg', body: 'x2' });
    expect((await b.next()).body).toBe('x1');
    expect((await b.next()).body).toBe('x2');
    a.send({ t: 'msg', body: 'x3' });
    expect(await a.next()).toEqual({ t: 'error', code: 'rate' });
    expect(await a.closed).toBe(CLOSE_CODES.rate);
    // a second later the bucket has a token again
    now += 1000;
    const a2 = await h.connect(ROOM, A);
    await a2.next();
    a2.send({ t: 'msg', body: 'x4' });
    // b hears A leave/rejoin presence, then the message
    const frames = [await b.next(), await b.next(), await b.next()];
    expect(frames.find((f) => f.t === 'msg')?.body).toBe('x4');
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

  it('limits hellos per IP', async () => {
    const h = await start({ helloPerMin: 2 });
    const a = await h.connect(ROOM, A);
    expect((await a.next()).t).toBe('welcome');
    const b = await h.connect(ROOM, B);
    expect((await b.next()).t).toBe('welcome');
    const c = await h.connect(ROOM, C);
    expect(await c.next()).toEqual({ t: 'error', code: 'rate' });
    expect(await c.closed).toBe(CLOSE_CODES.rate);
  });

  it('drops a room nobody has visited for idleDays, keeps one that was', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 1_000_000_000;
    const h = await start({ idleDays: 7, now: () => now });
    const a = await h.connect(ROOM, A);
    await a.next();
    const other = id();
    const b = await h.connect(other, B);
    await b.next();
    a.ws.close();
    await a.closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.relay.rooms()).toBe(2);
    now += 8 * 86_400_000;
    vi.advanceTimersByTime(10 * 60_000);
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
    expect(r.headers['access-control-allow-origin']).toBe('*');
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
    await h.stop(); // close() flushes the debounced write
    harnesses.pop();
    const file = path.join(dir, `${ROOM}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.buffer.map((m: Frame) => m.body)).toEqual(['kept']);
    expect(typeof saved.lastSeen).toBe('number');

    const logs: string[] = [];
    fs.writeFileSync(path.join(dir, `${id()}.json`), '{corrupt');
    const h2 = await start({ dataDir: dir, log: (m) => logs.push(m) });
    expect(h2.relay.rooms()).toBe(1);
    expect(logs.some((l) => /corrupt|skip/i.test(l))).toBe(true);
    const c = await h2.connect(ROOM, C);
    const w = await c.next();
    expect(w.members).toEqual([]);
    expect(w.buffer).toEqual([{ from: A, body: 'kept', ts: saved.buffer[0].ts }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
