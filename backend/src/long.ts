import { decodeStrings, type LaunchpadInfo } from './launchpads.js';
import type { TokenInfo } from './types.js';

/**
 * Long (app.long.xyz): a launchpad on Robinhood Chain where every token is "anchored" to a
 * tokenized stock (its numeraire) and sold through a continuous auction pool before it
 * graduates to a v2 pool. The app reads Long's own indexer, an unauthenticated Hasura GraphQL
 * endpoint (api.long.xyz/v1/graphql; the web app uses it from the browser). Unofficial: it can
 * change without notice. Long tokens all carry the vanity suffix `1e18`, which is the cheap
 * pre-check before asking the API whether an address is a Long asset.
 *
 * Cloudflare's bot check in front of the API lets browsers through and answers Node with a 403
 * challenge page. So the server tries once and, when blocked, leaves the fetching to the page
 * (frontend/src/long.ts), which hands the raw asset to /api/long/asset; the mapping below is
 * shared either way.
 */
export const LONG_API = 'https://api.long.xyz/v1/graphql';
export const LONG_CHAIN_ID = 4663;
export const LONG_SUFFIX = '1e18';
const TIMEOUT_MS = 8000;

/** Tokenized stocks on Robinhood Chain that Long tokens anchor to (numeraire address → ticker). */
export const NUMERAIRES: Record<string, string> = {
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': 'AAPL',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'TSLA',
  '0xe93237c50d904957cf27e7b1133b510c669c2e74': 'MSFT',
  '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3': 'GOOGL',
  '0x12f190a9f9d7d37a250758b26824b97ce941bf54': 'AMZN',
  '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a': 'PLTR',
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': 'SPCX',
  '0xccee82fe024c36fa15e1005ede3e9e4787e23d09': 'HIMS',
  '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b': 'AMC',
  '0xff080c8ce2e5feadaca0da81314ae59d232d4afd': 'MU',
  '0xec262a75e413fafd0df80480274532c79d42da09': 'MSTR',
  '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e': 'GLD',
  '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344': 'USO',
  '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681': 'INTC',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'SPY',
};

const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SYMBOL_SELECTOR = '0x95d89b41';
/** ERC-20 symbols of anchors outside the static table (other stock tokens), read once from the chain. */
const symbolCache = new Map<string, string>();
export function __resetSymbolCache(): void {
  symbolCache.clear();
}
export async function resolveNumeraires(addresses: string[], fetchImpl: typeof fetch = fetch, rpc = ROBINHOOD_RPC): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const todo: string[] = [];
  for (const raw of addresses) {
    const a = raw.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) || /^0x0{40}$/.test(a) || NUMERAIRES[a] || isLongAddress(a)) continue;
    const hit = symbolCache.get(a);
    if (hit !== undefined) {
      if (hit) out[a] = hit;
    } else todo.push(a);
  }
  if (todo.length === 0) return out;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(todo.map((a, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: a, data: SYMBOL_SELECTOR }, 'latest'] }))),
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
    const json = await res.json();
    for (const r of Array.isArray(json) ? json : []) {
      const a = todo[Number(r?.id)];
      if (!a) continue;
      const sym = typeof r?.result === 'string' && r.result.length > 2 ? decodeStrings(r.result, 1)?.[0]?.trim().slice(0, 12) : undefined;
      symbolCache.set(a, sym || '');
      if (sym) out[a] = sym;
    }
  } catch {
    /* next time */
  }
  return out;
}

export const isLongAddress = (address: string): boolean => /^0x[0-9a-f]{40}$/i.test(address) && address.toLowerCase().endsWith(LONG_SUFFIX);
export const longUrl = (address: string): string => `https://app.long.xyz/tokens/${address.toLowerCase()}`;

const ASSET_FIELDS = `
  asset_address asset_numeraire_address asset_creation_timestamp asset_current_pool integrator_address
  auction_pool { pool_address pool_current_fdv_usd pool_current_sale_progress_percentage pool_volume_24h_usd
    pool_market_data { marketCap price priceChange24 volumeUSD24 }
    base_token { token_symbol token_name token_description token_image_public_url } }
  graduation_pool { pool_address pool_market_data { marketCap price priceChange24 volumeUSD24 } }`;

