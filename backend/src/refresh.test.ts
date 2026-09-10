import { describe, expect, it } from 'vitest';
import { refreshMarket } from './refresh.js';
import type { TokenInfo } from './types.js';

const tok = (address: string, network?: string): TokenInfo =>
  ({ chain: 'evm', address, network, seen: 1, calledIn: [], calls: [], firstSeenTs: 0, lastCallTs: 0 }) as TokenInfo;

describe('refreshMarket', () => {
  it('asks dexscreener per network, then geckoterminal for what it did not answer', async () => {
    const calls: string[] = [];
    const applied: Record<string, number> = {};
    const r = await refreshMarket([tok('0xa', 'base'), tok('0xb', 'base'), tok('So1', 'solana'), tok('0xc', 'robinhood'), tok('0xz')], {
      dex: async (chain, addrs) => {
        calls.push(`dex:${chain}:${addrs.join('+')}`);
        return new Map(addrs.filter((a) => a !== '0xb' && a !== '0xc').map((a) => [a, { marketCap: 1 }]));
      },
      gt: async (slug, addrs) => {
        calls.push(`gt:${slug}:${addrs.join('+')}`);
        return new Map(addrs.filter((a) => a === '0xc').map((a) => [a, { marketCap: 2 }]));
      },
      apply: (a, info) => {
        applied[a] = info.marketCap!;
      },
    });
    expect(calls).toEqual(['dex:base:0xa+0xb', 'gt:base:0xb', 'dex:solana:So1', 'dex:robinhood:0xc', 'gt:robinhood:0xc']);
    expect(applied).toEqual({ '0xa': 1, So1: 1, '0xc': 2 });
    expect(r).toEqual({ updated: 3, missing: ['0xb'] });
  });

  it('survives a failing source and moves on', async () => {
    const applied: string[] = [];
    const r = await refreshMarket([tok('0xa', 'base'), tok('0xb', 'bsc')], {
      dex: async (chain) => {
        if (chain === 'base') throw new Error('429');
        return new Map([['0xb', { marketCap: 3 }]]);
      },
      gt: async () => {
        throw new Error('down');
      },
      apply: (a) => applied.push(a),
    });
    expect(applied).toEqual(['0xb']);
    expect(r.missing).toEqual(['0xa']);
  });
});
