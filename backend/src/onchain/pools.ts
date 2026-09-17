/**
 * Pure pool maths: reserves or a sqrt price in, the token's price in its quote asset out.
 * Nothing here touches the network; rpc.ts fetches the words, live.ts wires it together.
 */

/** ERC-20 and pool selectors (keccak of the signature, first 4 bytes). */
export const SEL = {
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  slot0: '0x3850c7bd',
  extsload: '0x1e2eaeaf',
} as const;

export type PoolKind = 'v2' | 'v3' | 'v4' | 'pumpfun';

const Q96 = 2n ** 96n;

/** Decode one or more ABI words from an eth_call result (32-byte big-endian each). */
export function words(hex: string): bigint[] {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
}

/** An ABI string (offset, length, bytes) or a bytes32 symbol (MKR-style); undefined when unreadable. */
export function decodeString(hex: string): string | undefined {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const text = (bytes: string) => {
    const s = Buffer.from(bytes, 'hex').toString('utf8').replace(/\0+$/g, '').trim();
    return s && /^[\x20-\x7e]{1,40}$/.test(s) ? s : undefined;
  };
  if (h.length === 64) return text(h);
  const [offset, ...rest] = words(hex);
  if (offset === undefined || rest.length === 0) return undefined;
  const at = Number(offset) * 2;
  const len = Number(BigInt('0x' + (h.slice(at, at + 64) || '0')));
  if (!Number.isFinite(len) || len <= 0 || len > 64) return undefined;
  return text(h.slice(at + 64, at + 64 + len * 2));
}

export function addressWord(hex: string): string | undefined {
  const [w] = words(hex);
  return w === undefined ? undefined : '0x' + w.toString(16).padStart(40, '0').slice(-40);
}

/** Uniswap v4: the pool's slot0 lives at keccak256(poolId ‖ POOLS_SLOT) in the PoolManager's storage; the low 160 bits are sqrtPriceX96. */
export const V4_POOLS_SLOT = 6n;

/**
 * price of `token` in units of `quote` from a v3/v4 sqrtPriceX96, which is sqrt(token1/token0) in raw units.
 * tokenIs0: our token is token0 (so token1 = quote).
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenDecimals: number, quoteDecimals: number, tokenIs0: boolean): number {
  if (sqrtPriceX96 <= 0n) return 0;
  // ratio = token1 per token0 in raw units; scale to 1e18 fixed point with bigint to keep precision
  const SCALE = 10n ** 36n;
  const ratioRaw = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / (Q96 * Q96); // token1/token0 * 1e36
  const ratio = Number(ratioRaw) / 1e36;
  if (!Number.isFinite(ratio) || ratio === 0) return 0;
  // token1 per token0 adjusted for decimals: (token1 units) / (token0 units)
  return tokenIs0 ? ratio * 10 ** (tokenDecimals - quoteDecimals) : (1 / ratio) * 10 ** (tokenDecimals - quoteDecimals);
}

/** v2: price of our token in quote = reserveQuote/reserveToken, decimals adjusted. */
export function priceFromReserves(reserveToken: bigint, reserveQuote: bigint, tokenDecimals: number, quoteDecimals: number): number {
  if (reserveToken <= 0n || reserveQuote <= 0n) return 0;
  const SCALE = 10n ** 18n;
  const r = Number((reserveQuote * SCALE) / reserveToken) / 1e18;
  return r * 10 ** (tokenDecimals - quoteDecimals);
}

/** pump.fun bonding curve account (little-endian u64s after an 8-byte discriminator). */
export interface PumpCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}
export function decodePumpCurve(data: Uint8Array): PumpCurve | undefined {
  if (data.length < 8 + 5 * 8 + 1) return undefined;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  return {
    virtualTokenReserves: u64(8),
    virtualSolReserves: u64(16),
    realTokenReserves: u64(24),
    realSolReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: data[48] === 1,
  };
}
/** price in SOL per token: virtual SOL (lamports, 1e9) over virtual tokens (1e6). */
export function pumpPriceSol(c: PumpCurve): number {
  if (c.virtualTokenReserves <= 0n) return 0;
  return priceFromReserves(c.virtualTokenReserves, c.virtualSolReserves, 6, 9);
}

/**
 * Which way round a v3/v4 pool is: given both possible prices, pick the orientation whose result sits
 * closest (in log space) to a reference price when one exists, else the one where the token is token0
 * by address order. Returns tokenIs0.
 */
export function orientBySanity(priceIfToken0: number, priceIfToken1: number, reference: number | undefined, tokenIs0ByAddress: boolean): boolean {
  if (reference && reference > 0 && priceIfToken0 > 0 && priceIfToken1 > 0) {
    const d0 = Math.abs(Math.log(priceIfToken0 / reference));
    const d1 = Math.abs(Math.log(priceIfToken1 / reference));
    return d0 <= d1;
  }
  return tokenIs0ByAddress;
}

/** A 32-byte pool id (v4) rather than a 20-byte address. */
export const isV4PoolId = (pair: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(pair);
