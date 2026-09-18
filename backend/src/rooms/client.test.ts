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

type Made = { client: RoomClient; tokens: { peer: string; token: TokenInfo }[]; states: RoomState[] };

function make(h: { url: string }, key: string, name: string, extra: Partial<RoomClientOptions> = {}): Made {
  const tokens: Made['tokens'] = [];
  const states: RoomState[] = [];
  const client = new RoomClient({
    relay: h.url,
    key,
    memberId: newMemberId(),
    name: () => name,
    version: 'test',
    onToken: (peer, token) => tokens.push({ peer, token }),
    backoffMs: FAST,
    ...extra,
  });
  client.on('state', (s: RoomState) => states.push(s));
  cleanups.push(() => client.stop());
  return { client, tokens, states };
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

/** Polls `pred` for things that do not emit (onToken calls). */
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

/** A raw relay member that speaks the wire protocol directly, for putting arbitrary bodies in a room. */
async function rawMember(port: number, room: string): Promise<{ send: (body: string) => void; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`);
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve());
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, room, member: newMemberId() }));
  await new Promise<void>((r) => ws.once('message', () => r())); // welcome
  cleanups.push(() => ws.terminate());
  return { send: (body) => ws.send(JSON.stringify({ t: 'msg', body })), close: () => ws.close() };
}

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
    expect(a.client.send({ k: 'token', name: 'A', token: token('So3') })).toBe(true);
    await sleep(50); // let the relay buffer it before B dials
    const b = make(h, key, 'B');
    b.client.start();
    await connected(b);
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0]).toMatchObject({ peer: 'A', token: { address: 'So3' } });
    expect(b.client.peers.get(a.client.memberId)).toBe('A');
    expect(b.client.members).toBe(1);
  });

  it('drops a token that fails the sanity check', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const a = make(h, key, 'A');
    a.client.start();
    await connected(a);
    const raw = await rawMember(h.port, a.client.id);
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: { address: 42, calls: [] } }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: { address: 'So4' } }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: token('So5') }));
    await poll(() => a.tokens.length === 1);
    expect(a.tokens[0]!.token.address).toBe('So5');
  });

  it('turns to key-mismatch after three undecryptable buffered messages without calling onToken', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const other = newRoomKey();
    const id = roomIdOf(key);
    const raw = await rawMember(h.port, id);
    for (let i = 0; i < 3; i++) raw.send(seal(other, id, { k: 'token', name: 'X', token: token('So' + i) }));
    await sleep(50);
    const a = make(h, key, 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'key-mismatch');
    expect(a.tokens).toHaveLength(0);
    expect(a.states).not.toContain('connected');
    expect(a.client.lastError).toMatch(/key/);
    // stays put: the close that follows must not flip it back to disconnected
    await sleep(50);
    expect(a.client.state).toBe('key-mismatch');
  });

  it('a decryptable message between failures resets the strike counter', async () => {
    const h = await startRelay();
    const key = newRoomKey();
    const other = newRoomKey();
    const a = make(h, key, 'A');
    a.client.start();
    await connected(a);
    const raw = await rawMember(h.port, a.client.id);
    raw.send(seal(other, a.client.id, { k: 'token' }));
    raw.send(seal(other, a.client.id, { k: 'token' }));
    raw.send(seal(key, a.client.id, { k: 'token', name: 'X', token: token('So6') }));
    raw.send(seal(other, a.client.id, { k: 'token' }));
    raw.send(seal(other, a.client.id, { k: 'token' }));
    await poll(() => a.tokens.length === 1);
    await sleep(50);
    expect(a.client.state).toBe('connected');
    raw.send(seal(other, a.client.id, { k: 'token' }));
    await until(a.client, () => a.client.state === 'key-mismatch');
  });

  it('reports access-denied when the relay wants a code the client does not have', async () => {
    const h = await startRelay({ accessCode: 'secret' });
    const a = make(h, newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'access-denied');
    await sleep(50);
    expect(a.client.state).toBe('access-denied');
    const b = make(h, newRoomKey(), 'B', { access: 'secret' });
    b.client.start();
    await connected(b);
  });

  it('reports relay-too-old when the relay answers too-old', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/v1' });
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ t: 'error', code: 'too-old' }));
        ws.close(4001);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    cleanups.push(async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const a = make({ url: `ws://127.0.0.1:${port}` }, newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'relay-too-old');
    await sleep(50);
    expect(a.client.state).toBe('relay-too-old');
  });

  it('reports a newer relay as disconnected with a readable error', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/v1' });
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ t: 'error', code: 'too-new' }));
        ws.close(4002);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    cleanups.push(async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const a = make({ url: `ws://127.0.0.1:${port}` }, newRoomKey(), 'A');
    a.client.start();
    await until(a.client, () => a.client.state === 'disconnected' && /newer protocol/.test(a.client.lastError ?? ''));
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
    await sleep(150);
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
    await sleep(FAST.max + 100);
    expect(b.client.state).toBe('disconnected');
    expect(a.client.members).toBe(0);
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
