import { describe, it, expect } from 'vitest';
import { mapDexscreener } from './dexscreener.js';

const ADDR = '0x777777780838C00038ecD48F63f3C37669322Bc8';
const pair = (liq: number, extra: Record<string, unknown> = {}) => ({
  chainId: 'ethereum',
  url: `https://dexscreener.com/ethereum/pair${liq}`,
  baseToken: { address: ADDR, name: 'Ethereumcat', symbol: 'ETHCAT' },
  priceUsd: '0.0002690',
  fdv: 268911,
  marketCap: 268911,
  liquidity: { usd: liq },
  priceChange: { h24: -2.9 },
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
      chartUrl: 'https://dexscreener.com/ethereum/pair5000',
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

  it('falls back to fdv when marketCap is missing', () => {
    const json = { pairs: [pair(1, { marketCap: undefined })] };
    expect(mapDexscreener(json, ADDR)?.marketCap).toBe(268911);
  });
});
