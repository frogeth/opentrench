import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelay, type Relay, type RelayOptions } from 'opentrench-relay/src/relay.js';
import { ConfigStore, MAX_ROOMS } from '../config.js';
import { MessageHub } from '../hub.js';
import type { FeedMessage, TokenInfo } from '../types.js';
import { RoomClient, type RoomClientOptions } from './client.js';
import { decodeInvite, isRoomKey, newRoomKey, roomIdOf } from './crypto.js';
import { NO_RELAY_MESSAGE, RoomsManager } from './manager.js';

const FAST = { min: 50, max: 200 };
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL2 = 'So11111111111111111111111111111111111111112';
const EVM = '0xdac17f958d2ee523a2206206994597c13d831ec7';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startRelay(opts: RelayOptions = {}): Promise<{ url: string; relay: Relay }> {
  const relay = createRelay(opts);
  const server = http.createServer();
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `ws://127.0.0.1:${port}`, relay };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rooms-')), 'config.json');

type Peer = {
  name: string;
  cfg: ConfigStore;
  hub: MessageHub;
  mgr: RoomsManager;
  /** Every plaintext handed to any of this manager's clients, in order. */
  sends: { room: string; plain: any }[];
  /** Clients the manager built, in order; `stops` counts stop() calls on each (not `stopped`: that name is the client's own private flag). */
  clients: (RoomClient & { stops: number })[];
  statuses: number;
  clock: { now: number };
};

/**
 * `inert`: clients that never dial, for tests about config and validation on relays that do not exist.
 * `live`: the real clock instead of the frozen one (`clock.now`), for the throttle's timers.
 */
function peer(name: string, opts: { inert?: boolean; live?: boolean; sendGapMs?: number; fetcher?: (address: string) => Promise<Partial<TokenInfo> | undefined> } = {}): Peer {
  const cfg = new ConfigStore(tmpFile());
  const hub = new MessageHub(10, opts.fetcher as any);
  const p: Peer = { name, cfg, hub, sends: [], clients: [], statuses: 0, clock: { now: Date.now() }, mgr: undefined as unknown as RoomsManager };
  p.mgr = new RoomsManager({
    cfg,
    hub,
    version: 'test',
    name: () => p.name,
    now: opts.live ? Date.now : () => p.clock.now,
    sendGapMs: opts.sendGapMs,
    onStatus: () => p.statuses++,
    clientFactory: (o: RoomClientOptions) => {
      const c = new RoomClient({ ...o, backoffMs: FAST, paceMs: 1 }) as RoomClient & { stops: number };
      c.stops = 0;
      if (opts.inert) c.start = () => {};
      const send = c.send.bind(c);
      c.send = (plain: object) => {
        p.sends.push({ room: c.id, plain });
        return send(plain);
      };
      const stop = c.stop.bind(c);
      c.stop = () => {
        c.stops++;
        stop();
      };
      p.clients.push(c);
      return c;
    },
  });
  cleanups.push(() => p.mgr.stop());
  return p;
}

/** A chat message carrying one contract; a distinct author per call so each one counts. */
let seq = 0;
function call(address: string, author: string, ts = Date.now(), extra: Partial<FeedMessage> = {}): FeedMessage {
  return {
    id: `discord:${++seq}`,
    source: 'discord',
    chatId: 'c',
    chatName: '#c',
    author,
    isBot: false,
    text: `ape ${address}`,
    ts,
    contracts: [],
    repeat: false,
    hasAttachment: false,
    ...extra,
  };
}

