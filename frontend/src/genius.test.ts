import { describe, it, expect } from 'vitest';
import { geniusAssetUrl, looksLikeSolanaAddress } from './format';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BRETT = '0x532f27101965dd16442E59d40670FaF5eBB142E4';

describe('geniusAssetUrl', () => {
  it('mirrors the backend: asset page keyed by the Genius network id', () => {
    expect(geniusAssetUrl('solana', BONK)).toBe(`https://tradegenius.com/asset/${BONK}?network=1399811149`);
    expect(geniusAssetUrl('base', BRETT)).toBe(`https://tradegenius.com/asset/${BRETT}?network=8453`);
  });
  it('is undefined off Genius or without a chain', () => {
    expect(geniusAssetUrl('ink', BRETT)).toBeUndefined();
    expect(geniusAssetUrl(undefined, BRETT)).toBeUndefined();
  });
  it('tells a Solana mint from an EVM address for the right-click path', () => {
    expect(looksLikeSolanaAddress(BONK)).toBe(true);
    expect(looksLikeSolanaAddress(BRETT)).toBe(false);
  });
});
