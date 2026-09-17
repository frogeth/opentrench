/**
 * Solana pool decoders: which program owns the pool account tells us its layout; the layout gives
 * the mints and either a price directly (sqrt price, bin id, virtual reserves) or the two vault
 * token accounts whose balances are the price. Offsets were verified against live pools on
 * 2026-09-17 (see onchain/live.ts for how they are used).
 *
 * Every price here is "quote per base in raw units"; live.ts scales by decimals.
 */
import { decodePumpCurve, pumpPriceSol } from './pools.js';

export const PROGRAMS = {
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  raydiumV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydiumClmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  raydiumLaunchlab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  meteoraDammV2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  meteoraDbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;
export type SolanaKind = keyof typeof PROGRAMS;
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 of 32 bytes, no dependency */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => (dv(d).getBigUint64(o + 8, true) << 64n) | dv(d).getBigUint64(o, true);
const i32 = (d: Uint8Array, o: number) => dv(d).getInt32(o, true);
const u16 = (d: Uint8Array, o: number) => dv(d).getUint16(o, true);
const key = (d: Uint8Array, o: number) => base58(d.subarray(o, o + 32));

/** SPL token account: amount at 64; mint account: decimals at 44 */
export const tokenAccountAmount = (d: Uint8Array): bigint | undefined => (d.length >= 72 ? u64(d, 64) : undefined);
export const mintDecimals = (d: Uint8Array): number | undefined => (d.length >= 82 ? d[44] : undefined);

/** Q64.64 sqrt price → token1/token0 in raw units */
export const priceFromSqrt64 = (s: bigint): number => {
  const r = Number(s) / 2 ** 64;
  return r * r;
};

/**
 * What a pool account says about itself. `price` is quote-per-base in raw units when the account
 * alone gives it; otherwise `vaults` are the two token accounts (base, quote) to read balances from.
 * `quoteFromConfig` (DBC) names the account that carries the quote mint.
 */
export interface SolanaPool {
  kind: SolanaKind;
  baseMint?: string;
  quoteMint?: string;
  /** raw-unit price when the account carries it */
  price?: number;
  /** [baseVault, quoteVault] token accounts whose balances are the price (raw units) */
  vaults?: [string, string];
  /** amounts already subtracted from the vaults (fees, pnl), base then quote, raw units */
  vaultLess?: [bigint, bigint];
  /** the curve finished / migrated: this account no longer trades */
  done?: boolean;
  /** base decimals when the account stores them (else read the mint) */
  baseDecimals?: number;
  quoteDecimals?: number;
  /** DBC: the config account holding the quote mint at offset 8 */
  quoteFromConfig?: string;
  /** curve supply in raw units, when the account carries it */
  supplyRaw?: bigint;
}

export function kindOf(owner: string): SolanaKind | undefined {
  return (Object.entries(PROGRAMS) as [SolanaKind, string][]).find(([, p]) => p === owner)?.[0];
}

/** Decode a pool account; `base` is the token we are pricing, so two-sided pools come out oriented. */
export function decodeSolanaPool(kind: SolanaKind, d: Uint8Array, base: string): SolanaPool | undefined {
  try {
    switch (kind) {
      case 'pumpfun': {
        const c = decodePumpCurve(d);
        if (!c) return undefined;
        return { kind, baseMint: base, quoteMint: SOL_MINT, price: pumpPriceSol(c) * 1e9 / 1e6, done: c.complete, baseDecimals: 6, quoteDecimals: 9, supplyRaw: c.tokenTotalSupply };
      }
      case 'pumpswap': {
        if (d.length < 203) return undefined;
        const m0 = key(d, 43), m1 = key(d, 75), v0 = key(d, 139), v1 = key(d, 171);
        return m0 === base ? { kind, baseMint: m0, quoteMint: m1, vaults: [v0, v1] } : m1 === base ? { kind, baseMint: m1, quoteMint: m0, vaults: [v1, v0] } : undefined;
      }
      case 'raydiumV4': {
        if (d.length < 464) return undefined;
        const bd = Number(u64(d, 32)), qd = Number(u64(d, 40));
        const bv = key(d, 336), qv = key(d, 368), bm = key(d, 400), qm = key(d, 432);
        const bp = u64(d, 192), qp = u64(d, 200);
        if (bm === base) return { kind, baseMint: bm, quoteMint: qm, vaults: [bv, qv], vaultLess: [bp, qp], baseDecimals: bd, quoteDecimals: qd };
        if (qm === base) return { kind, baseMint: qm, quoteMint: bm, vaults: [qv, bv], vaultLess: [qp, bp], baseDecimals: qd, quoteDecimals: bd };
        return undefined;
      }
      case 'raydiumCpmm': {
        if (d.length < 373) return undefined;
        const v0 = key(d, 72), v1 = key(d, 104), m0 = key(d, 168), m1 = key(d, 200);
        const d0 = d[331], d1 = d[332];
        const less0 = u64(d, 341) + u64(d, 357), less1 = u64(d, 349) + u64(d, 365);
        if (m0 === base) return { kind, baseMint: m0, quoteMint: m1, vaults: [v0, v1], vaultLess: [less0, less1], baseDecimals: d0, quoteDecimals: d1 };
        if (m1 === base) return { kind, baseMint: m1, quoteMint: m0, vaults: [v1, v0], vaultLess: [less1, less0], baseDecimals: d1, quoteDecimals: d0 };
        return undefined;
      }
      case 'raydiumClmm': {
        if (d.length < 269) return undefined;
        const m0 = key(d, 73), m1 = key(d, 105);
        const p01 = priceFromSqrt64(u128(d, 253));
        if (m0 === base) return { kind, baseMint: m0, quoteMint: m1, price: p01, baseDecimals: d[233], quoteDecimals: d[234] };
        if (m1 === base) return { kind, baseMint: m1, quoteMint: m0, price: p01 > 0 ? 1 / p01 : 0, baseDecimals: d[234], quoteDecimals: d[233] };
        return undefined;
      }
      case 'raydiumLaunchlab': {
        if (d.length < 269) return undefined;
        const bm = key(d, 205), qm = key(d, 237);
        if (bm !== base) return undefined;
        const vb = u64(d, 37), vq = u64(d, 45), rb = u64(d, 53), rq = u64(d, 61);
        const denom = vb - rb;
        return { kind, baseMint: bm, quoteMint: qm, price: denom > 0n ? Number(vq + rq) / Number(denom) : 0, baseDecimals: d[18], quoteDecimals: d[19], done: d[17] >= 2, supplyRaw: u64(d, 21) };
      }
      case 'meteoraDlmm': {
        if (d.length < 152) return undefined;
        const mx = key(d, 88), my = key(d, 120);
        const pxy = Math.pow(1 + u16(d, 80) / 10000, i32(d, 76));
        if (mx === base) return { kind, baseMint: mx, quoteMint: my, price: pxy };
        if (my === base) return { kind, baseMint: my, quoteMint: mx, price: pxy > 0 ? 1 / pxy : 0 };
        return undefined;
      }
      case 'meteoraDammV2': {
        if (d.length < 472) return undefined;
        const ma = key(d, 168), mb = key(d, 200);
        const pab = priceFromSqrt64(u128(d, 456));
        if (ma === base) return { kind, baseMint: ma, quoteMint: mb, price: pab };
        if (mb === base) return { kind, baseMint: mb, quoteMint: ma, price: pab > 0 ? 1 / pab : 0 };
        return undefined;
      }
      case 'meteoraDbc': {
        if (d.length < 296) return undefined;
        const bm = key(d, 136);
        if (bm !== base) return undefined;
        return { kind, baseMint: bm, price: priceFromSqrt64(u128(d, 280)), quoteFromConfig: key(d, 72) };
      }
      case 'orca': {
        if (d.length < 245) return undefined;
        const ma = key(d, 101), mb = key(d, 181);
        const pab = priceFromSqrt64(u128(d, 65));
        if (ma === base) return { kind, baseMint: ma, quoteMint: mb, price: pab };
        if (mb === base) return { kind, baseMint: mb, quoteMint: ma, price: pab > 0 ? 1 / pab : 0 };
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
}
