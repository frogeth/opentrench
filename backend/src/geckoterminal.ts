import type { Chain, TokenInfo } from './types.js';

/**
 * GeckoTerminal fallback for tokens Dexscreener hasn't indexed yet (fresh
 * pairs, small chains such as Robinhood Chain). Free tier is ~30 req/min, so
 * every request goes through a spacing queue and a 429 aborts the probe.
 */

const API = 'https://api.geckoterminal.com/api/v2';
const TIMEOUT_MS = 8000;
const MIN_SPACING_MS = 2500;

/** GT network slugs to probe, most likely first. */
export const GT_NETWORKS: Record<Chain, string[]> = {
  evm: ['robinhood', 'base', 'eth', 'bsc', 'arbitrum'],
  sol: ['solana'],
};

/** GT slug -> dexscreener-style chain id used everywhere else in the app. */
const GT_TO_NETWORK: Record<string, string> = { eth: 'ethereum' };
export function networkFromGt(slug: string): string {
  return GT_TO_NETWORK[slug] ?? slug;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}

export function geckoEmbedUrl(network: string, pool: string): string {
  return `https://www.geckoterminal.com/${network}/pools/${pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;
}

export function mapGeckoTerminal(slug: string, tokenJson: any, poolJson?: any, infoJson?: any): Partial<TokenInfo> | undefined {
  const a = tokenJson?.data?.attributes;
  if (!a) return undefined;
  const out: Partial<TokenInfo> = { network: networkFromGt(slug) };
  if (a.name) out.name = String(a.name);
  if (a.symbol) out.symbol = String(a.symbol);
  if (a.image_url) out.imageUrl = String(a.image_url);
  const price = num(a.price_usd);
  if (price !== undefined) out.priceUsd = price;
  const mc = num(a.market_cap_usd) ?? num(a.fdv_usd);
  if (mc !== undefined) out.marketCap = mc;
  const liq = num(a.total_reserve_in_usd);
  if (liq !== undefined) out.liquidity = liq;

  const poolId: string | undefined = tokenJson?.data?.relationships?.top_pools?.data?.[0]?.id;
  const pool = poolId ? poolId.replace(new RegExp(`^${slug}_`), '') : undefined;
  if (pool) {
    out.pairAddress = pool;
    out.chartUrl = `https://www.geckoterminal.com/${slug}/pools/${pool}`;
    out.embedUrl = geckoEmbedUrl(slug, pool);
  }
  const p = poolJson?.data?.attributes;
  if (p) {
    const ch = num(p.price_change_percentage?.h24);
    if (ch !== undefined) out.change24h = ch;
    const pliq = num(p.reserve_in_usd);
    if (pliq !== undefined && out.liquidity === undefined) out.liquidity = pliq;
    const pprice = num(p.base_token_price_usd);
    if (pprice !== undefined && out.priceUsd === undefined) out.priceUsd = pprice;
  }
  const i = infoJson?.data?.attributes;
  if (i) {
    const web = i.websites?.[0];
    if (web) out.website = String(web);
    if (i.twitter_handle) out.twitter = `https://x.com/${String(i.twitter_handle).replace(/^@/, '')}`;
    if (i.telegram_handle) out.telegram = `https://t.me/${String(i.telegram_handle).replace(/^@/, '')}`;
    if (!out.imageUrl && i.image_url) out.imageUrl = String(i.image_url);
  }
  return out;
}

// --- spaced request queue ---
let chain: Promise<void> = Promise.resolve();
let lastAt = 0;
function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run.then(fn);
}

class RateLimited extends Error {}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<any | undefined> {
  return spaced(async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (res.status === 404) return undefined;
      if (res.status === 429) throw new RateLimited('geckoterminal 429');
      if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  });
}

export async function fetchGeckoTerminal(
  address: string,
  chainKind: Chain,
  fetchImpl: typeof fetch = fetch,
  networks: string[] = GT_NETWORKS[chainKind],
): Promise<Partial<TokenInfo> | undefined> {
  for (const slug of networks) {
    const token = await getJson(`${API}/networks/${slug}/tokens/${encodeURIComponent(address)}`, fetchImpl);
    if (!token?.data) continue;
    const poolId: string | undefined = token.data.relationships?.top_pools?.data?.[0]?.id;
    const pool = poolId ? poolId.replace(new RegExp(`^${slug}_`), '') : undefined;
    const [poolJson, infoJson] = await Promise.all([
      pool ? getJson(`${API}/networks/${slug}/pools/${pool}`, fetchImpl).catch(() => undefined) : undefined,
      getJson(`${API}/networks/${slug}/tokens/${encodeURIComponent(address)}/info`, fetchImpl).catch(() => undefined),
    ]);
    return mapGeckoTerminal(slug, token, poolJson, infoJson);
  }
  return undefined;
}
