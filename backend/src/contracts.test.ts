import { describe, it, expect } from 'vitest';
import { detectContracts } from './contracts.js';

const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK mint, 32 bytes
const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT
const SOL_SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'; // 64 bytes

describe('detectContracts', () => {
  it('finds an EVM address', () => {
    expect(detectContracts(`ape ${EVM} now`)).toEqual([{ chain: 'evm', address: EVM }]);
  });
  it('finds a Solana address', () => {
    expect(detectContracts(`CA: ${SOL}`)).toEqual([{ chain: 'sol', address: SOL }]);
  });
  it('finds both and keeps order', () => {
    expect(detectContracts(`${SOL} and ${EVM}`)).toEqual([
      { chain: 'sol', address: SOL },
      { chain: 'evm', address: EVM },
    ]);
  });
  it('dedupes within a message (EVM case-insensitive)', () => {
    expect(detectContracts(`${EVM} ${EVM.toLowerCase()} ${SOL} ${SOL}`)).toHaveLength(2);
  });
  it('ignores a Solana tx signature (64 bytes)', () => {
    expect(detectContracts(SOL_SIG)).toEqual([]);
  });
  it('ignores an EVM tx hash', () => {
    expect(detectContracts('0x' + 'ab'.repeat(32))).toEqual([]);
  });
  it('finds a Solana address inside a URL path', () => {
    expect(detectContracts(`https://pump.fun/coin/${SOL}`)).toEqual([{ chain: 'sol', address: SOL }]);
  });
  it('ignores plain words', () => {
    expect(detectContracts('thisIsJustAVeryLongWordWithoutAnyNumbersInItAtAll')).toEqual([]);
  });
  it('returns [] for empty text', () => {
    expect(detectContracts('')).toEqual([]);
  });
});
