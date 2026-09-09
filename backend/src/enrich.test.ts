import { describe, it, expect, vi } from 'vitest';
import { createEnricher, explorerUrl } from './enrich.js';
import { mapGeckoTerminal } from './geckoterminal.js';
import { mapBankr } from './bankr.js';

const A = '0xa419Bb493ed5059f28dfd84348A2F93D70ECf003';

describe('createEnricher', () => {
  it('uses dexscreener when it has a pair and skips the rest', async () => {
    const gt = vi.fn();
    const bankr = vi.fn();
    const enrich = createEnricher({
      dexscreener: async () => ({ priceUsd: 1, network: 'base', website: 'https://w' }),
      geckoterminal: gt,
      bankr,
    });
    const info = await enrich(A, 'evm');
    expect(info).toMatchObject({ priceUsd: 1, network: 'base', explorerUrl: `https://basescan.org/token/${A}` });
    expect(gt).not.toHaveBeenCalled();
    expect(bankr).not.toHaveBeenCalled();
  });

  it('falls back to geckoterminal, then bankr for socials', async () => {
    const enrich = createEnricher({
      dexscreener: async () => undefined,
      geckoterminal: async () => ({ name: 'Bitcat', symbol: 'BITCAT', network: 'robinhood' }),
      bankr: async () => ({ website: 'https://bitcat.example', twitter: 'https://x.com/bitcat', name: 'Other' }),
      log: () => {},
    });
    const info = await enrich(A, 'evm');
    expect(info).toEqual({
      name: 'Bitcat',
      symbol: 'BITCAT',
      network: 'robinhood',
      website: 'https://bitcat.example',
      twitter: 'https://x.com/bitcat',
      explorerUrl: `https://robinhoodchain.blockscout.com/token/${A}`,
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

  it('does not call bankr for solana', async () => {
    const bankr = vi.fn();
    const enrich = createEnricher({ dexscreener: async () => undefined, bankr, log: () => {} });
    await enrich('So1', 'sol');
    expect(bankr).not.toHaveBeenCalled();
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

describe('mapBankr', () => {
  it('maps a launch record', () => {
    expect(
      mapBankr({
        tokenAddress: A,
        tokenName: 'Bitcat',
        tokenSymbol: 'BITCAT',
        chain: 'robinhood',
        websiteUrl: 'https://bitcat.fun',
        deployer: { walletAddress: '0x1', xUsername: 'deployer' },
      }),
    ).toEqual({
      name: 'Bitcat',
      symbol: 'BITCAT',
      network: 'robinhood',
      website: 'https://bitcat.fun',
      twitter: 'https://x.com/deployer',
    });
  });
  it('returns undefined for error bodies', () => {
    expect(mapBankr({ error: 'Token not found' })).toBeUndefined();
  });
});
