import { describe, expect, it } from 'vitest';
import { addressWord, decodePumpCurve, decodeString, isV4PoolId, orientBySanity, priceFromReserves, priceFromSqrt, pumpPriceSol, words } from './pools.js';
import { CHAINS, coingeckoIdFor, alchemyUrl } from './chains.js';

describe('pool maths', () => {
  it('v2 reserves: 1 token = 0.002 quote when the pool holds 1000 tokens and 2 quote (18/18)', () => {
    expect(priceFromReserves(1000n * 10n ** 18n, 2n * 10n ** 18n, 18, 18)).toBeCloseTo(0.002, 9);
  });
  it('v2 reserves respect decimals: 1000 tokens (6 dec) against 2 USDC (6 dec) = 0.002; against 2 ETH (18 dec) = 0.002', () => {
    expect(priceFromReserves(1000n * 10n ** 6n, 2n * 10n ** 6n, 6, 6)).toBeCloseTo(0.002, 9);
    expect(priceFromReserves(1000n * 10n ** 6n, 2n * 10n ** 18n, 6, 18)).toBeCloseTo(0.002, 9);
  });
  it('sqrt price: a 1:1 pool at sqrtPriceX96 = 2^96 prices 1 either way round with equal decimals', () => {
    const one = 2n ** 96n;
    expect(priceFromSqrt(one, 18, 18, true)).toBeCloseTo(1, 9);
    expect(priceFromSqrt(one, 18, 18, false)).toBeCloseTo(1, 9);
  });
  it('sqrt price: the Robinhood Architects pool (token0 WETH 18, token1 ARCH 18, sqrt=11347964311365…) prices ARCH at ~1e-4 ETH', () => {
    const sqrt = 1134796431136500000000000000000000n; // tick 191402 → token1/token0 ≈ 2.05e8, sqrt ≈ 14318 × 2^96
    const archPerEth = priceFromSqrt(sqrt, 18, 18, true); // "price of token0 (ETH) in token1 (ARCH)"
    const ethPerArch = priceFromSqrt(sqrt, 18, 18, false);
    expect(archPerEth).toBeGreaterThan(1e8);
    expect(ethPerArch * archPerEth).toBeCloseTo(1, 6);
  });
  it('orientBySanity picks the side nearest the reference, or address order without one', () => {
    expect(orientBySanity(0.002, 500, 0.0021, false)).toBe(true);
    expect(orientBySanity(0.002, 500, 480, true)).toBe(false);
    expect(orientBySanity(0.002, 500, undefined, false)).toBe(false);
    expect(orientBySanity(0, 500, 0.002, true)).toBe(true);
  });
  it('decodes ABI words and addresses', () => {
    expect(words('0x' + '1'.padStart(64, '0') + 'ff'.padStart(64, '0'))).toEqual([1n, 255n]);
    expect(addressWord('0x' + 'abc'.padStart(64, '0'))).toBe('0x' + 'abc'.padStart(40, '0'));
    expect(isV4PoolId('0x' + 'f'.repeat(64))).toBe(true);
    expect(isV4PoolId('0x' + 'f'.repeat(40))).toBe(false);
  });
  it('decodes ABI strings and bytes32 symbols', () => {
    const abi = '0x' + (32n).toString(16).padStart(64, '0') + (4n).toString(16).padStart(64, '0') + Buffer.from('WETH').toString('hex').padEnd(64, '0');
    expect(decodeString(abi)).toBe('WETH');
    expect(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'))).toBe('MKR');
    expect(decodeString('0x')).toBeUndefined();
    expect(decodeString('0x' + (32n).toString(16).padStart(64, '0') + (0n).toString(16).padStart(64, '0'))).toBeUndefined();
  });
  it('decodes a pump.fun curve and prices it in SOL', () => {
    const buf = new Uint8Array(8 + 5 * 8 + 1);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(8, 1_000_000_000_000_000n, true); // 1e9 tokens (6 dec) virtual
    dv.setBigUint64(16, 30_000_000_000n, true); // 30 SOL virtual
    dv.setBigUint64(24, 800_000_000_000_000n, true);
    dv.setBigUint64(32, 0n, true);
    dv.setBigUint64(40, 1_000_000_000_000_000n, true);
    buf[48] = 0;
    const c = decodePumpCurve(buf)!;
    expect(c.complete).toBe(false);
    expect(c.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(pumpPriceSol(c)).toBeCloseTo(30 / 1e9, 15);
    expect(decodePumpCurve(new Uint8Array(10))).toBeUndefined();
  });
});

describe('chain registry', () => {
  it('every v4 manager is a lower-case address and every chain has an rpc', () => {
    for (const c of Object.values(CHAINS)) {
      expect(c.rpc).toMatch(/^https:\/\//);
      if (c.v4) expect(c.v4).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });
  it('maps quote coins to CoinGecko ids, wrapped or not, and builds Alchemy urls', () => {
    expect(coingeckoIdFor('WETH')).toBe('ethereum');
    expect(coingeckoIdFor('BNB')).toBe('binancecoin');
    expect(coingeckoIdFor('SOL')).toBe('solana');
    expect(coingeckoIdFor('NVDA')).toBeUndefined();
    expect(alchemyUrl(CHAINS.base, 'k')).toBe('https://base-mainnet.g.alchemy.com/v2/k');
    expect(alchemyUrl(CHAINS.robinhood, 'k')).toBeUndefined();
  });
});
