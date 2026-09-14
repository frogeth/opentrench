import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MessageHub } from './hub.js';
import { TogetherGuest, TogetherHost, decodePairing, encodePairing, lanAddresses, shareable } from './together.js';
import type { CallRecord, TokenInfo } from './types.js';

const NOW = Date.now();
const call = (msgId: string, chatName: string, ts = NOW - 60_000, extra: Partial<CallRecord> = {}): CallRecord => ({ author: 'alice', chatName, source: 'discord', msgId, ts, marketCap: 50_000, ...extra });
const token = (address: string, calls: CallRecord[], extra: Partial<TokenInfo> = {}): TokenInfo =>
  ({ chain: 'evm', address, network: 'base', seen: calls.length, calledIn: [...new Set(calls.map((c) => c.chatName))], calls, firstSeenTs: calls[0]?.ts ?? NOW, lastCallTs: Math.max(...calls.map((c) => c.ts)), marketCap: 80_000, priceUsd: 0.8, symbol: 'AAA', ...extra }) as TokenInfo;
const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(pred()).toBe(true);
};

describe('pairing strings', () => {
  it('round-trip, IPv6 included, and refuse anything else', () => {
    const p = { host: '192.168.1.20', port: 3211, token: 'abc_DEF-123', name: 'Moussa B' };
    expect(decodePairing(encodePairing(p))).toEqual(p);
    const v6 = { host: 'fe80::1', port: 3211, token: 't', name: 'x' };
    expect(encodePairing(v6)).toBe('opentrench://together/[fe80::1]:3211/t#x');
    expect(decodePairing(encodePairing(v6))).toEqual(v6);
    expect(decodePairing('https://example.com')).toBeUndefined();
    expect(decodePairing('opentrench://together/host:99999/t')).toBeUndefined();
    expect(decodePairing('opentrench://together/host:3211/t')?.name).toBe('host');
  });
});

describe('lanAddresses', () => {
  it('skips loopback, link-local and IPv6, and puts private ranges first', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '169.254.63.48', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.178', family: 'IPv4', internal: false }],
      utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    } as any;
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.178', '100.101.102.103']);
  });
});

describe('hub.applyRemoteToken', () => {
  it('adds an unknown token whole, tagged via the friend, and counts its chats', () => {
    const hub = new MessageHub(10);
    hub.applyRemoteToken('Moussa', token('0xa', [call('m1', 'Alpha'), call('m2', 'Beta', NOW - 30_000)]));
    const t = hub.getToken('0xa')!;
    expect(t.via).toBe('Moussa');
    expect(t.seen).toBe(2);
    expect(t.calledIn).toEqual(['Alpha', 'Beta']);
    expect(t.marketCap).toBe(80_000);
    expect(t.firstCaller?.msgId).toBe('m1');
  });
  it('merges into a token this machine already has: new calls by message id, numbers only where missing', () => {
    const hub = new MessageHub(10);
    hub.applyRemoteToken('Moussa', token('0xa', [call('m1', 'Alpha')]));
    const mine = hub.getToken('0xa')!;
    mine.via = undefined; // pretend it was our own call
    mine.marketCap = 123;
    hub.applyRemoteToken('Moussa', token('0xa', [call('m1', 'Alpha'), call('m3', 'Gamma', NOW - 10_000)], { marketCap: 999, liquidity: 5 }));
    const t = hub.getToken('0xa')!;
    expect(t.calls.map((c) => c.msgId)).toEqual(['m1', 'm3']);
    expect(t.marketCap).toBe(123); // ours, kept
    expect(t.liquidity).toBe(5); // missing, filled
    expect(t.seen).toBe(2);
    // a token that came from the friend keeps following their numbers
    hub.applyRemoteToken('Moussa', token('0xb', [call('m9', 'Alpha')], { marketCap: 1 }));
    hub.applyRemoteToken('Moussa', token('0xb', [call('m9', 'Alpha')], { marketCap: 2 }));
    expect(hub.getToken('0xb')!.marketCap).toBe(2);
  });
  it('never doubles a chat we watch ourselves: same caller in the same chat is one call however it arrives', () => {
    const hub = new MessageHub(10);
    hub.applyRemoteToken('Moussa', token('0xa', [call('m1', 'Alpha', NOW - 60_000, { author: 'alice' }), call('m2', 'Alpha', NOW - 50_000, { author: 'bob' })]));
    expect(hub.getToken('0xa')!.seen).toBe(2); // two callers in one chat: two calls
    hub.applyRemoteToken('Moussa', token('0xa', [call('m3', 'Alpha', NOW - 40_000, { author: 'Alice' })]));
    expect(hub.getToken('0xa')!.seen).toBe(2); // alice again in Alpha: a repeat
    expect(hub.getToken('0xa')!.calls.map((c) => c.msgId)).toEqual(['m1', 'm2']);
  });
  it('ignores junk', () => {
    const hub = new MessageHub(10);
    hub.applyRemoteToken('x', { address: 5 } as any);
    hub.applyRemoteToken('x', { address: '0xz' } as any);
    expect(hub.getToken('0xz')).toBeUndefined();
  });
});

describe('host and guest', () => {
  it('serves only the pairing token, never a browser, and streams calls to a guest', async () => {
    const hostHub = new MessageHub(10);
    hostHub.applyRemoteToken('seed', token('0xs', [call('s1', 'Seed')]));
    const host = new TogetherHost(hostHub, { name: () => 'Moussa', token: () => 'secret', version: 'test' });
    const port = await host.start(0, '127.0.0.1');
    try {
      const hello = await fetch(`http://127.0.0.1:${port}/together/hello?token=secret`).then((r) => r.json());
      expect(hello).toEqual({ name: 'Moussa', version: 'test' });
      expect((await fetch(`http://127.0.0.1:${port}/together/hello?token=wrong`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/together/hello?token=secret`, { headers: { origin: 'http://evil' } })).status).toBe(403);
      // a wrong token on the stream is refused at the upgrade
      const bad = new WebSocket(`ws://127.0.0.1:${port}/together/stream?token=nope`);
      const badStatus = await new Promise<number>((resolve) => {
        bad.on('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
        bad.on('error', () => {});
      });
      expect(badStatus).toBe(403);
      // the guest gets the hello with the host's calls, then live ones
      const guestHub = new MessageHub(10);
      const guest = new TogetherGuest({ host: '127.0.0.1', port, token: 'secret', name: 'pending' }, (peer, t) => guestHub.applyRemoteToken(peer, t));
      guest.start();
      await waitFor(() => guest.state === 'connected' && !!guestHub.getToken('0xs'));
      expect(guest.name).toBe('Moussa');
      expect(guestHub.getToken('0xs')!.via).toBe('Moussa');
      expect(guest.live.has('0xs')).toBe(true);
      hostHub.applyRemoteToken('seed', token('0xn', [call('n1', 'New')]));
      await waitFor(() => !!guestHub.getToken('0xn'));
      expect(host.clients).toBe(1);
      guest.stop();
      await waitFor(() => host.clients === 0);
      expect(guest.live.size).toBe(0);
    } finally {
      host.stop();
    }
  });
  it('shareable drops the via tag so a re-share does not chain names', () => {
    expect(shareable({ ...token('0xa', [call('m', 'A')]), via: 'Bob' }).via).toBeUndefined();
  });
});