async function until(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connected = (p: Peer, id?: string) => until(() => p.mgr.status().some((r) => (id === undefined || r.id === id) && r.state === 'connected'), 3000, `${p.name} connected`).catch((e) => Promise.reject(new Error(`${e.message}: ${JSON.stringify(p.mgr.status())}`)));
const tokenSends = (p: Peer, address?: string) => p.sends.filter((s) => s.plain.k === 'token' && (address === undefined || s.plain.token.address === address));

describe('RoomsManager', () => {
  it('create: a valid invite for the relay and key, the plain key in config, and a live client', async () => {
    const h = await startRelay();
    const a = peer('A');
    const room = a.mgr.create('  degens  ', h.url);
    expect(room.name).toBe('degens');
    expect(room.relay).toBe(h.url);
    expect(isRoomKey(room.key)).toBe(true);
    expect(room.id).toBe(roomIdOf(room.key));
    const inv = decodeInvite(room.invite)!;
    expect(inv).toEqual({ relay: h.url, key: room.key, id: room.id });
    expect(a.mgr.invite(room.id)).toBe(room.invite);
    expect(a.cfg.get().together.rooms).toEqual([{ id: room.id, key: room.key, relay: h.url, name: 'degens', joinedAt: a.clock.now }]);
    await connected(a);
    expect(a.mgr.status()).toEqual([{ id: room.id, name: 'degens', relay: h.url, state: 'connected', members: 0, pending: 0, error: undefined }]);
    expect(a.statuses).toBeGreaterThan(0);
  });

  it('create: defaults the name, falls back to the remembered relay, refuses to guess one, and rejects a bad relay readably', async () => {
    const a = peer('A', { inert: true });
    expect(a.mgr.create('', 'ws://127.0.0.1:1').name).toBe('room');
    a.cfg.update((c) => (c.together.relay = 'wss://mine.example'));
    expect(a.mgr.create('x').relay).toBe('wss://mine.example');
    a.cfg.update((c) => (c.together.relay = ''));
    expect(() => a.mgr.create('y')).toThrow(NO_RELAY_MESSAGE);
    expect(a.mgr.create('z', 'wss://Relay.Example.COM:443/').relay).toBe('wss://relay.example.com');
    expect(() => a.mgr.create('w', 'http://relay.example')).toThrow(/wss:\/\//);
    expect(() => a.mgr.create('w', 'ws://not-local.example')).toThrow(/localhost/);
    expect(a.mgr.status().map((r) => r.name)).toEqual(['room', 'x', 'z']);
  });

  it('a call pushed on A lands in B hub tagged via A; a token that came via someone else is never re-sent', async () => {
    const h = await startRelay();
    const a = peer('A');
    const b = peer('B');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    const joined = b.mgr.join(room.invite);
    expect(joined.id).toBe(room.id);
    expect(joined.name).toBe('room');
    expect(joined.invite).toBe(room.invite);
    await connected(b);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B');
    a.hub.push(call(SOL, 'alice'));
    await until(() => !!b.hub.getToken(SOL), 3000, 'B has the token');
    const t = b.hub.getToken(SOL)!;
    expect(t.via).toBe('A');
    expect(t.calls.map((c) => [c.author, c.via])).toEqual([['alice', 'A']]);
    expect(tokenSends(a, SOL)).toHaveLength(1);
    expect(tokenSends(a, SOL)[0]!.plain).toEqual({ k: 'token', name: 'A', token: expect.objectContaining({ address: SOL }) });
    expect(tokenSends(a, SOL)[0]!.plain.token.via).toBeUndefined();
    // B's hub emits a token event for SOL when another friend adds a call to it (applied synchronously,
    // so the manager has already decided by the time the call is counted): nothing goes out from B
    b.hub.applyRemoteToken('Carol', { ...t, via: undefined, calls: [{ ...t.calls[0]!, msgId: 'other', author: 'carol', via: undefined }] });
    expect(b.hub.getToken(SOL)!.calls.map((c) => c.author)).toEqual(['alice', 'carol']);
    expect(tokenSends(b)).toHaveLength(0);
    expect(a.hub.getToken(SOL)!.calls).toHaveLength(1);
  });

  it('only a token own calls trigger a send: a friend call arriving on a token we called does not re-send it', async () => {
    const h = await startRelay();
    const a = peer('A');
    const b = peer('B');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    b.mgr.join(room.invite);
    await connected(b);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B');
    a.hub.push(call(SOL, 'alice'));
    await until(() => !!b.hub.getToken(SOL), 3000, 'B has the token');
    // B's own chat calls it too: B sends, and A's copy gains B's call tagged via B
    b.hub.push(call(SOL, 'bob', Date.now(), { chatId: 'bc', chatName: '#bc' }));
    expect(tokenSends(b, SOL)).toHaveLength(1);
    await until(() => a.hub.getToken(SOL)!.calls.length === 2, 3000, 'A has B call');
    expect(a.hub.getToken(SOL)!.calls.map((c) => [c.author, c.via])).toEqual([['alice', undefined], ['bob', 'B']]);
    expect(a.hub.getToken(SOL)!.via).toBeUndefined();
    expect(tokenSends(a, SOL)).toHaveLength(1);
    // a market tick on A re-emits the token; still nothing new of A's own to say
    a.hub.updateMarket(SOL, { marketCap: 7 });
    expect(tokenSends(a, SOL)).toHaveLength(1);
    // a second own call on A goes out, with the full list (peers dedupe by message id)
    a.clock.now += 60_000;
    a.hub.push(call(SOL, 'anna'));
    expect(tokenSends(a, SOL)).toHaveLength(2);
    expect(tokenSends(a, SOL)[1]!.plain.token.calls.map((c: any) => c.author)).toEqual(['alice', 'bob', 'anna']);
  });

  it('sends at most one message per token per gap; a call inside the gap goes out when the gap ends, not lost', async () => {
    const h = await startRelay();
    const GAP = 300;
    const a = peer('A', { live: true, sendGapMs: GAP });
    a.mgr.create('r', h.url);
    await connected(a);
    const t0 = Date.now();
    a.hub.push(call(SOL, 'alice', t0));
    expect(tokenSends(a, SOL)).toHaveLength(1);
    // two more callers inside the gap: one deferred send, carrying both, when the gap ends
    a.hub.push(call(SOL, 'bob', t0 + 1));
    a.hub.push(call(SOL, 'carol', t0 + 2));
    expect(tokenSends(a, SOL)).toHaveLength(1);
    await sleep(GAP / 3);
    expect(tokenSends(a, SOL)).toHaveLength(1);
    await until(() => tokenSends(a, SOL).length === 2, GAP * 3, 'deferred send');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(GAP - 5);
    expect(tokenSends(a, SOL)[1]!.plain.token.calls.map((c: any) => c.author)).toEqual(['alice', 'bob', 'carol']);
    // a token event with nothing newer to say is not sent, however long ago the last one was
    await sleep(GAP + 20);
    a.hub.updateMarket(SOL, { marketCap: 6 });
    expect(tokenSends(a, SOL)).toHaveLength(2);
    // a newer call after the gap goes out at once
    a.hub.push(call(SOL, 'dave', t0 + 3));
    expect(tokenSends(a, SOL)).toHaveLength(3);
    // a different token has its own gap
    a.hub.push(call(EVM, 'erin', t0 + 4));
    expect(tokenSends(a, EVM)).toHaveLength(1);
    // the newest own call, not the last appended one, is what counts: an older call appended later is nothing new
    a.hub.push(call(EVM, 'old', t0 - 5000));
    expect(tokenSends(a, EVM)).toHaveLength(1);
    // stop() cancels a pending deferred send
    a.hub.push(call(SOL, 'frank', t0 + 5));
    expect(tokenSends(a, SOL)).toHaveLength(3);
    a.mgr.stop();
    await sleep(GAP + 50);
    expect(tokenSends(a, SOL)).toHaveLength(3);
  });

  it('replays the last 24 h of own calls when a room connects, newest first, so a late joiner catches up', async () => {
    const h = await startRelay();
    const a = peer('A');
    const now = Date.now();
    a.hub.push(call(SOL, 'alice', now - 3600e3));
    a.hub.push(call(EVM, 'bob', now - 60e3));
    a.hub.push(call(SOL2, 'old', now - 25 * 3600e3)); // outside the window
    a.hub.applyRemoteToken('Zed', { chain: 'solana', address: 'ViaOnly', seen: 1, calledIn: ['#z'], calls: [{ author: 'z', chatName: '#z', source: 'discord', msgId: 'z1', ts: now }], firstSeenTs: now, lastCallTs: now } as TokenInfo);
    const room = a.mgr.create('r', h.url);
    await connected(a);
    expect(tokenSends(a).map((s) => s.plain.token.address)).toEqual([EVM, SOL]);
    // the replay counts as sent: a market tick right after does not send the token again
    a.hub.updateMarket(EVM, { marketCap: 5 });
    a.hub.updateMarket(SOL, { marketCap: 5 });
    expect(tokenSends(a)).toHaveLength(2);
    const b = peer('B');
    b.mgr.join(room.invite, 'mine');
    await connected(b);
    await until(() => !!b.hub.getToken(SOL) && !!b.hub.getToken(EVM), 3000, 'B caught up');
    expect(b.hub.getToken(SOL)!.via).toBe('A');
    expect(b.hub.getToken(SOL2)).toBeUndefined();
    expect(b.hub.getToken('ViaOnly')).toBeUndefined();
    expect(b.mgr.status()[0]!.name).toBe('mine');
    // B has nothing of its own to replay
    expect(tokenSends(b)).toHaveLength(0);
  });

  it('rotate: a new key and id under the same name and relay; the old client is stopped, the new one connects', async () => {
    const h = await startRelay();
    const a = peer('A');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    const first = a.clients[0]!;
    const r = a.mgr.rotate(room.id);
    expect(r.invite).not.toBe(room.invite);
    expect(decodeInvite(r.invite)!.relay).toBe(h.url);
    const rooms = a.cfg.get().together.rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.id).not.toBe(room.id);
    expect(rooms[0]!.name).toBe('r');
    expect(rooms[0]!.key).not.toBe(room.key);
    expect(first.stops).toBe(1);
    expect(a.mgr.invite(room.id)).toBeUndefined();
    await connected(a, rooms[0]!.id);
    expect(a.clients).toHaveLength(2);
    expect(() => a.mgr.rotate(room.id)).toThrow(/not in that room/);
  });

  it('leave stops the client and forgets the room', async () => {
    const h = await startRelay();
    const a = peer('A');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    a.mgr.leave(room.id);
    expect(a.clients[0]!.stops).toBe(1);
    expect(a.clients[0]!.state).toBe('disconnected');
    expect(a.mgr.status()).toEqual([]);
    expect(a.cfg.get().together.rooms).toEqual([]);
    expect(() => a.mgr.leave(room.id)).toThrow(/not in that room/);
  });

  it('join refuses garbage, a room already joined, and a 51st room; create refuses the 51st too', async () => {
    const a = peer('A');
    for (const bad of ['', 'hello', 'opentrench://room/relay.example/short', `opentrench://room//${newRoomKey()}`, `opentrench://room/relay.example:0/${newRoomKey()}`]) {
      expect(() => a.mgr.join(bad)).toThrow('that is not a room invite (opentrench://room/…)');
    }
    const room = a.mgr.create('r', 'ws://127.0.0.1:1');
    expect(() => a.mgr.join(room.invite)).toThrow('you are already in that room');
    a.cfg.update((c) => {
      while (c.together.rooms.length < MAX_ROOMS) {
        const key = newRoomKey();
        c.together.rooms.push({ id: roomIdOf(key), key, relay: 'wss://r.example', name: 'n', joinedAt: 1 });
      }
    });
    expect(() => a.mgr.create('one more', 'ws://127.0.0.1:1')).toThrow(/50 rooms/);
    expect(() => a.mgr.join(`opentrench://room/r.example/${newRoomKey()}`)).toThrow(/50 rooms/);
    expect(a.cfg.get().together.rooms).toHaveLength(MAX_ROOMS);
  });

  it('sync starts clients for rooms in config, restarts one whose key or relay changed, and stops the gone ones', async () => {
    const h = await startRelay();
    const a = peer('A');
    const key = newRoomKey();
    a.cfg.update((c) => c.together.rooms.push({ id: roomIdOf(key), key, relay: h.url, name: 'from disk', joinedAt: 1 }));
    expect(a.mgr.status()[0]!.state).toBe('disconnected');
    a.mgr.sync();
    await connected(a);
    a.mgr.sync(); // a no-op while nothing changed
    expect(a.clients).toHaveLength(1);
    a.cfg.update((c) => (c.together.rooms[0]!.relay = 'ws://127.0.0.1:1'));
    a.mgr.sync();
    expect(a.clients[0]!.stops).toBe(1);
    expect(a.clients).toHaveLength(2);
    a.cfg.update((c) => (c.together.rooms = []));
    a.mgr.sync();
    expect(a.clients[1]!.stops).toBe(1);
    expect(a.mgr.status()).toEqual([]);
  });

  it('carries the relay access code: with it the room connects, without it status says access-denied; setAccess fixes it', async () => {
    const h = await startRelay({ accessCode: 'sesame' });
    const a = peer('A');
    const room = a.mgr.create('r', h.url);
    await until(() => a.mgr.status()[0]!.state === 'access-denied', 3000, 'denied');
    expect(a.mgr.status()[0]!.error).toMatch(/access code/);
    a.mgr.setAccess(room.id, ' sesame ');
    expect(a.cfg.get().together.rooms[0]!.access).toBe('sesame');
    expect(a.clients[0]!.stops).toBe(1);
    await connected(a);
    const b = peer('B');
    b.mgr.join(room.invite, undefined, 'sesame');
    await connected(b);
    expect(b.cfg.get().together.rooms[0]!.access).toBe('sesame');
    // rotate keeps the code
    const r = a.mgr.rotate(room.id);
    expect(a.cfg.get().together.rooms[0]!.access).toBe('sesame');
    await connected(a, decodeInvite(r.invite)!.id);
    // clearing it dials again without one
    a.mgr.setAccess(a.cfg.get().together.rooms[0]!.id, '');
    expect(a.cfg.get().together.rooms[0]!.access).toBeUndefined();
    await until(() => a.mgr.status()[0]!.state === 'access-denied', 3000, 'denied again');
  });

  it('a token shared before its own enrichment answered is sent once more when the ticker and chain land, with no newer call', async () => {
    const h = await startRelay();
    let answer: ((info: Partial<TokenInfo>) => void) | undefined;
    const a = peer('A', { fetcher: () => new Promise((r) => (answer = r)) });
    const b = peer('B');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    b.mgr.join(room.invite);
    await connected(b);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B');
    const t0 = Date.now();
    a.hub.push(call(EVM, 'alice', t0));
    await until(() => tokenSends(a, EVM).length === 1, 3000, 'first send');
    expect(tokenSends(a, EVM)[0]!.plain.token.symbol).toBeUndefined(); // went out bare
    await until(() => !!answer, 3000, 'enrichment asked');
    a.clock.now += 60_000; // past the send gap
    answer!({ symbol: 'TINDER', name: 'Tinder', network: 'robinhood', priceUsd: 1 });
    await until(() => tokenSends(a, EVM).length === 2, 3000, 'catch-up send');
    expect(tokenSends(a, EVM)[1]!.plain.token).toMatchObject({ symbol: 'TINDER', network: 'robinhood' });
    await until(() => b.hub.getToken(EVM)?.symbol === 'TINDER', 3000, 'B has the ticker');
    // more market ticks do not send again: identity travels once
    a.clock.now += 60_000;
    a.hub.updateMarket(EVM, { marketCap: 5 });
    await new Promise((r) => setTimeout(r, 200));
    expect(tokenSends(a, EVM)).toHaveLength(2);
  });

  it('only identity and calls travel: market numbers never reach the room, so a peer keeps pricing on its own', async () => {
    const h = await startRelay();
    const a = peer('A');
    const b = peer('B');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    b.mgr.join(room.invite);
    await connected(b);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B');
    // explicit, distinct call times: two pushes in the same millisecond would be "nothing newer" to the throttle
    const t0 = Date.now();
    a.hub.push(call(SOL, 'alice', t0));
    a.hub.updateMarket(SOL, { priceUsd: 1.5, marketCap: 7, liquidity: 3, change24h: 2, volume24h: 9, buys24h: 1, sells24h: 1, priceSource: 'chain', priceAt: 5, imageUrl: 'https://img', pairAddress: 'pair', dex: 'raydium' });
    expect(a.hub.getToken(SOL)!.priceUsd).toBe(1.5);
    a.clock.now += 60_000;
    a.hub.push(call(SOL, 'anna', t0 + 1)); // a second own call after the numbers landed: this send carries the enriched token
    await until(() => b.hub.getToken(SOL)?.calls.length === 2, 3000, 'B has both calls');
    const dropped = ['priceUsd', 'marketCap', 'liquidity', 'change24h', 'volume24h', 'buys24h', 'sells24h', 'priceSource', 'priceAt', 'security', 'via'] as const;
    const sent = tokenSends(a, SOL).at(-1)!.plain.token;
    expect(sent).toMatchObject({ address: SOL, chain: 'sol', dex: 'raydium', imageUrl: 'https://img', pairAddress: 'pair', athMarketCap: 7 });
    for (const k of dropped) expect(k in sent, k).toBe(false);
    const got = b.hub.getToken(SOL)!;
    expect(got.dex).toBe('raydium');
    expect(got.via).toBe('A');
    for (const k of dropped) if (k !== 'via') expect(got[k], k).toBeUndefined();
    // B prices it locally; the next call from A does not overwrite that
    b.hub.updateMarket(SOL, { priceUsd: 9, marketCap: 99 });
    a.clock.now += 60_000;
    a.hub.push(call(SOL, 'arthur', t0 + 2));
    await until(() => b.hub.getToken(SOL)?.calls.length === 3, 3000, 'B has the third call');
    expect(b.hub.getToken(SOL)!.marketCap).toBe(99);
    expect(b.hub.getToken(SOL)!.priceUsd).toBe(9);
  });

  it('rotate tells the old room first: a member still in it lands in key-mismatch and stays there across sync(), until it leaves and re-joins', async () => {
    const h = await startRelay();
    const a = peer('A');
    const b = peer('B');
    const room = a.mgr.create('r', h.url);
    await connected(a);
    b.mgr.join(room.invite, 'theirs');
    await connected(b);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B');
    const next = a.mgr.rotate(room.id);
    await until(() => b.mgr.status()[0]!.state === 'key-mismatch', 3000, 'B told');
    expect(b.mgr.status()[0]).toMatchObject({ id: room.id, name: 'theirs', members: 0, error: expect.stringMatching(/new invite/) });
    expect(b.cfg.get().together.rooms.map((r) => r.id)).toEqual([room.id]); // still in config: the card shows the message and offers Leave
    await connected(a, next.id);
    // a later sync() (the settings screen saved something else) does not dial the dead room again
    b.mgr.sync();
    await sleep(FAST.max + 100);
    expect(b.mgr.status()[0]!.state).toBe('key-mismatch');
    expect(b.clients).toHaveLength(1);
    // leaving and joining the new invite is the way back in
    b.mgr.leave(room.id);
    expect(b.mgr.status()).toEqual([]);
    b.mgr.join(next.invite, 'theirs');
    await connected(b, next.id);
    await until(() => a.mgr.status()[0]!.members === 1, 3000, 'A sees B again');
  });

  it('stop() stops every client and stops listening to the hub', async () => {
    const h = await startRelay();
    const a = peer('A');
    a.mgr.create('one', h.url);
    a.mgr.create('two', h.url);
    await until(() => a.mgr.status().every((r) => r.state === 'connected'), 3000, 'both connected');
    a.mgr.stop();
    expect(a.clients.map((c) => c.stops)).toEqual([1, 1]);
    expect(a.hub.listenerCount('event')).toBe(0);
    a.hub.push(call(SOL, 'alice'));
    expect(tokenSends(a)).toHaveLength(0);
    expect(a.mgr.status().map((r) => r.state)).toEqual(['disconnected', 'disconnected']);
    a.mgr.sync();
    expect(a.clients).toHaveLength(2);
    expect(a.mgr.status().map((r) => r.state)).toEqual(['disconnected', 'disconnected']);
  });
});
