import type { TokenInfo } from './types.js';

const API = 'https://api.dexscreener.com/latest/dex/tokens/';
/** Dexscreener accepts up to 30 comma-separated addresses per call. */
export const BATCH_MAX = 30;
const TIMEOUT_MS = 8000;

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}

export function dexscreenerEmbedUrl(chainId: string, pairAddress: string): string {
  return (
    `https://dexscreener.com/${chainId}/${pairAddress}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0` +
    `&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`
  );
}

export function mapDexscreener(json: any, address: string): Partial<TokenInfo> | undefined {
  const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
  const mine = pairs.filter((p) => String(p?.baseToken?.address ?? '').toLowerCase() === address.toLowerCase());
  if (mine.length === 0) return undefined;
  const best = mine.reduce((a, b) => ((num(b?.liquidity?.usd) ?? 0) > (num(a?.liquidity?.usd) ?? 0) ? b : a));

  const out: Partial<TokenInfo> = {};
  if (best.baseToken?.name) out.name = String(best.baseToken.name);
  if (best.baseToken?.symbol) out.symbol = String(best.baseToken.symbol);
  const price = num(best.priceUsd);
  if (price !== undefined) out.priceUsd = price;
  const mc = num(best.marketCap) ?? num(best.fdv);
  if (mc !== undefined) out.marketCap = mc;
  const liq = num(best.liquidity?.usd);
  if (liq !== undefined) out.liquidity = liq;
  const ch = num(best.priceChange?.h24);
  if (ch !== undefined) out.change24h = ch;
  const vol = num(best.volume?.h24);
  if (vol !== undefined) out.volume24h = vol;
  const buys = num(best.txns?.h24?.buys);
  if (buys !== undefined) out.buys24h = buys;
  const sells = num(best.txns?.h24?.sells);
  if (sells !== undefined) out.sells24h = sells;
  const created = num(best.pairCreatedAt);
  if (created !== undefined) out.pairCreatedAt = created;
  if (best.chainId) out.network = String(best.chainId);
  if (best.pairAddress) out.pairAddress = String(best.pairAddress);
  if (best.url) out.chartUrl = String(best.url);
  if (best.chainId && best.pairAddress) out.embedUrl = dexscreenerEmbedUrl(String(best.chainId), String(best.pairAddress));
  if (best.info?.imageUrl) out.imageUrl = String(best.info.imageUrl);
  const web = best.info?.websites?.[0]?.url;
  if (web) out.website = String(web);
  for (const s of best.info?.socials ?? []) {
    if (s?.type === 'twitter' && !out.twitter) out.twitter = String(s.url);
    if (s?.type === 'telegram' && !out.telegram) out.telegram = String(s.url);
  }
  return out;
}

export async function fetchDexscreener(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Partial<TokenInfo> | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(API + encodeURIComponent(address), { signal: ctl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    return mapDexscreener(await res.json(), address);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Per-chain batch: one pair per token, up to 30 tokens, so every token in the
 * request gets an answer (the chain-less endpoint caps the *pairs* at 30 and
 * silently drops tokens once a few busy ones have used the quota).
 */
export async function fetchDexscreenerChain(
  chainId: string,
  addresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Partial<TokenInfo>>> {
  const out = new Map<string, Partial<TokenInfo>>();
  if (addresses.length === 0) return out;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${chainId}/${addresses.slice(0, BATCH_MAX).map(encodeURIComponent).join(',')}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const json = await res.json();
    const pairs = Array.isArray(json) ? json : Array.isArray(json?.pairs) ? json.pairs : [];
    for (const a of addresses) {
      const info = mapDexscreener({ pairs }, a);
      if (info) out.set(a, info);
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

/** One request for many tokens; returns only those that have a pair. Keys are the addresses as passed. */
export async function fetchDexscreenerBatch(
  addresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Partial<TokenInfo>>> {
  const out = new Map<string, Partial<TokenInfo>>();
  if (addresses.length === 0) return out;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(API + addresses.slice(0, BATCH_MAX).map(encodeURIComponent).join(','), { signal: ctl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const json = await res.json();
    for (const a of addresses) {
      const info = mapDexscreener(json, a);
      if (info) out.set(a, info);
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}
