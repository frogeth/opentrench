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
    // networks run in parallel, so compare as a set
    expect(calls.sort()).toEqual(['dex:base:0xa+0xb', 'dex:robinhood:0xc', 'dex:solana:So1', 'gt:base:0xb', 'gt:robinhood:0xc']);
    expect(applied).toEqual({ '0xa': 1, So1: 1, '0xc': 2 });
    expect(r.updated).toBe(3);
    expect(r.missing.sort()).toEqual(['0xb', '0xz']); // 0xz has no network and there is no chain-less lookup
  });

  it('skips geckoterminal when told to (the fast loop)', async () => {
    const calls: string[] = [];
    const r = await refreshMarket([tok('0xa', 'base'), tok('0xb', 'base')], {
      dex: async (_c, addrs) => new Map(addrs.filter((a) => a === '0xa').map((a) => [a, { marketCap: 1 }])),
      gt: async (slug) => {
        calls.push(`gt:${slug}`);
        return new Map();
      },
      apply: () => {},
    }, { gt: false });
    expect(calls).toEqual([]);
    expect(r).toEqual({ updated: 1, missing: ['0xb'] });
  });

  it('asks the chain-less endpoint for tokens without a network, which also learns the network', async () => {
    const applied: Record<string, Partial<TokenInfo>> = {};
    const asked: string[][] = [];
    const r = await refreshMarket([tok('0xn'), tok('0xm'), tok('0xa', 'base')], {
      dex: async (_c, addrs) => new Map(addrs.map((a) => [a, { marketCap: 1 }])),
      dexAny: async (addrs) => {
        asked.push(addrs);
        return new Map([['0xn', { marketCap: 5, network: 'bsc' }]]);
      },
      gt: async () => new Map(),
      apply: (a, info) => {
        applied[a] = info;
      },
    });
    expect(asked).toEqual([['0xn', '0xm']]);
    expect(applied['0xn']).toEqual({ marketCap: 5, network: 'bsc' });
    expect(r.updated).toBe(2);
    expect(r.missing).toEqual(['0xm']);
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
