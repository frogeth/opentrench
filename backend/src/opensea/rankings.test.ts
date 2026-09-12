import { describe, it, expect } from 'vitest';
import { normalizeRankings, RANKINGS_QUERY } from './rankings.js';

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
