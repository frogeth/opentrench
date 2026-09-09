import { describe, it, expect } from 'vitest';
import { fetchDexscreenerBatch, mapDexscreener } from './dexscreener.js';

const ADDR = '0x777777780838C00038ecD48F63f3C37669322Bc8';
const pair = (liq: number, extra: Record<string, unknown> = {}) => ({
  chainId: 'ethereum',
  pairAddress: `pair${liq}`,
  url: `https://dexscreener.com/ethereum/pair${liq}`,
  baseToken: { address: ADDR, name: 'Ethereumcat', symbol: 'ETHCAT' },
  priceUsd: '0.0002690',
  fdv: 268911,
  marketCap: 268911,
  liquidity: { usd: liq },
  priceChange: { h24: -2.9 },
  volume: { h24: 46881.8 },
  txns: { h24: { buys: 12, sells: 7 } },
  pairCreatedAt: 1700000000000,
  ...extra,
});

describe('mapDexscreener', () => {
  it('picks the pair with the most liquidity and maps fields', () => {
    const json = {
      pairs: [
        pair(100),
        pair(5000, {
          info: {
            imageUrl: 'https://img',
            websites: [{ url: 'https://ethcat.fun', label: 'Website' }],
            socials: [
              { url: 'https://x.com/ethcat__', type: 'twitter' },
              { url: 'https://t.me/Ethereumcat001', type: 'telegram' },
            ],
          },
        }),
        pair(20),
      ],
    };
    expect(mapDexscreener(json, ADDR.toLowerCase())).toEqual({
      name: 'Ethereumcat',
      symbol: 'ETHCAT',
      priceUsd: 0.000269,
      marketCap: 268911,
      liquidity: 5000,
      change24h: -2.9,
      volume24h: 46881.8,
      buys24h: 12,
      sells24h: 7,
      pairCreatedAt: 1700000000000,
      network: 'ethereum',
      pairAddress: 'pair5000',
      chartUrl: 'https://dexscreener.com/ethereum/pair5000',
      embedUrl:
        'https://dexscreener.com/ethereum/pair5000?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15',
      imageUrl: 'https://img',
      website: 'https://ethcat.fun',
      twitter: 'https://x.com/ethcat__',
      telegram: 'https://t.me/Ethereumcat001',
    });
  });

  it('ignores pairs where the token is the quote side', () => {
    const json = { pairs: [{ ...pair(1), baseToken: { address: '0xother', name: 'X', symbol: 'X' } }] };
    expect(mapDexscreener(json, ADDR)).toBeUndefined();
  });

  it('returns undefined when there are no pairs', () => {
    expect(mapDexscreener({ pairs: null }, ADDR)).toBeUndefined();
    expect(mapDexscreener({ pairs: [] }, ADDR)).toBeUndefined();
  });

  it('batches many addresses in one request', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ pairs: [pair(9), { ...pair(3), baseToken: { address: 'So1', name: 'S', symbol: 'S' } }] }) } as any;
    }) as unknown as typeof fetch;
    const got = await fetchDexscreenerBatch([ADDR, 'So1', '0xnothing'], fetchImpl);
    expect(urls[0]).toBe(`https://api.dexscreener.com/latest/dex/tokens/${ADDR},So1,0xnothing`);
    expect([...got.keys()]).toEqual([ADDR, 'So1']);
    expect(got.get(ADDR)?.liquidity).toBe(9);
    expect(got.get('So1')?.symbol).toBe('S');
  });

  it('falls back to fdv when marketCap is missing', () => {
    const json = { pairs: [pair(1, { marketCap: undefined })] };
    expect(mapDexscreener(json, ADDR)?.marketCap).toBe(268911);
  });
});
