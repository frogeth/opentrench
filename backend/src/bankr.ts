import type { TokenInfo } from './types.js';

/**
 * Bankr launchpad (Base + Robinhood Chain). Its per-token endpoint knows the
 * name, launch chain, website and the deployer's X handle minutes before any
 * chart site has a pair — the same trick frogr uses for fresh launches.
 */

const API = 'https://api.bankr.bot/token-launches/';
const TIMEOUT_MS = 6000;

export function mapBankr(json: any): Partial<TokenInfo> | undefined {
  const l = json?.launch ?? json;
  if (!l || typeof l !== 'object' || !l.tokenAddress) return undefined;
  const out: Partial<TokenInfo> = {};
  if (l.tokenName) out.name = String(l.tokenName);
  if (l.tokenSymbol) out.symbol = String(l.tokenSymbol);
  if (l.chain) out.network = String(l.chain).toLowerCase() === 'robinhood' ? 'robinhood' : 'base';
  if (l.websiteUrl) out.website = String(l.websiteUrl);
  const x = l.deployer?.xUsername ?? l.feeRecipient?.xUsername;
  if (x) out.twitter = `https://x.com/${String(x).replace(/^@/, '')}`;
  return out;
}

export async function fetchBankr(address: string, fetchImpl: typeof fetch = fetch): Promise<Partial<TokenInfo> | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(API + encodeURIComponent(address), { signal: ctl.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`bankr ${res.status}`);
    const json = await res.json();
    if (json?.error) return undefined;
    return mapBankr(json);
  } finally {
    clearTimeout(t);
  }
}
