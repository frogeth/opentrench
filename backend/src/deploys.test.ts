import { describe, it, expect, vi } from 'vitest';
import { createDeployFinder, createLaunchWatcher, matchLink, parsePonsSocials } from './deploys.js';
import type { J7Tweet } from './types.js';

const T0 = 1_700_000_000_000;

describe('matchLink', () => {
  it('spots the exact tweet, then the account, ignoring case and query strings', () => {
    expect(matchLink(['https://x.com/Elon/status/123?s=20'], '123', 'elon')).toBe('tweet');
    expect(matchLink(['https://twitter.com/elon'], '123', 'Elon')).toBe('account');
    expect(matchLink(['https://x.com/elonmusk'], '123', 'elon')).toBeUndefined();
    expect(matchLink(['https://x.com/other/status/999', undefined], '123', 'elon')).toBeUndefined();
  });
  it('reads the socials block out of a Pons page payload', () => {
    expect(parsePonsSocials('x,"socials":{"twitter":"https://x.com/a/status/1","telegram":"","discord":""},"deployer"')).toEqual({ twitter: 'https://x.com/a/status/1' });
    expect(parsePonsSocials('nothing here')).toEqual({});
  });
});

const pumpPage = (offset: number) =>
  Array.from({ length: 70 }, (_, i) => {
    const n = offset + i;
    return { mint: `P${n}`, name: `pump${n}`, symbol: `P${n}`, created_timestamp: T0 + 60_000 * 60 - n * 60_000, twitter: n === 5 ? 'https://x.com/elon/status/123' : n === 80 ? 'https://x.com/elon' : '', usd_market_cap: 1000 + n, image_uri: 'i' };
  });
const ponsRows = [
  { token: '0xA1', name: 'pons1', symbol: 'PN1', launchedAt: new Date(T0 + 30_000).toISOString(), marketCapUsd: 50, logo: 'b', description: '' },
  { token: '0xA2', name: 'pons2', symbol: 'PN2', launchedAt: new Date(T0 + 20_000).toISOString(), marketCapUsd: 60, logo: 'b', description: '' },
];
const makeFetch = (opts: { ponsDown?: boolean } = {}) =>
  (async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes('pump.fun')) {
      const offset = Number(/offset=(\d+)/.exec(u)![1]);
      return { ok: true, json: async () => pumpPage(offset) };
    }
    if (u.includes('/api/pons-launches')) {
      if (opts.ponsDown) return { ok: false, status: 503 };
      const page = Number(/page=(\d+)/.exec(u)![1]);
      return { ok: true, json: async () => ({ active: { items: page === 1 ? ponsRows : [] } }) };
    }
    if (u.includes('/launchpad/0x')) {
      expect(init?.headers?.RSC).toBe('1');
      const token = u.split('/launchpad/')[1];
      return { ok: true, text: async () => (token === '0xA1' ? '"socials":{"twitter":"https://x.com/elon/status/123","telegram":""}' : '"socials":{"twitter":"","telegram":""}') };
    }
    throw new Error('unexpected ' + u);
  }) as unknown as typeof fetch;

describe('deploy finder', () => {
  it('walks pump.fun back to the tweet time and reads Pons token pages for socials, exact tweet links first', async () => {
    const f = createDeployFinder(makeFetch(), 1000);
    const r = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    expect(r.deploys.map((d) => [d.source, d.mint, d.match])).toEqual([
      ['pump', 'P5', 'tweet'],
      ['pons', '0xA1', 'tweet'],
      ['pump', 'P80', 'account'],
    ]);
    expect(r.deploys[1].url).toBe('https://www.ponsfamily.com/launchpad/0xA1');
    expect(r.scanned.pons).toBe(T0 + 20_000);
    expect(r.scanned.pump).toBeLessThan(T0);
  });

  it('caches by tweet and survives one launchpad being down', async () => {
    let calls = 0;
    const base = makeFetch({ ponsDown: true });
    const down = (async (url: string, init?: any) => {
      calls++;
      return base(url, init);
    }) as unknown as typeof fetch;
    const f = createDeployFinder(down, 1000);
    const a = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    const n = calls;
    const b = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    expect(b).toBe(a);
    expect(calls).toBe(n);
    expect(a.scanned.pons).toBeUndefined();
    expect(a.deploys.some((d) => d.source === 'pump')).toBe(true);
  });
});

describe('launch watcher', () => {
  const tweet = (id: string, handle: string): J7Tweet => ({ id, ts: T0, author: { handle, name: handle }, text: '', images: [], contracts: [], tickers: [] });
  it('learns the existing lists on the first poll, then pairs new launches with tweets and new tweets with recent launches', async () => {
    let pumpRows: any[] = [{ mint: 'OLD', name: 'old', symbol: 'OLD', created_timestamp: T0, twitter: 'https://x.com/elon/status/1' }];
    let ponsItems: any[] = [];
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('pump.fun')) return { ok: true, json: async () => pumpRows };
      if (u.includes('/api/pons-launches')) return { ok: true, json: async () => ({ active: { items: ponsItems } }) };
      if (u.includes('/launchpad/0x')) return { ok: true, text: async () => '"socials":{"twitter":"https://x.com/dev/status/777"}' };
      throw new Error('unexpected ' + u);
    }) as unknown as typeof fetch;
    const tweets: J7Tweet[] = [tweet('1', 'elon')];
    const matches: [string, string, string][] = [];
    const w = createLaunchWatcher({ fetchImpl, tweets: () => tweets, onMatch: (id, d) => matches.push([id, d.mint, d.match]) });
    await w._tick(); // priming: OLD links tweet 1 but was already there
    expect(matches).toEqual([]);
    pumpRows = [{ mint: 'NEW', name: 'new', symbol: 'NEW', created_timestamp: Date.now(), twitter: 'https://x.com/elon/status/1' }, ...pumpRows];
    ponsItems = [{ token: '0xB1', name: 'b', symbol: 'B', launchedAt: new Date().toISOString(), description: '' }];
    await w._tick();
    expect(matches).toEqual([['1', 'NEW', 'tweet']]);
    // the Pons launch linked tweet 777, which J7 relays a moment later
    w.matchTweet(tweet('777', 'dev'));
    expect(matches[1]).toEqual(['777', '0xB1', 'tweet']);
    expect(w.ringSize()).toBe(2);
    w.stop();
  });
});
