import { CHAINS, alchemyUrl } from './chains.js';
import { evmChainId, solanaAlive, type FetchLike } from './rpc.js';

/**
 * Which RPC answers for a chain: the user's own URL first, then Alchemy when a key is set and the
 * probe showed Alchemy serves that chain, then the public endpoint from the chain table.
 */
export type EndpointSource = 'custom' | 'alchemy' | 'public';

export interface MarketDataConfig {
  alchemyKey?: string;
  rpc: Record<string, string>;
}

export interface AlchemyStatus {
  hasKey: boolean;
  /** networks the key answered for (empty until probed) */
  chains: string[];
  probedAt?: number;
  probing: boolean;
  error?: string;
}

export interface Endpoints {
  urlFor(network: string): { url: string; source: EndpointSource } | undefined;
  /** ask every Alchemy-served chain whether this key answers; remembers the result */
  probeAlchemy(key: string | undefined): Promise<AlchemyStatus>;
  alchemy(): AlchemyStatus;
  /** which source each known chain would use right now */
  sources(): Record<string, EndpointSource>;
}

export function createEndpoints(get: () => MarketDataConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike, log: (m: string) => void = () => {}): Endpoints {
  let status: AlchemyStatus = { hasKey: !!get().alchemyKey, chains: [], probing: false };
  let served = new Set<string>();
  const urlFor: Endpoints['urlFor'] = (network) => {
    const chain = CHAINS[network];
    if (!chain) return undefined;
    const c = get();
    const custom = c.rpc[network];
    if (custom) return { url: custom, source: 'custom' };
    if (c.alchemyKey && served.has(network)) {
      const url = alchemyUrl(chain, c.alchemyKey);
      if (url) return { url, source: 'alchemy' };
    }
    return { url: chain.rpc, source: 'public' };
  };
  return {
    urlFor,
    alchemy: () => status,
    sources: () => Object.fromEntries(Object.keys(CHAINS).map((n) => [n, urlFor(n)!.source])),
    async probeAlchemy(key) {
      if (!key) {
        served = new Set();
        status = { hasKey: false, chains: [], probing: false };
        return status;
      }
      status = { ...status, hasKey: true, probing: true, error: undefined };
      const candidates = Object.values(CHAINS).filter((c) => c.alchemy);
      const results = await Promise.all(
        candidates.map(async (c) => {
          const url = alchemyUrl(c, key)!;
          if (c.kind === 'solana') return (await solanaAlive(url, fetchImpl)) ? c.network : undefined;
          const id = await evmChainId(url, fetchImpl);
          if (id === undefined) return undefined;
          if (c.chainId !== undefined && id !== c.chainId) {
            log(`alchemy: ${c.network} answered chain id ${id}, expected ${c.chainId}; not using it`);
            return undefined;
          }
          return c.network;
        }),
      );
      const ok = results.filter((n): n is string => !!n);
      served = new Set(ok);
      status = { hasKey: true, chains: ok, probedAt: Date.now(), probing: false, error: ok.length === 0 ? 'the key answered for no chain (wrong key, or Alchemy is down)' : undefined };
      return status;
    },
  };
}
