import bs58 from 'bs58';
import type { BuyLinks } from './types.js';

/**
 * Cove (t.me/cove_trading_bot) deep links, same wire format frogr uses:
 *   g_<amount><chainCode><token base62>[<affiliate 7><group 7>]   one-click buy
 *   b_<chainCode><token base62>[<affiliate 7><group 7>]           market panel
 * Token bytes are base62 with fixed width (27 chars for 20-byte EVM, 43 for
 * 32-byte Solana). Amounts: integer or "1d5" for 1.5, max 9999.
 */

const COVE_BOT = 'cove_trading_bot';
const PAYLOAD_MAX = 64;

/**
 * Dexscreener network id → Cove chain code (docs.cove.trade/builders/deep-links).
 * Robinhood's 'r' is not in the published table but is what Cove's own panels use.
 * Arbitrum, Ink and Stable are tradeable on Cove but have no published deep-link
 * code yet; the bare CA still works when sent to the bot directly.
 */
export const CHAIN_CODES: Record<string, string> = {
  ethereum: 'e',
  base: 'b',
  bsc: 'n',
  megaeth: 'm',
  robinhood: 'r',
  solana: 's',
  tempo: 't',
  monad: 'o',
  story: 'y',
  hyperevm: 'h',
  plasma: 'p',
};

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function intToBase62(value: bigint, width: number): string {
  if (value < 0n) throw new Error('negative not supported');
  let v = value;
  const out: string[] = [];
  if (v === 0n) out.push('0');
  while (v > 0n) {
    out.push(ALPHABET[Number(v % 62n)]!);
    v /= 62n;
  }
  const s = out.reverse().join('');
  if (s.length > width) throw new Error(`value exceeds width ${width}`);
  return s.padStart(width, '0');
}

export function bytesToBase62(bytes: Uint8Array, width: number): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return intToBase62(v, width);
}

const AMOUNT_PATTERN = /^(?:[0-9]{1,4}|[0-9]{1,2}d[0-9]{1,2})$/;

export function encodeAmount(amountUsd: number): string {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error(`invalid amount: ${amountUsd}`);
  if (amountUsd > 9999) throw new Error(`amount exceeds 9999: ${amountUsd}`);
  const encoded = String(amountUsd).replace('.', 'd');
  if (!AMOUNT_PATTERN.test(encoded)) throw new Error(`invalid encoded amount: ${encoded}`);
  return encoded;
}

export function encodeToken(network: string, address: string): string {
  if (network === 'solana') {
    const bytes = bs58.decode(address);
    if (bytes.length !== 32) throw new Error('Solana address must decode to 32 bytes');
    return bytesToBase62(bytes, 43);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`invalid EVM address: ${address}`);
  const hex = address.slice(2).toLowerCase();
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytesToBase62(bytes, 27);
}

function affiliateTail(affiliateId?: string): string {
  if (!affiliateId) return '';
  let id: bigint;
  try {
    id = BigInt(affiliateId.trim());
  } catch {
    return '';
  }
  if (id <= 0n) return '';
  // No per-group attribution from a personal feed: group field is zero.
  return intToBase62(id, 7) + '0000000';
}

function url(payload: string): string {
  if (payload.length > PAYLOAD_MAX) throw new Error(`payload too long (${payload.length})`);
  return `https://t.me/${COVE_BOT}?start=${payload}`;
}

export interface CoveOptions {
  amounts: number[];
  affiliateId?: string;
}

/** undefined when the chain isn't on Cove or the address can't be encoded. */
export function buildCoveLinks(network: string | undefined, address: string, opts: CoveOptions): BuyLinks | undefined {
  if (!network) return undefined;
  const code = CHAIN_CODES[network];
  if (!code) return undefined;
  try {
    const token = encodeToken(network, address);
    const tail = affiliateTail(opts.affiliateId);
    const amounts = opts.amounts
      .filter((a) => Number.isFinite(a) && a > 0 && a <= 9999)
      .map((usd) => ({ usd, url: url(`g_${encodeAmount(usd)}${code}${token}${tail}`) }));
    return { provider: 'cove', amounts, panel: url(`b_${code}${token}${tail}`) };
  } catch (e: any) {
    console.warn('[cove] link failed', address, e?.message ?? e);
    return undefined;
  }
}
