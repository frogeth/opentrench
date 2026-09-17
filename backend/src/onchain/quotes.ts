import { CHAINS, STABLES, coingeckoIdFor } from './chains.js';

/**
 * USD price of the quote side of a pool: a dollar for stables, CoinGecko's simple price for native
 * coins (one request for every chain's coin, cached a minute; the free tier allows ~30/min and the
 * header tickers already spend one of those).
 */
export interface QuoteSource {
  usd(symbol: string): number | undefined;
  refresh(): Promise<void>;
}

const TTL_MS = 60_000;

export function createQuoteSource(fetchImpl: typeof fetch = fetch, log: (m: string) => void = () => {}): QuoteSource {
  const ids = [...new Set(Object.values(CHAINS).map((c) => c.coingecko).filter((x): x is string => !!x))];
  let prices = new Map<string, number>();
  let at = 0;
  let inflight: Promise<void> | undefined;
  const refresh = async () => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) throw new Error(`coingecko ${res.status}`);
        const j: any = await res.json();
        const next = new Map(prices);
        for (const id of ids) {
          const v = Number(j?.[id]?.usd);
          if (Number.isFinite(v) && v > 0) next.set(id, v);
        }
        prices = next;
        at = Date.now();
      } catch (e) {
        log(`quotes: ${(e as Error).message}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
  return {
    usd(symbol) {
      const s = symbol.toUpperCase();
      if (STABLES.has(s)) return 1;
      const id = coingeckoIdFor(s);
      if (!id) return undefined;
      if (Date.now() - at > TTL_MS) void refresh();
      return prices.get(id);
    },
    refresh,
  };
}
