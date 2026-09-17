import { createHash } from 'node:crypto';
import { base58 } from './solana.js';

/**
 * Solana program-derived addresses without a Solana SDK: sha256 over the seeds, the bump, the
 * program id and the "ProgramDerivedAddress" tag, taking the first bump whose hash is not a
 * point on ed25519. The curve check is the standard decompression test (RFC 8032 §5.1.3).
 */
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint): bigint {
  return modPow(a, P - 2n);
}

/** true when the 32 bytes decompress to a point on ed25519 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] & (i === 31 ? 0x7f : 0xff));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x² = u / v; candidate root per RFC 8032
  const v3 = (v * v * v) % P;
  const v7 = (v3 * v3 * v) % P;
  let x = (u * v3 * modPow(u * v7, (P - 5n) / 8n)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
    return (v * x * x) % P === u;
  }
  return false;
}

const b58decode = (s: string): Uint8Array => {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
};
export const decodeBase58 = b58decode;

/** seeds: strings (utf8) or raw bytes or base58 public keys (32 bytes) */
export function findProgramAddress(seeds: (string | Uint8Array)[], programId: string): { address: string; bump: number } {
  const seedBytes = seeds.map((s) => (typeof s === 'string' ? (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58decode(s).length === 32 ? b58decode(s) : new Uint8Array(Buffer.from(s, 'utf8'))) : s));
  const program = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seedBytes) h.update(s);
    h.update(new Uint8Array([bump]));
    h.update(program);
    h.update(Buffer.from('ProgramDerivedAddress', 'utf8'));
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return { address: base58(out), bump };
  }
  throw new Error('no bump');
}

/** an explicit utf8 seed (for a seed that happens to look like base58) */
export const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
