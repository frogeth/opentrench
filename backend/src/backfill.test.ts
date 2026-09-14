import { describe, expect, it } from 'vitest';
import { PER_CYCLE, SETTLE_MS, backfillOnce, marketCapsAt, pendingCalls, repairCandleMarketCaps, type CallMarketCap } from './backfill.js';
import type { Candle } from './geckoterminal.js';
import type { CallRecord, TokenInfo } from './types.js';

const NOW = 1_800_000_000_000; // ms
const call = (msgId: string, ts: number, extra: Partial<CallRecord> = {}): CallRecord => ({ author: 'a', chatName: 'c', source: 'discord', msgId, ts, marketCap: 100_000, ...extra });
const token = (address: string, calls: CallRecord[], extra: Partial<TokenInfo> = {}): TokenInfo =>
  ({ chain: 'evm', address, network: 'base', pairAddress: 'pool', marketCap: 200_000, priceUsd: 2, seen: 1, calledIn: [], calls, firstSeenTs: 0, lastCallTs: Math.max(...calls.map((c) => c.ts)), ...extra }) as TokenInfo;
/** one closed 1-minute candle per minute, close = $1 + minute index */
const candles = (fromSec: number, n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ t: fromSec + i * 60, o: 1, h: 1, l: 1, c: 1 + i, v: 0 }));

describe('pendingCalls', () => {
  it('wants settled, recent calls that still carry the cached number', () => {
    const t = token('0xa', [
      call('fresh', NOW - SETTLE_MS + 1000), // its minute may still be open
      call('due', NOW - 5 * 60_000),
      call('done', NOW - 6 * 60_000, { mcSource: 'candle' }),
      call('kept', NOW - 7 * 60_000, { mcSource: 'cached' }),
      call('old', NOW - 25 * 3600e3),
    ]);
    expect(pendingCalls(t, NOW).map((c) => c.msgId)).toEqual(['due']);
  });
  it('needs a pool and live numbers to scale a price into a market cap', () => {
    const c = [call('x', NOW - 5 * 60_000)];
    expect(pendingCalls(token('0xa', c, { pairAddress: undefined }), NOW)).toEqual([]);
    expect(pendingCalls(token('0xa', c, { network: undefined }), NOW)).toEqual([]);
    expect(pendingCalls(token('0xa', c, { priceUsd: undefined }), NOW)).toEqual([]);
  });
});

describe('marketCapsAt', () => {
  it('takes the close of the candle containing each call, scaled by supply', () => {
    const base = 1_700_000_000; // sec
    const ks = candles(base, 5);
    const calls = [call('m0', base * 1000 + 5_000), call('m3', (base + 180) * 1000 + 59_999), call('gap', (base + 600) * 1000)];
    expect(marketCapsAt(calls, ks, 50_000)).toEqual<CallMarketCap[]>([
      { msgId: 'm0', marketCap: 1 * 50_000, source: 'candle' },
      { msgId: 'm3', marketCap: 4 * 50_000, source: 'candle' },
      { msgId: 'gap', source: 'cached' },
    ]);
  });
});

describe('backfillOnce', () => {
  it('asks once per token, newest calls first, up to the per-cycle cap, and applies what it learns', async () => {
    const base = Math.floor((NOW - 3600e3) / 1000);
    const tokens = Array.from({ length: PER_CYCLE + 2 }, (_, i) => token(`0x${i}`, [call(`c${i}`, (base + 60 * i) * 1000 + 100)]));
    const asked: string[] = [];
    const applied: Record<string, CallMarketCap[]> = {};
    const n = await backfillOnce({
      tokens: () => tokens,
      candles: async (token, _net, _pool, before) => {
        asked.push(token);
        expect(before).toBeGreaterThan(base);
        return candles(base, 60);
      },
      apply: (a, u) => {
        applied[a] = u;
      },
      now: () => NOW,
    });
    expect(asked.length).toBe(PER_CYCLE);
    expect(asked.sort()).toEqual(tokens.slice(-PER_CYCLE).map((t) => t.address).sort()); // the token itself is named, so GT gives its side of the pool
    // newest lastCallTs first: the highest indices
    expect(Object.keys(applied).sort()).toEqual(tokens.slice(-PER_CYCLE).map((t) => t.address).sort());
    expect(n).toBe(PER_CYCLE);
    const last = tokens[tokens.length - 1];
    expect(applied[last.address][0]).toEqual({ msgId: `c${tokens.length - 1}`, marketCap: (1 + tokens.length - 1) * (200_000 / 2), source: 'candle' });
  });
  it('covers every pending call of a token with one request and marks the ones without a candle as kept', async () => {
    const base = Math.floor((NOW - 3600e3) / 1000);
    const t = token('0xa', [call('early', base * 1000 + 100), call('late', (base + 10 * 60) * 1000 + 100), call('nocandle', (base + 40 * 60) * 1000 + 100)]);
    let limitAsked = 0;
    const applied: CallMarketCap[] = [];
    await backfillOnce({
      tokens: () => [t],
      candles: async (_t, _n, _p, _b, limit) => {
        limitAsked = limit;
        return candles(base, 20);
      },
      apply: (_a, u) => applied.push(...u),
      now: () => NOW,
    });
    expect(limitAsked).toBeGreaterThanOrEqual(41);
    expect(applied).toEqual([
      { msgId: 'early', marketCap: 1 * 100_000, source: 'candle' },
      { msgId: 'late', marketCap: 11 * 100_000, source: 'candle' },
      { msgId: 'nocandle', source: 'cached' },
    ]);
  });
  it('a failing candle source leaves the calls pending for the next pass', async () => {
    const t = token('0xa', [call('c', NOW - 5 * 60_000)]);
    const logs: string[] = [];
    let applied = 0;
    const n = await backfillOnce({
      tokens: () => [t],
      candles: async () => {
        throw new Error('429');
      },
      apply: () => {
        applied++;
      },
      log: (m) => logs.push(m),
      now: () => NOW,
    });
    expect(n).toBe(0);
    expect(applied).toBe(0);
    expect(logs[0]).toContain('429');
    expect(pendingCalls(t, NOW).length).toBe(1);
  });

  it('repair sends candle-derived values back for re-reading and drops the nonsense ones', () => {
    const t = token('0xa', [call('first', NOW - 5 * 60_000, { mcSource: 'candle', marketCap: 1_686_295_960_775 }), call('fine', NOW - 4 * 60_000, { mcSource: 'candle', marketCap: 180_000 }), call('cached', NOW - 3 * 60_000, { mcSource: 'cached', marketCap: 100_000 })], { marketCap: 18_333, firstCallMarketCap: 1_686_295_960_775 });
    expect(repairCandleMarketCaps([t])).toEqual({ reset: 2, dropped: 1 });
    expect(t.calls[0]).toMatchObject({ msgId: 'first', marketCap: undefined, mcSource: undefined });
    expect(t.firstCallMarketCap).toBeUndefined();
    expect(t.calls[1]).toMatchObject({ msgId: 'fine', marketCap: 180_000, mcSource: undefined }); // within 50×: kept, re-read later
    expect(t.calls[2]).toMatchObject({ msgId: 'cached', marketCap: 100_000, mcSource: 'cached' });
    expect(pendingCalls(t, NOW).map((c) => c.msgId)).toEqual(['first', 'fine']);
  });
});
