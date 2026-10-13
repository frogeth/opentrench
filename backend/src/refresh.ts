import type { TokenInfo } from './types.js';
import { BATCH_MAX, fetchDexscreenerBatch, fetchDexscreenerChain } from './dexscreener.js';
import { fetchGeckoTerminalMulti, gtSlugFor } from './geckoterminal.js';

/**
 * Live market refresh for recently called tokens. Grouped by network, every network in
 * parallel, so the per-chain Dexscreener endpoint answers for every token; whatever it doesn't
 * know (fresh pairs, small chains) is asked of GeckoTerminal, 30 at a time — unless the caller
 * opts out (the fast loop, which runs too often for GeckoTerminal's 30/min). Tokens with no
 * network yet go to Dexscreener's chain-less endpoint, which also tells us their network.
 */
export interface RefreshDeps {
  dex: (chainId: string, addresses: string[]) => Promise<Map<string, Partial<TokenInfo>>>;
  /** chain-less lookup, for tokens whose network is still unknown */
  dexAny?: (addresses: string[]) => Promise<Map<string, Partial<TokenInfo>>>;
  gt: (slug: string, addresses: string[]) => Promise<Map<string, Partial<TokenInfo>>>;
  apply: (address: string, info: Partial<TokenInfo>) => void;
  log?: (msg: string) => void;
}

export interface RefreshOptions {
  /** fall back to GeckoTerminal for what Dexscreener did not answer (default true) */
  gt?: boolean;
}

export async function refreshMarket(tokens: TokenInfo[], deps: RefreshDeps, opts: RefreshOptions = {}): Promise<{ updated: number; missing: string[] }> {
  const byNet = new Map<string, TokenInfo[]>();
  const unknownNet: string[] = [];
  for (const t of tokens) {
    if (!t.network) {
      unknownNet.push(t.address);
      continue;
    }
    const list = byNet.get(t.network) ?? [];
    list.push(t);
    byNet.set(t.network, list);
  }
  let updated = 0;
  const missing: string[] = [];
  const perNetwork = async (network: string, list: TokenInfo[]) => {
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
    if (unanswered.length === 0) return;
    if (opts.gt === false) {
      missing.push(...unanswered);
      return;
    }
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
  };
  const noNetwork = async () => {
    if (unknownNet.length === 0) return;
    if (!deps.dexAny) {
      missing.push(...unknownNet);
      return;
    }
    // the chain-less endpoint caps *pairs* at 30, so ask for fewer tokens at a time
    for (let i = 0; i < unknownNet.length; i += 10) {
      const chunk = unknownNet.slice(i, i + 10);
      let got = new Map<string, Partial<TokenInfo>>();
      try {
        got = await deps.dexAny(chunk);
      } catch (e: any) {
        deps.log?.(`dexscreener (no network) failed: ${e?.message ?? e}`);
      }
      for (const a of chunk) {
        const info = got.get(a);
        if (info) {
          deps.apply(a, info);
          updated++;
        } else missing.push(a);
      }
    }
  };
  await Promise.all([...[...byNet].map(([n, l]) => perNetwork(n, l)), noNetwork()]);
  return { updated, missing };
}

/** a pass that has not finished by now is given up on, so one request that never settles cannot stop the loop */
export const PASS_DEADLINE_MS = 120_000;

export function createMarketRefresher(
  apply: RefreshDeps['apply'],
  log?: RefreshDeps['log'],
  opts: RefreshOptions = {},
  deps: RefreshDeps = { dex: (c, a) => fetchDexscreenerChain(c, a), dexAny: (a) => fetchDexscreenerBatch(a), gt: (s, a) => fetchGeckoTerminalMulti(s, a), apply, log },
  deadlineMs = PASS_DEADLINE_MS,
): (tokens: TokenInfo[]) => Promise<void> {
  // A fetch whose promise never settled (seen after a network drop) once held this guard for days:
  // every token's numbers froze, and graduated tokens stayed on their dead curve. A pass now has a deadline.
  let running = false;
  return async (tokens) => {
    if (running) return;
    running = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), deadlineMs)));
    try {
      const r = await Promise.race([refreshMarket(tokens, deps, opts), deadline]);
      if (r === 'late') log?.(`a market pass ran past ${Math.round(deadlineMs / 1000)}s; starting fresh`);
      else if (r.missing.length && opts.gt !== false) log?.(`no market data for ${r.missing.length} token(s)`);
    } finally {
      clearTimeout(timer);
      running = false;
    }
  };
}
