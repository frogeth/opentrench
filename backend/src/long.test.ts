import { describe, expect, it, vi } from 'vitest';
import { anchorLabel, fetchLong, isLongAddress, mapLongAsset, mergeLaunchpad, resolveNumeraires, __resetSymbolCache } from './long.js';
import type { TokenInfo } from './types.js';

/** a row as api.long.xyz returns it (captured 2026-09-14) */
const RIZO = {
  asset_address: '0xc99fd9ff8494229c8271a9053e489f6405f61e18',
  asset_numeraire_address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  asset_creation_timestamp: '2026-09-10T23:58:09+00:00',
  asset_current_pool: 'auction',
  integrator_address: '0x92d435c96e63c43e12d6d0ab28f6b0b04072f765',
  auction_pool: {
    pool_address: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544',
    pool_current_fdv_usd: '283741112039883902400000',
    pool_current_sale_progress_percentage: '12.5',
    pool_volume_24h_usd: '115924000000000000000000',
    base_token: { token_symbol: 'RIZO', token_name: 'Rizo', token_description: '', token_image_public_url: 'https://storage.long.xyz/tokens/0xc99fd9ff8494229c8271a9053e489f6405f61e18.jpg' },
    pool_market_data: { marketCap: '284080.493699', price: '2.84080493699e-4', priceChange24: '0.15440703583325283', volumeUSD24: '115924' },
  },
  graduation_pool: { pool_address: '0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD', pool_market_data: null },
};

const gqlMock = (handler: (query: string, variables: any) => unknown) =>
  vi.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: handler(body.query, body.variables) }) } as any;
  });

describe('long', () => {
  it('knows a Long address by its suffix', () => {
    expect(isLongAddress(RIZO.asset_address)).toBe(true);
    expect(isLongAddress('0xa419Bb493ed5059f28dfd84348A2F93D70ECf003')).toBe(false);
    expect(isLongAddress('So11111111111111111111111111111111111111112')).toBe(false);
  });

  it('names the anchor: a stock ticker, a Long token, or a short address', () => {
    expect(anchorLabel('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec')).toBe('NVDA');
    expect(anchorLabel('0x2E8C31162B855A2FFA90F6F8634643AD6F111E18', { '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18': 'AI' })).toBe('AI');
    expect(anchorLabel('0x1937cad42b17d43bb2b347ce16d5288887c46c33')).toBe('0x1937…6c33');
    expect(anchorLabel('0x0000000000000000000000000000000000000000')).toBe('ETH');
    expect(anchorLabel(undefined)).toBeUndefined();
  });

  it('maps an asset to launchpad info with the live pool numbers', () => {
    expect(mapLongAsset(RIZO)).toEqual({
      launchpad: 'long',
      launchpadUrl: 'https://app.long.xyz/tokens/0xc99fd9ff8494229c8271a9053e489f6405f61e18',
      network: 'robinhood',
      symbol: 'RIZO',
      name: 'Rizo',
      imageUrl: 'https://storage.long.xyz/tokens/0xc99fd9ff8494229c8271a9053e489f6405f61e18.jpg',
      pairCreatedAt: Date.parse('2026-09-10T23:58:09+00:00'),
      launchpadNote: 'anchored to TSLA',
      marketCap: 284080.493699,
      priceUsd: 2.84080493699e-4,
      volume24h: 115924,
    });
  });

  it('falls back to the 1e18-scaled fdv and volume when market data is missing', () => {
    const a = { ...RIZO, auction_pool: { ...RIZO.auction_pool, pool_market_data: null } };
    const info = mapLongAsset(a)!;
    expect(info.marketCap).toBeCloseTo(283741.112, 2);
    expect(info.volume24h).toBeCloseTo(115924, 3);
    expect(info.priceUsd).toBeUndefined();
  });

  it('fetchLong asks only for the suffix and returns undefined for an unknown asset', async () => {
    const fetchImpl = gqlMock((q) => (q.includes('LongAsset') ? { Asset: [] } : {}));
    expect(await fetchLong('0xa419Bb493ed5059f28dfd84348A2F93D70ECf003', fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fetchLong(RIZO.asset_address, fetchImpl)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variables).toEqual({ address: RIZO.asset_address, chain: 4663 });
  });

  it('fetchLong resolves a launch anchored to another Long token with one extra lookup', async () => {
    const child = { ...RIZO, asset_address: '0x96362aae195602609b4ace9a1479a8555a891e18', asset_numeraire_address: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18' };
    const fetchImpl = gqlMock((q) => (q.includes('LongAsset') ? { Asset: [child] } : q.includes('LongSymbols') ? { Asset: [{ asset_address: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', auction_pool: { base_token: { token_symbol: 'AI' } } }] } : {}));
    const info = await fetchLong(child.asset_address, fetchImpl);
    expect(info?.launchpadNote).toBe('anchored to AI');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('mergeLaunchpad sets the badge and fills only the gaps', () => {
    const t = { chain: 'evm', address: RIZO.asset_address, seen: 1, calledIn: [], calls: [], firstSeenTs: 0, lastCallTs: 0, marketCap: 999, symbol: 'OLD' } as unknown as TokenInfo;
    expect(mergeLaunchpad(t, mapLongAsset(RIZO)!)).toBe(true);
    expect(t.launchpad).toBe('long');
    expect(t.launchpadNote).toBe('anchored to TSLA');
    expect(t.network).toBe('robinhood');
    expect(t.symbol).toBe('OLD'); // already known: kept
    expect(t.marketCap).toBe(999); // already known: kept
    expect(t.name).toBe('Rizo'); // missing: filled
    expect(mergeLaunchpad(t, mapLongAsset(RIZO)!)).toBe(false); // nothing new
  });

  it('reads an unknown anchor\'s symbol from the chain once and caches it', async () => {
    __resetSymbolCache();
    const abiString = (str: string) => '0x' + '20'.padStart(64, '0') + str.length.toString(16).padStart(64, '0') + Buffer.from(str).toString('hex').padEnd(64, '0');
    const rpc = vi.fn(async (_url: string, init: any) => {
      const calls = JSON.parse(init.body);
      return { ok: true, json: async () => calls.map((c: any) => ({ id: c.id, result: abiString('COIN') })) } as any;
    });
    const a = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    expect(await resolveNumeraires([a, 'nope', RIZO.asset_address, '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'], rpc)).toEqual({ [a]: 'COIN' });
    expect(await resolveNumeraires([a], rpc)).toEqual({ [a]: 'COIN' });
    expect(rpc).toHaveBeenCalledTimes(1); // cached; the static table and Long tokens never hit the chain
    __resetSymbolCache();
  });
});
