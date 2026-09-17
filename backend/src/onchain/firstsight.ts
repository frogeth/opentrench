import type { Chain, TokenInfo } from '../types.js';
import { discoverEvm, discoverSolana } from './discover.js';
import type { Endpoints } from './endpoints.js';
import { identifyEvm, identifySolana, type Identity } from './identity.js';
import type { FetchLike } from './rpc.js';

/**
 * A contract's first description, from the chain: identity (name, ticker, chain) and its pool,
 * before any site has indexed it. Runs beside Dexscreener in the enricher; whatever the chain
 * says fills the gaps the APIs leave, so a launch shows its ticker in one round trip and the live
 * pricer can start on it the moment its pool exists.
 */
export interface FirstSightDeps {
  endpoints: Endpoints;
  fetch?: FetchLike;
  /** an existing pool on a chain, so a chain not in the factory table can learn its factory */
  knownPool?: (network: string) => string | undefined;
  /** chains to try first for a bare EVM address (where the feed's tokens usually are) */
  prefer?: () => string[];
  log?: (msg: string) => void;
  now?: () => number;
}

const CACHE_MS = 60_000;

export function createChainSource(deps: FirstSightDeps): (address: string, chain: Chain) => Promise<Partial<TokenInfo> | undefined> {
  const cache = new Map<string, { at: number; p: Promise<Partial<TokenInfo> | undefined> }>();
  const now = deps.now ?? Date.now;
  const look = async (address: string, chain: Chain): Promise<Partial<TokenInfo> | undefined> => {
    if (chain === 'sol') {
      const [id, pool] = await Promise.all([identifySolana(address, { endpoints: deps.endpoints, fetch: deps.fetch }), discoverSolana(address, deps)]);
      if (!id && !pool) return undefined;
      const out: Partial<TokenInfo> = { network: 'solana' };
      if (id?.name) out.name = id.name;
      if (id?.symbol) out.symbol = id.symbol;
      if (pool) Object.assign(out, { pairAddress: pool.pairAddress, quoteSymbol: pool.quoteSymbol, quoteAddress: pool.quoteAddress, dex: pool.dex });
      return out;
    }
    const hits = await identifyEvm(address, { endpoints: deps.endpoints, fetch: deps.fetch, prefer: deps.prefer?.() });
    if (!hits.length) return undefined;
    // the chain where it trades wins over the chain where it merely exists (bridged copies, CREATE2 twins)
    const pools = await Promise.all(hits.map((h) => discoverEvm(h.network, address, deps).catch(() => [])));
    let pick: { id: Identity; pool?: ReturnType<typeof discoverEvm> extends Promise<(infer D)[]> ? D : never } = { id: hits[0] };
    for (const [i, list] of pools.entries()) {
      if (list[0]) {
        pick = { id: hits[i], pool: list[0] };
        break;
      }
    }
    const out: Partial<TokenInfo> = { network: pick.id.network };
    if (pick.id.name) out.name = pick.id.name;
    if (pick.id.symbol) out.symbol = pick.id.symbol;
    if (pick.pool) Object.assign(out, { pairAddress: pick.pool.pairAddress, quoteSymbol: pick.pool.quoteSymbol, quoteAddress: pick.pool.quoteAddress, dex: pick.pool.dex });
    return out;
  };
  return (address, chain) => {
    const key = `${chain}:${address}`;
    const c = cache.get(key);
    if (c && now() - c.at < CACHE_MS) return c.p;
    const p = look(address, chain).catch((e) => {
      deps.log?.(`chain lookup failed for ${address}: ${(e as Error).message}`);
      return undefined;
    });
    cache.set(key, { at: now(), p });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return p;
  };
}
