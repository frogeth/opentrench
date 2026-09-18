import { describe, it, expect } from 'vitest';
import { GENIUS_NETWORK_IDS, buildGeniusLinks, geniusAssetUrl } from './genius.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BRETT = '0x532f27101965dd16442E59d40670FaF5eBB142E4';

describe('genius', () => {
  it('opens a Solana mint on Genius with its SolM network id', () => {
    expect(geniusAssetUrl('solana', BONK)).toBe(`https://tradegenius.com/asset/${BONK}?network=1399811149`);
  });
  it('opens an EVM token with the chain id', () => {
    expect(geniusAssetUrl('base', BRETT)).toBe(`https://tradegenius.com/asset/${BRETT}?network=8453`);
    expect(geniusAssetUrl('robinhood', BRETT)).toBe(`https://tradegenius.com/asset/${BRETT}?network=4663`);
  });
  it('has no link for a chain Genius does not trade, or when the chain is unknown', () => {
    expect(geniusAssetUrl('megaeth', BRETT)).toBeUndefined();
    expect(geniusAssetUrl(undefined, BRETT)).toBeUndefined();
    expect(buildGeniusLinks('ink', BRETT)).toBeUndefined();
  });
  it('rejects an address that does not fit the chain', () => {
    expect(geniusAssetUrl('solana', BRETT)).toBeUndefined();
    expect(geniusAssetUrl('base', BONK)).toBeUndefined();
    expect(geniusAssetUrl('base', '0x123')).toBeUndefined();
  });
  it('builds a one-button buy row: no amounts, the asset page as panel and web', () => {
    const l = buildGeniusLinks('solana', BONK)!;
    expect(l.provider).toBe('genius');
    expect(l.amounts).toEqual([]);
    expect(l.panel).toBe(`https://tradegenius.com/asset/${BONK}?network=1399811149`);
    expect(l.web).toBe(l.panel);
  });
  it('covers every spot chain in the terminal, keyed by Dexscreener network id', () => {
    expect(Object.keys(GENIUS_NETWORK_IDS).sort()).toEqual(
      ['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'robinhood', 'solana', 'sonic'].sort(),
    );
  });
});
