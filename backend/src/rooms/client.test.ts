import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createRelay, type Relay, type RelayOptions } from 'opentrench-relay/src/relay.js';
import type { TokenInfo } from '../types.js';
import { RoomClient, type RoomClientOptions, type RoomState } from './client.js';
import { newMemberId, newRoomKey, roomIdOf, seal } from './crypto.js';

// Fast backoff so the reconnect tests finish in well under a second.
const FAST = { min: 50, max: 200 };

type Harness = {
  port: number;
  url: string;
  relay: Relay;
  server: http.Server;
  /** Kills every TCP connection the relay holds, as a relay crash or a dropped link would. */
  dropConnections: () => void;
  stop: () => Promise<void>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startRelay(opts: RelayOptions = {}): Promise<Harness> {
  const relay = createRelay(opts);
  const server = http.createServer();
  relay.attach(server);
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const h: Harness = {
    port,
    url: `ws://127.0.0.1:${port}`,
    relay,
    server,
    dropConnections: () => {
      for (const s of sockets) s.destroy();
    },
    stop: async () => {
      relay.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  cleanups.push(h.stop);
  return h;
}

/** A server that answers every hello with one relay error and hangs up, for the codes the real relay only gives under conditions hard to stage. */
async function fakeRelay(code: string, closeCode: number): Promise<{ url: string }> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/v1' });
  wss.on('connection', (ws) => {
    ws.on('message', () => {
      ws.send(JSON.stringify({ t: 'error', code }));
      ws.close(closeCode);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `ws://127.0.0.1:${port}` };
}

type Made = { client: RoomClient; tokens: { peer: string; token: TokenInfo }[]; states: RoomState[]; logs: string[] };

function make(h: { url: string }, key: string, name: string, extra: Partial<RoomClientOptions> = {}): Made {
  const tokens: Made['tokens'] = [];
  const states: RoomState[] = [];
  const logs: string[] = [];
  const client = new RoomClient({
    relay: h.url,
    key,
    memberId: newMemberId(),
    name: () => name,
    version: 'test',
    onToken: (peer, token) => tokens.push({ peer, token }),
    backoffMs: FAST,
    log: (m) => logs.push(m),
    ...extra,
  });
  client.on('state', (s: RoomState) => states.push(s));
  cleanups.push(() => client.stop());
  return { client, tokens, states, logs };
}

/** Resolves once `pred` holds, re-checking on every client event; rejects after `ms`. */
function until(client: RoomClient, pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const timer = setTimeout(() => {
      off();
      reject(new Error(`condition not met within ${ms}ms (state=${client.state}, members=${client.members}, lastError=${client.lastError})`));
    }, ms);
    const check = () => {
      if (!pred()) return;
      clearTimeout(timer);
      off();
      resolve();
    };
    const off = () => {
      client.off('state', check);
      client.off('members', check);
      client.off('peers', check);
    };
    client.on('state', check);
    client.on('members', check);
    client.on('peers', check);
  });
}

/** Polls `pred` for things that do not emit (onToken calls, raw sockets). */
async function poll(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connected = (m: Made) => until(m.client, () => m.client.state === 'connected');

const token = (address: string): TokenInfo =>
  ({ chain: 'solana', address, seen: 1, calledIn: ['chat'], calls: [], firstSeenTs: 1, lastCallTs: 1 }) as unknown as TokenInfo;

type Raw = {
  member: string;
  send: (body: string) => void;
  close: () => void;
  /** Frames from the relay after the welcome, in order. */
  frames: Record<string, unknown>[];
};

/** A raw relay member that speaks the wire protocol directly, for putting arbitrary bodies in a room and watching what the relay fans out. */
async function rawMember(port: number, room: string): Promise<Raw> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`);
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve());
  });
  const member = newMemberId();
  ws.send(JSON.stringify({ t: 'hello', v: 1, room, member }));
  await new Promise<void>((r) => ws.once('message', () => r())); // welcome
  const frames: Raw['frames'] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  cleanups.push(() => ws.terminate());
  return { member, send: (body) => ws.send(JSON.stringify({ t: 'msg', body })), close: () => ws.close(), frames };
}

const msgsSeen = (r: Raw) => r.frames.filter((f) => f.t === 'msg').length;

describe('RoomClient', () => {
  it('connects, reaches connected with nobody else online, and exposes the room id', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    expect(a.client.id).toBe(roomIdOf(key));
    expect(a.client.state).toBe('disconnected');
    a.client.start();
    await connected(a);
    expect(a.client.members).toBe(0);
    expect(a.states).toEqual(['connecting', 'connected']);
    expect(a.client.lastError).toBeUndefined();
  });

  it('delivers a token from B to A with B name, and A hello lands in B peers', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    const b = make(h, key, 'B');
    a.client.start();
    await connected(a);
    b.client.start();
    await connected(b);
    await until(a.client, () => a.client.members === 1);
    // B's welcome came after A's hello was buffered, and A also hears B's live hello.
    await until(b.client, () => b.client.peers.get(a.client.memberId) === 'A');
    await until(a.client, () => a.client.peers.get(b.client.memberId) === 'B');
    expect(b.client.send({ k: 'token', name: 'B', token: token('So1') })).toBe(true);
    await poll(() => a.tokens.length === 1);
    expect(a.tokens[0]!.peer).toBe('B');
    expect(a.tokens[0]!.token.address).toBe('So1');
    expect(b.tokens).toHaveLength(0); // the sender never hears its own message
  });

  it('falls back to the remembered peer name when a token carries none', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    const b = make(h, key, 'B');
    a.client.start();
    b.client.start();
    await connected(a);
    await connected(b);
    await until(a.client, () => a.client.peers.get(b.client.memberId) === 'B');
    b.client.send({ k: 'token', token: token('So2') });
    await poll(() => a.tokens.length === 1);
    expect(a.tokens[0]!.peer).toBe('B');
  });

  it('replays the buffer on join: a token sent before B connected reaches B', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    a.client.start();
    await connected(a);
    // A raw member sees the relay fan A's token out, which proves it is in the buffer before B dials.
    const watcher = await rawMember(h.port, a.client.id);
    expect(a.client.send({ k: 'token', name: 'A', token: token('So3') })).toBe(true);
    await poll(() => msgsSeen(watcher) === 1);
    const b = make(h, key, 'B');
    b.client.start();
    await connected(b);
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0]).toMatchObject({ peer: 'A', token: { address: 'So3' } });
    expect(b.client.peers.get(a.client.memberId)).toBe('A');
    expect(b.client.members).toBe(2);
  });

  it('drops a token that fails the sanity check and truncates long peer names', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    a.client.start();
    await connected(a);
    const raw = await rawMember(h.port, a.client.id);
    raw.send(seal(key, a.client.id, { k: 'hello', name: 'x'.repeat(100), v: 'test' }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: { address: 42, chain: 'solana', calls: [] } }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: { address: 'So4', chain: 'solana' } }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: { address: 'So4', calls: [] } }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: token('So5') }));
    await poll(() => a.tokens.length === 1);
    expect(a.tokens[0]!.token.address).toBe('So5');
    expect(a.client.peers.get(raw.member)).toBe('x'.repeat(64));
  });

  describe('undecryptable messages', () => {
    it('mutes a sender after three failures without touching state or delivery from others', async () => {
      const h = await startRelay();
      const key = newRoomKey();
      const other = newRoomKey();
      const a = make(h, key, 'A');
      const b = make(h, key, 'B');
      a.client.start();
      b.client.start();
      await connected(a);
      await connected(b);
      await until(a.client, () => a.client.peers.get(b.client.memberId) === 'B');
      const bad = await rawMember(h.port, a.client.id);
      for (let i = 0; i < 4; i++) bad.send(seal(other, a.client.id, { k: 'token', name: 'X', token: token('bad' + i) }));
      // A message the muted sender can decrypt is dropped too: it forfeited the connection.
      bad.send(seal(key, a.client.id, { k: 'token', name: 'X', token: token('bad-good') }));
      b.client.send({ k: 'token', name: 'B', token: token('So6') });
      await poll(() => a.tokens.length === 1);
      expect(a.tokens[0]!.token.address).toBe('So6');
      expect(a.client.state).toBe('connected');
      expect(a.states).not.toContain('key-mismatch');
      expect(a.client.lastError).toBeUndefined();
      expect(a.logs.filter((m) => /undecryptable/.test(m))).toHaveLength(1); // logged once per sender
      // ...and the mute is per sender: a second bad sender gets its own count, B is untouched.
      const bad2 = await rawMember(h.port, a.client.id);
      bad2.send(seal(other, a.client.id, { k: 'token' }));
      b.client.send({ k: 'token', name: 'B', token: token('So7') });
      await poll(() => a.tokens.length === 2);
      expect(a.tokens[1]!.token.address).toBe('So7');
    });

    it('a replay with nothing readable from two or more senders sets lastError but still connects', async () => {
      const h = await startRelay();
      const key = newRoomKey();
      const other = newRoomKey();
      const id = roomIdOf(key);
      const x = await rawMember(h.port, id);
      const y = await rawMember(h.port, id);
      x.send(seal(other, id, { k: 'token' }));
      x.send(seal(other, id, { k: 'token' }));
      y.send(seal(other, id, { k: 'token' }));
      await poll(() => msgsSeen(y) === 2 && msgsSeen(x) === 1);
      const a = make(h, key, 'A');
      a.client.start();
      await connected(a);
      expect(a.tokens).toHaveLength(0);
      expect(a.states).toEqual(['connecting', 'connected']);
      expect(a.client.lastError).toBe('3 messages from 2 members did not decrypt');
      expect(a.client.members).toBe(2);
    });

    it('a replay with garbage from a single sender is that sender problem: no lastError', async () => {
      const h = await startRelay();
      const key = newRoomKey();
      const other = newRoomKey();
      const id = roomIdOf(key);
      const x = await rawMember(h.port, id);
      const watcher = await rawMember(h.port, id);
      for (let i = 0; i < 3; i++) x.send(seal(other, id, { k: 'token' }));
      await poll(() => msgsSeen(watcher) === 3);
      const a = make(h, key, 'A');
      a.client.start();
      await connected(a);
      expect(a.client.lastError).toBeUndefined();
    });
  });

  it('reports access-denied when the relay wants a code the client does not have', async () => {
    const h = await startRelay({ accessCode: 'secret' });
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'access-denied');
    await sleep(50); // the close that follows the error frame must not flip it back
    expect(a.client.state).toBe('access-denied');
    const b = make(h, newRoomKey(), 'B', { access: 'secret' });
    b.client.start();
    await connected(b);
  });

  it('reports relay-too-old when the relay answers too-old', async () => {
    const a = make(await fakeRelay('too-old', 4001), newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'relay-too-old');
    await sleep(50);
    expect(a.client.state).toBe('relay-too-old');
  });

  it('reports a newer relay as disconnected with a readable error', async () => {
    const a = make(await fakeRelay('too-new', 4002), newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'disconnected' && /newer protocol/.test(a.client.lastError ?? ''));
  });

  it('retries a bad error on the normal backoff, not the slow one', async () => {
    const a = make(await fakeRelay('bad', 4006), newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.states.filter((s) => s === 'connecting').length >= 3, 2000);
    expect(a.client.lastError).toMatch(/malformed/);
  });

  it('turns a malformed relay URL into disconnected with an error and keeps retrying', async () => {
    const a = make({ url: 'wss://' }, newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'disconnected');
    expect(a.client.lastError).toBeDefined();
    await until(a.client, () => a.states.filter((s) => s === 'connecting').length >= 2);
  });

  it('reconnects after the relay drops the socket and reaches connected again', async () => {
    const h = await startRelay();
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await connected(a);
    h.dropConnections();
    await until(a.client, () => a.client.state === 'disconnected');
    await connected(a);
    expect(a.states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
  });

  it('keeps retrying with backoff while the relay is down, then connects when it is back', async () => {
    const h = await startRelay();
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await connected(a);
    await h.stop();
    cleanups.splice(cleanups.indexOf(h.stop), 1);
    await until(a.client, () => a.client.state === 'disconnected');
    await until(a.client, () => a.states.filter((s) => s === 'connecting').length >= 3);
    expect(a.client.state).not.toBe('connected');
    expect(a.client.lastError).toBeDefined();
    // Same port again so the client's URL still points somewhere.
    const relay = createRelay();
    const server = http.createServer();
    relay.attach(server);
    await new Promise<void>((r) => server.listen(h.port, '127.0.0.1', r));
    cleanups.push(async () => {
      relay.close();
      await new Promise<void>((r) => server.close(() => r()));
    });
    await connected(a);
  });

  it('stop() sends bye so the other side forgets the name, and does not reconnect', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    const b = make(h, key, 'B');
    a.client.start();
    b.client.start();
    await connected(a);
    await connected(b);
    await until(a.client, () => a.client.peers.get(b.client.memberId) === 'B');
    b.client.stop();
    expect(b.client.state).toBe('disconnected');
    await until(a.client, () => !a.client.peers.has(b.client.memberId));
    await until(a.client, () => a.client.members === 0);
    await sleep(FAST.max + 100); // long enough for a reconnect that must not happen
    expect(b.client.state).toBe('disconnected');
    expect(a.client.members).toBe(0);
  });

  it('reconnect() does not resurrect a stopped client', async () => {
    const h = await startRelay();
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await connected(a);
    a.client.stop();
    a.client.reconnect();
    expect(a.client.state).toBe('disconnected');
    await sleep(FAST.max + 100);
    expect(a.client.state).toBe('disconnected');
    expect(a.states.filter((s) => s === 'connecting')).toHaveLength(1);
  });

  it('send() returns false when not connected', async () => {
    const h = await startRelay();
    const a = make(h, newRoomKey(), 'A');
    expect(a.client.send({ k: 'token' })).toBe(false);
    a.client.start();
    await connected(a);
    expect(a.client.send({ k: 'token', name: 'A', token: token('So7') })).toBe(true);
    a.client.stop();
    expect(a.client.send({ k: 'token' })).toBe(false);
  });

  describe('send pacing', () => {
    it('paces a burst under the relay limit and keeps order', async () => {
      // A relay that would refuse an unpaced burst of 100 (burst 10) but refills faster than the client sends.
      const h = await startRelay({ msgPerSec: 200, msgBurst: 10 });
      const key = newRoomKey();
      const a = make(h, key, 'A', { paceMs: 10 });
      const b = make(h, key, 'B', { paceMs: 10 });
      a.client.start();
      b.client.start();
      await connected(a);
      await connected(b);
      for (let i = 0; i < 100; i++) expect(a.client.send({ k: 'token', name: 'A', token: token('So' + i) })).toBe(true);
      expect(a.client.pending).toBeGreaterThan(0);
      await poll(() => b.tokens.length === 100, 5000);
      expect(b.tokens.map((t) => t.token.address)).toEqual(Array.from({ length: 100 }, (_, i) => 'So' + i));
      expect(a.client.state).toBe('connected');
      expect(a.states).toEqual(['connecting', 'connected']); // no rate error, no reconnect
      expect(a.client.pending).toBe(0);
    });

    it('caps the queue at 500, dropping the oldest and logging once', async () => {
      const h = await startRelay();
      const a = make(h, newRoomKey(), 'A', { paceMs: 10_000 });
      a.client.start();
      await connected(a);
      for (let i = 0; i < 602; i++) a.client.send({ k: 'token', name: 'A', token: token('So' + i) });
      // one went out on the spot, 500 are waiting, the rest were dropped from the front
      expect(a.client.pending).toBe(500);
      expect(a.logs.filter((m) => /queue/.test(m))).toHaveLength(1);
      a.client.stop();
      expect(a.client.pending).toBe(0);
    });

    it('drops the queue when the connection goes', async () => {
      const h = await startRelay();
      const a = make(h, newRoomKey(), 'A', { paceMs: 10_000 });
      a.client.start();
      await connected(a);
      for (let i = 0; i < 5; i++) a.client.send({ k: 'token', name: 'A', token: token('So' + i) });
      expect(a.client.pending).toBe(4);
      h.dropConnections();
      await until(a.client, () => a.client.state === 'disconnected');
      expect(a.client.pending).toBe(0);
    });
  });

  it('members follows presence as a third client joins and leaves', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    const b = make(h, key, 'B');
    a.client.start();
    b.client.start();
    await connected(a);
    await connected(b);
    await until(a.client, () => a.client.members === 1);
    const c = make(h, key, 'C');
    c.client.start();
    await connected(c);
    expect(c.client.members).toBe(2);
    await until(a.client, () => a.client.members === 2);
    c.client.stop();
    await until(a.client, () => a.client.members === 1);
    await until(b.client, () => b.client.members === 1);
  });

  describe('rotated', () => {
    it('a member announcing a rotation puts every other member in key-mismatch, for good', async () => {
      const h = await startRelay();
      const key = newRoomKey();
      const a = make(h, key, 'A');
      const b = make(h, key, 'B');
      a.client.start();
      b.client.start();
      await connected(a);
      await connected(b);
      await until(a.client, () => a.client.members === 1);
      expect(a.client.announceRotation()).toBe(true);
      await until(b.client, () => b.client.state === 'key-mismatch');
      expect(b.client.lastError).toMatch(/rotated|new invite/);
      expect(b.client.members).toBe(0);
      expect(b.client.peers.size).toBe(0);
      expect(b.client.send({ k: 'token' })).toBe(false);
      // the sender itself is untouched: the manager stops it a moment later
      expect(a.client.state).toBe('connected');
      // terminal: no reconnect on the backoff, and neither reconnect() nor start() brings it back
      b.client.reconnect();
      b.client.start();
      await sleep(FAST.max + 100);
      expect(b.client.state).toBe('key-mismatch');
      expect(b.states).toEqual(['connecting', 'connected', 'key-mismatch']);
      // the relay saw B go
      await until(a.client, () => a.client.members === 0);
      // stop() (the user pressed Leave) still works
      b.client.stop();
      expect(b.client.state).toBe('disconnected');
    });

    it('a rotation replayed from the buffer counts the same: a member who was away never reaches connected', async () => {
      const h = await startRelay();
      const key = newRoomKey();
      const id = roomIdOf(key);
      const raw = await rawMember(h.port, id);
      const watcher = await rawMember(h.port, id);
      raw.send(seal(key, id, { k: 'token', name: 'X', token: token('So8') }));
      raw.send(seal(key, id, { k: 'rotated' }));
      await poll(() => msgsSeen(watcher) === 2);
      const b = make(h, key, 'B');
      b.client.start();
      await until(b.client, () => b.client.state === 'key-mismatch');
      await sleep(FAST.max + 100);
      expect(b.states).toEqual(['connecting', 'key-mismatch']);
      expect(b.tokens.map((t) => t.token.address)).toEqual(['So8']); // what came before it still counts
    });

    it('announceRotation() is a no-op when not connected', async () => {
      const h = await startRelay();
      const a = make(h, newRoomKey(), 'A');
      expect(a.client.announceRotation()).toBe(false);
    });
  });

  it('reconnect() drops the current socket and dials again', async () => {
    const h = await startRelay();
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await connected(a);
    a.client.reconnect();
    expect(a.client.state).toBe('connecting');
    await connected(a);
    expect(a.states.filter((s) => s === 'connected')).toHaveLength(2);
  });
});
