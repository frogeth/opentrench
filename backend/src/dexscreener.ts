import type { TokenInfo } from './types.js';

const API = 'https://api.dexscreener.com/latest/dex/tokens/';
const TIMEOUT_MS = 8000;

export type TokenFetcher = (address: string) => Promise<Partial<TokenInfo> | undefined>;

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
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
  if (best.url) out.chartUrl = String(best.url);
  if (best.info?.imageUrl) out.imageUrl = String(best.info.imageUrl);
  const web = best.info?.websites?.[0]?.url;
  if (web) out.website = String(web);
  for (const s of best.info?.socials ?? []) {
    if (s?.type === 'twitter' && !out.twitter) out.twitter = String(s.url);
    if (s?.type === 'telegram' && !out.telegram) out.telegram = String(s.url);
  }
  return out;
}

export const fetchToken: TokenFetcher = async (address) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + encodeURIComponent(address), { signal: ctl.signal });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    return mapDexscreener(await res.json(), address);
  } finally {
    clearTimeout(t);
  }
};
