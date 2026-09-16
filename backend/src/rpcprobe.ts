import { decodeStrings } from './launchpads.js';
import type { TokenInfo } from './types.js';

/**
 * Chains the chart sites do not index yet. An EVM address nobody could place is asked of each
 * chain's own RPC: code at that address makes it that chain's token, and `symbol()` / `name()`
 * give it a name. Free, instant and never rate-limited the way GeckoTerminal is, so a chart can
 * open (BasedBot needs only chain and address) before any price feed knows the token.
 */
export interface ProbeChain {
  network: string;
  rpc: string;
}
export const PROBE_CHAINS: ProbeChain[] = [{ network: 'arc', rpc: 'https://rpc.blockdaemon.mainnet.arc.io' }];

const SYMBOL = '0x95d89b41';
const NAME = '0x06fdde03';
const TIMEOUT_MS = 4000;
/** address → result, so a token that is nowhere is not asked again every refresh */
const cache = new Map<string, { at: number; hit: Partial<TokenInfo> | undefined }>();
const CACHE_MS = 10 * 60_000;

export async function probeChains(address: string, fetchImpl: typeof fetch = fetch, chains: ProbeChain[] = PROBE_CHAINS, now = Date.now()): Promise<Partial<TokenInfo> | undefined> {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return undefined;
  const c = cache.get(a);
  if (c && now - c.at < CACHE_MS) return c.hit;
  let hit: Partial<TokenInfo> | undefined;
  for (const chain of chains) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(chain.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 0, method: 'eth_getCode', params: [a, 'latest'] },
          { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: a, data: SYMBOL }, 'latest'] },
          { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: a, data: NAME }, 'latest'] },
        ]),
        signal: ctl.signal,
      });
      const json: any[] = await res.json();
      if (!Array.isArray(json)) continue;
      const by = (id: number) => json.find((r) => Number(r?.id) === id)?.result;
      const code = by(0);
      if (typeof code !== 'string' || code.length <= 2) continue;
      const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 2 ? decodeStrings(v, 1)?.[0]?.trim().slice(0, max) : undefined) || undefined;
      hit = { network: chain.network, symbol: str(by(1), 12), name: str(by(2), 40) };
      break;
    } catch {
      /* that chain's RPC is down or slow: not this chain, this time */
    } finally {
      clearTimeout(t);
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(a, { at: now, hit });
  return hit;
}