async function gql<T>(query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(LONG_API, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query, variables }), signal: ctl.signal });
    if (!res.ok) throw new Error(`long ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(`long: ${json.errors[0]?.message ?? 'graphql error'}`);
    return json.data as T;
  } finally {
    clearTimeout(t);
  }
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The live pool: the auction while it runs, the graduation pool after. */
function market(a: any): { marketCap?: number; priceUsd?: number; change24h?: number; volume24h?: number } {
  const pool = a?.asset_current_pool === 'graduation' && a?.graduation_pool?.pool_market_data ? a.graduation_pool : a?.auction_pool;
  const m = pool?.pool_market_data;
  return {
    marketCap: num(m?.marketCap) ?? (num(pool?.pool_current_fdv_usd) !== undefined ? num(pool.pool_current_fdv_usd)! / 1e18 : undefined),
    priceUsd: num(m?.price),
    change24h: num(m?.priceChange24) !== undefined ? num(m.priceChange24)! * 100 : undefined,
    volume24h: num(m?.volumeUSD24) ?? (num(pool?.pool_volume_24h_usd) !== undefined ? num(pool.pool_volume_24h_usd)! / 1e18 : undefined),
  };
}

/** What the anchor reads as: a ticker for the known stock tokens, the Long token's own symbol when a launch anchors to another launch, else a short address. */
export function anchorLabel(numeraire: string | undefined, longSymbols: Record<string, string> = {}): string | undefined {
  if (!numeraire) return undefined;
  const n = numeraire.toLowerCase();
  if (/^0x0{40}$/.test(n)) return 'ETH';
  return NUMERAIRES[n] ?? longSymbols[n] ?? `${n.slice(0, 6)}…${n.slice(-4)}`;
}

/** A Long asset → what the call card needs. Pure. */
export function mapLongAsset(a: any, longSymbols: Record<string, string> = {}): LaunchpadInfo | undefined {
  const address = typeof a?.asset_address === 'string' ? a.asset_address.toLowerCase() : undefined;
  if (!address) return undefined;
  const base = a.auction_pool?.base_token ?? a.graduation_pool?.base_token ?? {};
  const anchor = anchorLabel(a.asset_numeraire_address, longSymbols);
  const out: LaunchpadInfo = { launchpad: 'long', launchpadUrl: longUrl(address), network: 'robinhood' };
  if (typeof base.token_symbol === 'string' && base.token_symbol) out.symbol = base.token_symbol.slice(0, 20);
  if (typeof base.token_name === 'string' && base.token_name) out.name = base.token_name.slice(0, 80);
  if (typeof base.token_image_public_url === 'string' && /^https?:\/\//.test(base.token_image_public_url)) out.imageUrl = base.token_image_public_url;
  const created = Date.parse(a.asset_creation_timestamp ?? '');
  if (Number.isFinite(created)) out.pairCreatedAt = created;
  if (anchor) out.launchpadNote = `anchored to ${anchor}`;
  const m = market(a);
  if (m.marketCap !== undefined) out.marketCap = m.marketCap;
  if (m.priceUsd !== undefined) out.priceUsd = m.priceUsd;
  if (m.volume24h !== undefined) out.volume24h = m.volume24h;
  return out;
}

/** Is this address a Long token? Only asked for the `1e18` suffix; one request. */
let serverBlocked = false;
export async function fetchLong(address: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  if (!isLongAddress(address) || serverBlocked) return undefined;
  let data: { Asset: any[] };
  try {
    data = await gql<{ Asset: any[] }>(`query LongAsset($address: String!, $chain: Int!) { Asset(where: { asset_address: { _eq: $address }, chain_id: { _eq: $chain } }, limit: 1) { ${ASSET_FIELDS} } }`, { address: address.toLowerCase(), chain: LONG_CHAIN_ID }, fetchImpl);
  } catch (e: any) {
    if (/\b403\b/.test(String(e?.message ?? e))) {
      serverBlocked = true; // the page identifies Long tokens from here on (frontend/src/long.ts)
      return undefined;
    }
    throw e;
  }
  const a = data?.Asset?.[0];
  if (!a) return undefined;
  const numeraire = String(a.asset_numeraire_address ?? '').toLowerCase();
  const longSymbols = isLongAddress(numeraire) && !NUMERAIRES[numeraire] ? await symbolsFor([numeraire], fetchImpl) : await resolveNumeraires([numeraire], fetchImpl);
  return mapLongAsset(a, longSymbols);
}

/** Symbols for Long tokens that other launches anchor to. */
async function symbolsFor(addresses: string[], fetchImpl: typeof fetch): Promise<Record<string, string>> {
  if (addresses.length === 0) return {};
  try {
    const data = await gql<{ Asset: any[] }>(`query LongSymbols($addresses: [String!]!) { Asset(where: { asset_address: { _in: $addresses } }) { asset_address auction_pool { base_token { token_symbol } } } }`, { addresses }, fetchImpl);
    return Object.fromEntries((data?.Asset ?? []).filter((x) => x?.asset_address && x.auction_pool?.base_token?.token_symbol).map((x) => [String(x.asset_address).toLowerCase(), String(x.auction_pool.base_token.token_symbol)]));
  } catch {
    return {};
  }
}

/** Fold a Long asset into a token the feed already has: the launchpad badge, and whatever the token still lacks. Pure. */
export function mergeLaunchpad(t: TokenInfo, info: LaunchpadInfo): boolean {
  let changed = false;
  const set = <K extends keyof TokenInfo>(k: K, v: TokenInfo[K] | undefined, overwrite = false) => {
    if (v === undefined) return;
    if (!overwrite && t[k] !== undefined) return;
    if (t[k] === v) return;
    t[k] = v;
    changed = true;
  };
  set('launchpad', info.launchpad, true);
  set('launchpadUrl', info.launchpadUrl, true);
  set('launchpadNote', info.launchpadNote, true);
  set('network', info.network);
  set('name', info.name);
  set('symbol', info.symbol);
  set('imageUrl', info.imageUrl);
  set('pairCreatedAt', info.pairCreatedAt);
  set('marketCap', info.marketCap);
  set('priceUsd', info.priceUsd);
  set('volume24h', info.volume24h);
  return changed;
}

