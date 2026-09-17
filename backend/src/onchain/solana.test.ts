import { describe, expect, it } from 'vitest';
import { base58, decodeSolanaPool, kindOf, mintDecimals, PROGRAMS, priceFromSqrt64, SOL_MINT, tokenAccountAmount } from './solana.js';

const bytes = (n: number) => new Uint8Array(n);
const put = (d: Uint8Array, o: number, v: bigint, size = 8) => { for (let i = 0; i < size; i++) d[o + i] = Number((v >> BigInt(8 * i)) & 0xffn); };
const putKey = (d: Uint8Array, o: number, k: Uint8Array) => d.set(k, o);
const K_BASE = new Uint8Array(32).fill(7);
const K_QUOTE = new Uint8Array(32).fill(9);
const K_V0 = new Uint8Array(32).fill(3);
const K_V1 = new Uint8Array(32).fill(4);
const BASE = base58(K_BASE), QUOTE = base58(K_QUOTE);

describe('solana decoders', () => {
  it('base58 matches the well-known SOL mint and keeps leading zero bytes', () => {
    const one = new Uint8Array(32); one[31] = 1;
    expect(base58(one)).toBe('11111111111111111111111111111112');
    expect(base58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(kindOf(PROGRAMS.orca)).toBe('orca');
    expect(kindOf('nope')).toBeUndefined();
  });
  it('token account amount and mint decimals sit where SPL puts them', () => {
    const ta = bytes(165); put(ta, 64, 123n);
    expect(tokenAccountAmount(ta)).toBe(123n);
    const mint = bytes(82); mint[44] = 6;
    expect(mintDecimals(mint)).toBe(6);
    expect(tokenAccountAmount(bytes(10))).toBeUndefined();
  });
  it('pumpswap: vaults oriented to the base, whichever side it is', () => {
    const d = bytes(301); putKey(d, 43, K_BASE); putKey(d, 75, K_QUOTE); putKey(d, 139, K_V0); putKey(d, 171, K_V1);
    expect(decodeSolanaPool('pumpswap', d, BASE)).toEqual({ kind: 'pumpswap', baseMint: BASE, quoteMint: QUOTE, vaults: [base58(K_V0), base58(K_V1)] });
    expect(decodeSolanaPool('pumpswap', d, QUOTE)!.vaults).toEqual([base58(K_V1), base58(K_V0)]);
    expect(decodeSolanaPool('pumpswap', d, 'other')).toBeUndefined();
  });
  it('raydium v4: vaults, pnl to subtract and decimals', () => {
    const d = bytes(752); put(d, 32, 6n); put(d, 40, 9n); put(d, 192, 5n); put(d, 200, 7n); putKey(d, 336, K_V0); putKey(d, 368, K_V1); putKey(d, 400, K_BASE); putKey(d, 432, K_QUOTE);
    expect(decodeSolanaPool('raydiumV4', d, BASE)).toEqual({ kind: 'raydiumV4', baseMint: BASE, quoteMint: QUOTE, vaults: [base58(K_V0), base58(K_V1)], vaultLess: [5n, 7n], baseDecimals: 6, quoteDecimals: 9 });
    expect(decodeSolanaPool('raydiumV4', d, QUOTE)!.vaultLess).toEqual([7n, 5n]);
  });
  it('raydium cpmm: fees (protocol + fund) come off the vault balances', () => {
    const d = bytes(637); putKey(d, 72, K_V0); putKey(d, 104, K_V1); putKey(d, 168, K_BASE); putKey(d, 200, K_QUOTE); d[331] = 6; d[332] = 9; put(d, 341, 1n); put(d, 349, 2n); put(d, 357, 10n); put(d, 365, 20n);
    expect(decodeSolanaPool('raydiumCpmm', d, BASE)).toMatchObject({ vaults: [base58(K_V0), base58(K_V1)], vaultLess: [11n, 22n], baseDecimals: 6, quoteDecimals: 9 });
  });
  it('raydium clmm, orca and damm v2: Q64.64 sqrt price, inverted when the base is token1', () => {
    const sqrt = 2n ** 64n * 3n; // price 9
    const clmm = bytes(1544); putKey(clmm, 73, K_BASE); putKey(clmm, 105, K_QUOTE); clmm[233] = 6; clmm[234] = 9; put(clmm, 253, sqrt, 16);
    expect(decodeSolanaPool('raydiumClmm', clmm, BASE)).toMatchObject({ price: 9, baseDecimals: 6, quoteDecimals: 9 });
    expect(decodeSolanaPool('raydiumClmm', clmm, QUOTE)!.price).toBeCloseTo(1 / 9, 12);
    const orca = bytes(653); putKey(orca, 101, K_BASE); putKey(orca, 181, K_QUOTE); put(orca, 65, sqrt, 16);
    expect(decodeSolanaPool('orca', orca, BASE)!.price).toBe(9);
    const damm = bytes(1112); putKey(damm, 168, K_QUOTE); putKey(damm, 200, K_BASE); put(damm, 456, sqrt, 16);
    expect(decodeSolanaPool('meteoraDammV2', damm, BASE)!.price).toBeCloseTo(1 / 9, 12);
    expect(priceFromSqrt64(0n)).toBe(0);
  });
  it('meteora dlmm: (1 + step/10000)^activeId', () => {
    const d = bytes(904); putKey(d, 88, K_BASE); putKey(d, 120, K_QUOTE); put(d, 80, 100n, 2); put(d, 76, BigInt.asUintN(32, -178n), 4);
    expect(decodeSolanaPool('meteoraDlmm', d, BASE)!.price).toBeCloseTo(1.01 ** -178, 15);
  });
  it('meteora dbc: sqrt price plus the config account that names the quote', () => {
    const d = bytes(424); putKey(d, 72, K_V0); putKey(d, 136, K_BASE); put(d, 280, 2n ** 64n * 2n, 16);
    expect(decodeSolanaPool('meteoraDbc', d, BASE)).toEqual({ kind: 'meteoraDbc', baseMint: BASE, price: 4, quoteFromConfig: base58(K_V0) });
    expect(decodeSolanaPool('meteoraDbc', d, QUOTE)).toBeUndefined();
  });
  it('raydium launchlab: constant-product curve on virtual + real reserves', () => {
    const d = bytes(429); d[17] = 0; d[18] = 6; d[19] = 9; put(d, 21, 1_000_000n); put(d, 37, 1_000_000n); put(d, 45, 30n); put(d, 53, 200_000n); put(d, 61, 10n); putKey(d, 205, K_BASE); putKey(d, 237, K_QUOTE);
    const p = decodeSolanaPool('raydiumLaunchlab', d, BASE)!;
    expect(p.price).toBeCloseTo(40 / 800_000, 15);
    expect(p).toMatchObject({ quoteMint: QUOTE, baseDecimals: 6, quoteDecimals: 9, done: false, supplyRaw: 1_000_000n });
    d[17] = 2;
    expect(decodeSolanaPool('raydiumLaunchlab', d, BASE)!.done).toBe(true);
  });
  it('pump.fun: curve price in raw units and SOL as the quote', () => {
    const d = bytes(151); put(d, 8, 1_000_000_000_000_000n); put(d, 16, 30_000_000_000n); put(d, 40, 1_000_000_000_000_000n);
    const p = decodeSolanaPool('pumpfun', d, BASE)!;
    expect(p.quoteMint).toBe(SOL_MINT);
    expect(p.price * 1e6 / 1e9).toBeCloseTo(30 / 1e9, 15); // raw → whole units: 3e-8 SOL per token
    expect(p.done).toBe(false);
  });
  it('a short or garbage account is undefined, never a throw', () => {
    for (const k of Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[]) expect(decodeSolanaPool(k, bytes(5), BASE)).toBeUndefined();
  });
});
