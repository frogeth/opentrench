import { describe, it, expect } from 'vitest';
import { createDeployFinder, matchLink } from './deploys.js';

const T0 = 1_700_000_000_000;

describe('matchLink', () => {
  it('spots the exact tweet, then the account, ignoring case and query strings', () => {
    expect(matchLink(['https://x.com/Elon/status/123?s=20'], '123', 'elon')).toBe('tweet');
    expect(matchLink(['https://twitter.com/elon'], '123', 'Elon')).toBe('account');
    expect(matchLink(['https://x.com/elonmusk'], '123', 'elon')).toBeUndefined();
    expect(matchLink(['https://x.com/other/status/999', undefined], '123', 'elon')).toBeUndefined();
  });
});

describe('deploy finder', () => {
  const pump = (offset: number) =>
    Array.from({ length: 70 }, (_, i) => {
      const n = offset + i;
      return { mint: `P${n}`, name: `pump${n}`, symbol: `P${n}`, created_timestamp: T0 + 60_000 * 60 - n * 60_000, twitter: n === 5 ? 'https://x.com/elon/status/123' : n === 80 ? 'https://x.com/elon' : '', usd_market_cap: 1000 + n, image_uri: 'i' };
    });
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes('pump.fun')) {
      const offset = Number(/offset=(\d+)/.exec(u)![1]);
      return { ok: true, json: async () => pump(offset) };
    }
    if (u.includes('raydium')) {
      return {
        ok: true,
        json: async () => ({ data: { rows: [{ mint: 'B1', name: 'bonk1', symbol: 'B1', createAt: T0 + 30_000, twitter: '', website: 'https://x.com/elon/status/123', marketCap: 50, imgUrl: 'b' }], nextPageId: undefined } }),
      };
    }
    throw new Error('unexpected ' + u);
  }) as unknown as typeof fetch;

  it('walks both launchpads back to the tweet time, exact tweet links first', async () => {
    const f = createDeployFinder(fetchImpl, 1000);
    const r = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    expect(r.deploys.map((d) => [d.source, d.mint, d.match])).toEqual([
      ['pump', 'P5', 'tweet'],
      ['bonk', 'B1', 'tweet'],
      ['pump', 'P80', 'account'],
    ]);
    expect(r.scanned.bonk).toBe(T0 + 30_000);
    // stopped once a page reached past the tweet time (SLACK 10min): pages 0-2 = 210 rows, oldest T0+60min-209min < T0
    expect(r.scanned.pump).toBeLessThan(T0);
  });

  it('caches by tweet and survives one launchpad being down', async () => {
    let calls = 0;
    const down = (async (url: string) => {
      calls++;
      if (String(url).includes('raydium')) return { ok: false, status: 503 };
      return fetchImpl(url);
    }) as unknown as typeof fetch;
    const f = createDeployFinder(down, 1000);
    const a = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    const n = calls;
    const b = await f.find({ tweetId: '123', handle: 'elon', since: T0 });
    expect(b).toBe(a);
    expect(calls).toBe(n);
    expect(a.scanned.bonk).toBeUndefined();
    expect(a.deploys.some((d) => d.source === 'pump')).toBe(true);
  });
});
