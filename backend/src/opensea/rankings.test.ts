import { describe, it, expect, vi } from 'vitest';
import { normalizeRankings, RANKINGS_QUERY, RankingsPoller, keyFor } from './rankings.js';

const item = (over: any = {}) => ({
  score: '1',
  collection: {
    slug: 'pudgypenguins', name: 'Pudgy Penguins', imageUrl: 'https://i/p.png', isVerified: true, chain: { identifier: 'ethereum' },
    stats: { oneHour: { volume: { usd: 27761.2, native: { unit: 11.01, symbol: 'ETH' } }, sales: 3, floorPriceChange: -0.0028 }, oneDay: { volume: { usd: 86449.5, native: { unit: 34.23, symbol: 'ETH' } }, sales: 9, floorPriceChange: -0.011 }, ownerCount: 5069, totalSupply: 8888, listedItemCount: 259 },
    floorPrice: { pricePerItem: { usd: 9026.4, token: { unit: 3.5889, symbol: 'ETH' } } },
    topOffer: null,
    drop: null,
    ...over,
  },
});

describe('normalizeRankings', () => {
  it('picks the timeframe window and ranks in order', () => {
    const rows = normalizeRankings([item(), item({ slug: 'b', name: 'B' })], 'ONE_DAY', Date.parse('2026-09-12T20:00:00Z'));
    expect(rows[0]).toMatchObject({ rank: 1, slug: 'pudgypenguins', verified: true, chain: 'ethereum', volume: { usd: 86449.5, unit: 34.23, symbol: 'ETH' }, sales: 9, floorChange: -0.011, floor: { usd: 9026.4, unit: 3.5889, symbol: 'ETH' }, owners: 5069, supply: 8888, listed: 259 });
    expect(rows[0].topOffer).toBeUndefined();
    expect(rows[1].rank).toBe(2);
    expect(normalizeRankings([item()], 'ONE_HOUR', 0)[0].volume.unit).toBe(11.01);
  });
  it('marks a drop with an open stage as minting', () => {
    const now = Date.parse('2026-09-12T20:30:00Z');
    const drop = { __typename: 'Erc721SeaDropV1', stages: [{ stageType: 'SIGNED_PRESALE', startTime: '2026-09-12T19:00:00Z', endTime: '2026-09-12T20:00:00Z' }, { stageType: 'PUBLIC_SALE', startTime: '2026-09-12T20:00:00Z', endTime: '2026-09-14T20:00:00Z' }] };
    expect(normalizeRankings([item({ drop })], 'ONE_HOUR', now)[0].minting).toEqual({ stageType: 'PUBLIC_SALE', endTime: '2026-09-14T20:00:00Z' });
    expect(normalizeRankings([item({ drop })], 'ONE_HOUR', Date.parse('2026-09-15T00:00:00Z'))[0].minting).toBeUndefined();
  });
  it('skips items without a slug and tolerates missing stats', () => {
    const rows = normalizeRankings([{ collection: null }, item({ stats: null, floorPrice: null })], 'ONE_HOUR', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].volume).toEqual({ usd: 0, unit: 0, symbol: '' });
    expect(rows[0].floor).toBeUndefined();
  });
  it('asks for both windows and the drop stages', () => {
    expect(RANKINGS_QUERY).toContain('oneHour');
    expect(RANKINGS_QUERY).toContain('oneDay');
    expect(RANKINGS_QUERY).toContain('stages');
  });
});

describe('RankingsPoller', () => {
  const okBody = { data: { collectionRankings: { items: [{ collection: { slug: 'a', name: 'A', stats: { oneHour: { volume: { usd: 1, native: { unit: 1, symbol: 'ETH' } }, sales: 1 } } } }] } } };
  const fakeFetch = (calls: string[]) => (async (_url: any, init: any) => { calls.push(JSON.parse(init.body).variables.slug + ':' + JSON.parse(init.body).variables.timeframe); return { ok: true, status: 200, headers: new Headers(), json: async () => okBody } as any; }) as typeof fetch;
  it('polls wanted keys, emits rows, and stops polling un-wanted keys', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const p = new RankingsPoller(fakeFetch(calls));
    const got: string[] = [];
    p.on('rankings', (k: string, rows: any[]) => got.push(`${k}=${rows.length}`));
    p.want(['TRENDING:ONE_HOUR']);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['TRENDING:ONE_HOUR']);
    expect(got).toEqual(['TRENDING:ONE_HOUR=1']);
    expect(p.latest['TRENDING:ONE_HOUR']?.rows[0].slug).toBe('a');
    p.want([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
    p.stop();
    vi.useRealTimers();
  });
  it('keeps old rows and warns once when a poll fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    const f = (async () => { if (fail) throw new Error('down'); return { ok: true, status: 200, headers: new Headers(), json: async () => okBody } as any; }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new RankingsPoller(f);
    p.want(['TOP:ONE_DAY']);
    await vi.advanceTimersByTimeAsync(10);
    fail = true;
    await vi.advanceTimersByTimeAsync(60_000 * 3 + 10);
    expect(p.latest['TOP:ONE_DAY']?.rows).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    p.stop();
    vi.useRealTimers();
  });
  it('maps column options to keys', () => {
    expect(keyFor({})).toBe('TRENDING:ONE_HOUR');
    expect(keyFor({ ranking: 'top', timeframe: '1d' })).toBe('TOP:ONE_DAY');
  });
});
