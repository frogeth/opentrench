import { describe, it, expect, vi } from 'vitest';
import { createEnricher, explorerUrl } from './enrich.js';
import { mapGeckoTerminal } from './geckoterminal.js';

const A = '0xa419Bb493ed5059f28dfd84348A2F93D70ECf003';

describe('createEnricher', () => {
  it('uses dexscreener when it has a pair and skips geckoterminal; launchpad still adds its badge', async () => {
    const gt = vi.fn();
    const launchpad = vi.fn(async () => ({ launchpad: 'bankr' as const, launchpadUrl: 'https://bankr.bot/launches/x', imageUrl: 'https://ipfs/img', website: 'https://ignored' }));
    const enrich = createEnricher({
      dexscreener: async () => ({ priceUsd: 1, network: 'base', website: 'https://w' }),
      geckoterminal: gt,
      launchpad,
    });
    const info = await enrich(A, 'evm');
    expect(info).toEqual({
      priceUsd: 1,
      network: 'base',
      website: 'https://w',
      launchpad: 'bankr',
      launchpadUrl: 'https://bankr.bot/launches/x',
      imageUrl: 'https://ipfs/img',
      explorerUrl: `https://basescan.org/token/${A}`,
    });
    expect(gt).not.toHaveBeenCalled();
  });

  it('falls back to geckoterminal, then the launchpad fills socials and chain', async () => {
    const enrich = createEnricher({
      dexscreener: async () => undefined,
      geckoterminal: async () => ({ name: 'Bitcat', symbol: 'BITCAT', network: 'robinhood' }),
      launchpad: async () => ({ launchpad: 'pons' as const, launchpadUrl: 'https://www.ponsfamily.com/launchpad', website: 'https://bitcat.example', twitter: 'https://x.com/bitcat', name: 'Other' }),
      log: () => {},
    });
    const info = await enrich(A, 'evm');
    expect(info).toEqual({
      name: 'Bitcat',
      symbol: 'BITCAT',
      network: 'robinhood',
      launchpad: 'pons',
      launchpadUrl: 'https://www.ponsfamily.com/launchpad',
      website: 'https://bitcat.example',
      twitter: 'https://x.com/bitcat',
      explorerUrl: `https://robinhoodchain.blockscout.com/token/${A}`,
    });
  });

  it('a launchpad alone is enough to build a card for a brand-new launch', async () => {
    const enrich = createEnricher({
      dexscreener: async () => undefined,
      geckoterminal: async () => undefined,
      launchpad: async () => ({ launchpad: 'stonks' as const, launchpadUrl: 'u', network: 'base', symbol: 'NEW', imageUrl: 'i' }),
      log: () => {},
    });
    expect(await enrich(A, 'evm')).toEqual({
      launchpad: 'stonks',
      launchpadUrl: 'u',
      network: 'base',
      symbol: 'NEW',
      imageUrl: 'i',
      explorerUrl: `https://basescan.org/token/${A}`,
    });
  });

  it('survives a throwing source and logs it', async () => {
    const logs: string[] = [];
    const enrich = createEnricher({
      dexscreener: async () => {
        throw new Error('boom');
      },
      geckoterminal: async () => ({ symbol: 'GT', network: 'eth' }),
      log: (m) => logs.push(m),
    });
    expect(await enrich(A, 'evm')).toMatchObject({ symbol: 'GT' });
    expect(logs[0]).toContain('dexscreener failed');
  });

});

describe('explorerUrl', () => {
  it('maps known networks and returns undefined otherwise', () => {
    expect(explorerUrl('solana', 'X')).toBe('https://solscan.io/token/X');
    expect(explorerUrl('nope', 'X')).toBeUndefined();
    expect(explorerUrl(undefined, 'X')).toBeUndefined();
  });
});

describe('mapGeckoTerminal', () => {
  it('maps token, pool and info payloads', () => {
    const token = {
      data: {
        attributes: { name: 'Bitcat', symbol: 'BITCAT', image_url: null, price_usd: '0.001', fdv_usd: '1000', market_cap_usd: null, total_reserve_in_usd: '50' },
        relationships: { top_pools: { data: [{ id: 'robinhood_0xpool' }] } },
      },
    };
    const pool = { data: { attributes: { price_change_percentage: { h24: '12.5' }, reserve_in_usd: '60' } } };
    const info = { data: { attributes: { websites: ['https://bitcat.fun'], twitter_handle: 'bitcat', telegram_handle: null } } };
    expect(mapGeckoTerminal('robinhood', token, pool, info)).toEqual({
      network: 'robinhood',
      name: 'Bitcat',
      symbol: 'BITCAT',
      priceUsd: 0.001,
      marketCap: 1000,
      liquidity: 50,
      pairAddress: '0xpool',
      chartUrl: 'https://www.geckoterminal.com/robinhood/pools/0xpool',
      embedUrl: 'https://www.geckoterminal.com/robinhood/pools/0xpool?embed=1&info=0&swaps=0&grayscale=0&light_chart=0',
      change24h: 12.5,
      website: 'https://bitcat.fun',
      twitter: 'https://x.com/bitcat',
    });
  });
  it('maps eth slug to ethereum and tolerates missing pool', () => {
    const token = { data: { attributes: { name: 'X', symbol: 'X' }, relationships: { top_pools: { data: [] } } } };
    expect(mapGeckoTerminal('eth', token)).toEqual({ network: 'ethereum', name: 'X', symbol: 'X' });
  });
  it('returns undefined without data', () => {
    expect(mapGeckoTerminal('base', { errors: [] })).toBeUndefined();
  });
});
