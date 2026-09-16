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
  // arc: Circle's chain; Dexscreener does not list it (2026-09-15), GeckoTerminal does, as `arc`
  evm: ['robinhood', 'base', 'eth', 'bsc', 'arbitrum', 'arc'],
  sol: ['solana'],
};

/** GT slug -> dexscreener-style chain id used everywhere else in the app. */
const GT_TO_NETWORK: Record<string, string> = { eth: 'ethereum' };
export function networkFromGt(slug: string): string {
  return GT_TO_NETWORK[slug] ?? slug;
}
/** dexscreener-style chain id -> GT slug */
export function gtSlugFor(network: string): string {
  for (const [slug, net] of Object.entries(GT_TO_NETWORK)) if (net === network) return slug;
  return network;
}

export interface Candle {
  /** unix seconds, bucket open */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** GT OHLCV granularity for a UI interval like "5m", "1h", "1d". */
export function ohlcvPath(interval: string): { timeframe: 'minute' | 'hour' | 'day'; aggregate: number } {
  const m = /^(\d+)([mhd])$/.exec(interval) ?? ['', '5', 'm'];
  const n = Number(m[1]);
  if (m[2] === 'd') return { timeframe: 'day', aggregate: 1 };
  if (m[2] === 'h') return { timeframe: 'hour', aggregate: [1, 4, 12].includes(n) ? n : 1 };
  return { timeframe: 'minute', aggregate: [1, 5, 15].includes(n) ? n : 5 };
}

export function mapOhlcv(json: any): Candle[] {
  const rows: any[] = Array.isArray(json?.data?.attributes?.ohlcv_list) ? json.data.attributes.ohlcv_list : [];
  return rows
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
}

/**
 * Candles for a pool (oldest first). GT returns newest-first pages of up to 1000.
 * `token` names whose price the candles are: without it GT gives the pool's *base* token, which
 * is the other asset when the token we care about sits on the quote side (a SOL close scaled by
 * a meme coin's supply once produced entry market caps in the trillions).
 */
export async function fetchOhlcv(slug: string, pool: string, interval: string, limit = 300, fetchImpl: typeof fetch = fetch, beforeTs?: number, token?: string): Promise<Candle[]> {
  const { timeframe, aggregate } = ohlcvPath(interval);
  const before = beforeTs ? `&before_timestamp=${Math.floor(beforeTs)}` : '';
  const side = token ? `&token=${encodeURIComponent(token)}` : '';
  const json = await getJson(`${API}/networks/${slug}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${Math.min(1000, limit)}&currency=usd${before}${side}`, fetchImpl, 'extra');
  return mapOhlcv(json);
}

/** Market numbers for up to 30 tokens of one network in one (spaced) request; keys are the addresses as passed. */
export async function fetchGeckoTerminalMulti(
  slug: string,
  addresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Partial<TokenInfo>>> {
  const out = new Map<string, Partial<TokenInfo>>();
  if (addresses.length === 0) return out;
  const json = await getJson(`${API}/networks/${slug}/tokens/multi/${addresses.slice(0, 30).map(encodeURIComponent).join(',')}`, fetchImpl);
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  for (const a of addresses) {
    const row = rows.find((r) => String(r?.attributes?.address ?? '').toLowerCase() === a.toLowerCase());
    const at = row?.attributes;
    if (!at) continue;
    const info: Partial<TokenInfo> = {};
    const price = num(at.price_usd);
    if (price !== undefined) info.priceUsd = price;
    const mc = num(at.market_cap_usd) ?? num(at.fdv_usd);
    if (mc !== undefined) info.marketCap = mc;
    const vol = num(at.volume_usd?.h24);
    if (vol !== undefined) info.volume24h = vol;
    const liq = num(at.total_reserve_in_usd);
    if (liq !== undefined) info.liquidity = liq;
    if (Object.keys(info).length) out.set(a, info);
  }
  return out;
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
    const wait = Math.max(lastAt + MIN_SPACING_MS, lastRateLimitAt + HOLD_MS) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run.then(fn);
}

class RateLimited extends Error {}

/**
 * The 30/min allowance is per public IP, so two machines behind one router share it. When GT has
 * just said 429, the budget is kept for market data (the refresh fallback for pairs Dexscreener
 * has not indexed, and the enrichment probe): charts and the call-price backfill ("extra") are
 * refused locally for a minute instead of spending the next request slots on candles.
 */
export type GtPriority = 'market' | 'extra';
const BACKOFF_MS = 60_000;
/** after a 429 every request (market data too) waits this long: firing on just collects more 429s and keeps the window shut */
const HOLD_MS = 30_000;
let lastRateLimitAt = 0;
export function __resetRateLimit(): void {
  lastRateLimitAt = 0;
}
/** tests: pretend the last 429 happened at `ts` */
export function __setRateLimitedAt(ts: number): void {
  lastRateLimitAt = ts;
}
/** true while extras are standing aside */
export function gtThrottled(now = Date.now()): boolean {
  return now - lastRateLimitAt < BACKOFF_MS;
}

async function getJson(url: string, fetchImpl: typeof fetch, priority: GtPriority = 'market'): Promise<any | undefined> {
  if (priority === 'extra' && gtThrottled()) throw new RateLimited('geckoterminal budget reserved for market data after a 429');
  return spaced(async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (res.status === 404) return undefined;
      if (res.status === 429) {
        lastRateLimitAt = Date.now();
        throw new RateLimited('geckoterminal 429');
      }
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
