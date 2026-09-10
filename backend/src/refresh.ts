import type { TokenInfo } from './types.js';
import { BATCH_MAX, fetchDexscreenerChain } from './dexscreener.js';
import { fetchGeckoTerminalMulti, gtSlugFor } from './geckoterminal.js';

/**
 * Live market refresh for recently called tokens. Grouped by network so the
 * per-chain Dexscreener endpoint answers for every token; whatever it doesn't
 * know (fresh pairs, small chains) is asked of GeckoTerminal, 30 at a time.
 */
export interface RefreshDeps {
  dex: (chainId: string, addresses: string[]) => Promise<Map<string, Partial<TokenInfo>>>;
  gt: (slug: string, addresses: string[]) => Promise<Map<string, Partial<TokenInfo>>>;
  apply: (address: string, info: Partial<TokenInfo>) => void;
  log?: (msg: string) => void;
}

export async function refreshMarket(tokens: TokenInfo[], deps: RefreshDeps): Promise<{ updated: number; missing: string[] }> {
  const byNet = new Map<string, TokenInfo[]>();
  for (const t of tokens) {
    if (!t.network) continue;
    const list = byNet.get(t.network) ?? [];
    list.push(t);
    byNet.set(t.network, list);
  }
  let updated = 0;
  const missing: string[] = [];
  for (const [network, list] of byNet) {
    const unanswered: string[] = [];
    for (let i = 0; i < list.length; i += BATCH_MAX) {
      const chunk = list.slice(i, i + BATCH_MAX).map((t) => t.address);
      let got = new Map<string, Partial<TokenInfo>>();
      try {
        got = await deps.dex(network, chunk);
      } catch (e: any) {
        deps.log?.(`dexscreener ${network} failed: ${e?.message ?? e}`);
      }
      for (const a of chunk) {
        const info = got.get(a);
        if (info) {
          deps.apply(a, info);
          updated++;
        } else unanswered.push(a);
      }
    }
    if (unanswered.length === 0) continue;
    // GeckoTerminal is rate-limited (30/min): one request per network per cycle, newest first.
    const ask = unanswered.slice(0, 30);
    try {
      const got = await deps.gt(gtSlugFor(network), ask);
      for (const a of ask) {
        const info = got.get(a);
        if (info) {
          deps.apply(a, info);
          updated++;
        } else missing.push(a);
      }
    } catch (e: any) {
      deps.log?.(`geckoterminal ${network} failed: ${e?.message ?? e}`);
      missing.push(...ask);
    }
    missing.push(...unanswered.slice(30));
  }
  return { updated, missing };
}

export function createMarketRefresher(apply: RefreshDeps['apply'], log?: RefreshDeps['log']): (tokens: TokenInfo[]) => Promise<void> {
  const deps: RefreshDeps = { dex: (c, a) => fetchDexscreenerChain(c, a), gt: (s, a) => fetchGeckoTerminalMulti(s, a), apply, log };
  let running = false;
  return async (tokens) => {
    if (running) return;
    running = true;
    try {
      const r = await refreshMarket(tokens, deps);
      if (r.missing.length) log?.(`no market data for ${r.missing.length} token(s)`);
    } finally {
      running = false;
    }
  };
}
