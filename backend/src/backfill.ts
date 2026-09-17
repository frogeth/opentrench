import type { Candle } from './geckoterminal.js';
import type { CallRecord, TokenInfo } from './types.js';

/**
 * Exact market caps at call time. When a call lands, its record takes whatever market cap the
 * app had cached at that moment (for a brand-new token: the first enrichment after it), which
 * in a fast move is seconds to a minute off. Once the 1-minute candle for the call's minute has
 * closed, this reads the real number from the pool's candles: close of that minute × the
 * token's supply (implied by the latest market cap ÷ price). The first call's value is the entry
 * the multipliers are measured from, so it is corrected too.
 *
 * GeckoTerminal is the candle source (30 requests/min, shared with the refresh loop and charts),
 * so each cycle takes a few tokens, newest calls first, one request per token covering every
 * pending call it has.
 */
export interface BackfillDeps {
  tokens: () => TokenInfo[];
  /** 1-minute candles of `token` in the pool (GT defaults to the pool's base token, which may be the other side); `beforeTs` is unix seconds */
  candles: (token: string, network: string, pool: string, beforeTs: number, limit: number) => Promise<Candle[]>;
  apply: (address: string, updates: CallMarketCap[]) => void;
  /** the token's dollar price at that moment, read from its pool at the block (EVM chains with archive state) */
  priceAt?: (t: TokenInfo, tsMs: number) => Promise<number | undefined>;
  log?: (msg: string) => void;
  now?: () => number;
}
export interface CallMarketCap {
  msgId: string;
  /** set when read from a candle or the pool at the block; absent when neither answered (the cached value stays) */
  marketCap?: number;
  source: 'candle' | 'cached' | 'chain';
}

/** a call younger than this may sit in a candle that is still open */
export const SETTLE_MS = 90_000;
/** older calls are not worth a request */
export const MAX_AGE_MS = 24 * 3600e3;
/** tokens per cycle (one candle request each) */
export const PER_CYCLE = 4;

/** Calls still carrying the cached number whose minute candle has closed. */
export function pendingCalls(t: TokenInfo, now: number): CallRecord[] {
  if (!t.network || !t.pairAddress || !t.marketCap || !t.priceUsd) return [];
  return t.calls.filter((c) => !c.mcSource && now - c.ts >= SETTLE_MS && now - c.ts <= MAX_AGE_MS);
}

/** Each call's market cap from the candle containing its minute; calls with no candle are marked as kept. */
export function marketCapsAt(calls: CallRecord[], candles: Candle[], mcPerPrice: number): CallMarketCap[] {
  return calls.map((c) => {
    const sec = Math.floor(c.ts / 1000);
    const k = candles.find((k) => k.t <= sec && sec < k.t + 60);
    return k && k.c > 0 && Number.isFinite(k.c * mcPerPrice) ? { msgId: c.msgId, marketCap: k.c * mcPerPrice, source: 'candle' } : { msgId: c.msgId, source: 'cached' };
  });
}

/** One pass: the most recently called tokens with pending calls, one candle request each. Returns how many calls were corrected. */
export async function backfillOnce(deps: BackfillDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const due = deps
    .tokens()
    .map((t) => ({ t, calls: pendingCalls(t, now) }))
    .filter((x) => x.calls.length > 0)
    .sort((a, b) => b.t.lastCallTs - a.t.lastCallTs)
    .slice(0, PER_CYCLE);
  let fixed = 0;
  for (const { t, calls } of due) {
    // the pool at the call's block: exact, and no candle service in the way
    if (deps.priceAt) {
      const mcPerPrice = t.marketCap! / t.priceUsd!;
      const updates: CallMarketCap[] = [];
      for (const c of calls) {
        try {
          const usd = await deps.priceAt(t, c.ts);
          updates.push(usd && Number.isFinite(usd * mcPerPrice) ? { msgId: c.msgId, marketCap: usd * mcPerPrice, source: 'chain' } : { msgId: c.msgId, source: 'cached' });
        } catch (e: any) {
          deps.log?.(`${t.symbol ?? t.address} pool at block failed: ${e?.message ?? e}`);
          updates.push({ msgId: c.msgId, source: 'cached' });
        }
      }
      if (updates.some((u) => u.source === 'chain')) {
        deps.apply(t.address, updates);
        fixed += updates.filter((u) => u.source === 'chain').length;
        continue;
      }
    }
    const newest = Math.max(...calls.map((c) => c.ts));
    const oldest = Math.min(...calls.map((c) => c.ts));
    const limit = Math.min(1000, Math.ceil((newest - oldest) / 60_000) + 3);
    try {
      const candles = await deps.candles(t.address, t.network!, t.pairAddress!, Math.floor(newest / 1000) + 60, limit);
      const updates = marketCapsAt(calls, candles, t.marketCap! / t.priceUsd!);
      deps.apply(t.address, updates);
      fixed += updates.filter((u) => u.source === 'candle').length;
    } catch (e: any) {
      deps.log?.(`${t.symbol ?? t.address} candles failed: ${e?.message ?? e}`);
    }
  }
  return fixed;
}

/** A candle-derived value is nonsense when it is this far from the token's current market cap. */
export const ABSURD_RATIO = 50;

/**
 * Undo the backfill's first release, which read the pool's base-token candles for every token and
 * so wrote the *other* asset's price into calls on quote-side tokens (entry market caps in the
 * trillions, every multiplier 0.0x). Every candle-derived value goes back to pending so it is
 * re-read with the right token; a value that is wildly off the current market cap is dropped
 * outright (the first call's entry with it), since an old call may never get a candle again.
 * Pure; returns how many calls were touched.
 */
export function repairCandleMarketCaps(tokens: TokenInfo[]): { reset: number; dropped: number } {
  let reset = 0;
  let dropped = 0;
  for (const t of tokens) {
    for (const c of t.calls) {
      if (c.mcSource !== 'candle') continue;
      c.mcSource = undefined;
      reset++;
      const absurd = !!t.marketCap && c.marketCap !== undefined && (c.marketCap > t.marketCap * ABSURD_RATIO || c.marketCap < t.marketCap / ABSURD_RATIO);
      if (absurd) {
        c.marketCap = undefined;
        if (c === t.calls[0]) t.firstCallMarketCap = undefined;
        dropped++;
      }
    }
  }
  return { reset, dropped };
}

/** The loop: one pass at a time, on a timer the caller owns. */
export function createBackfiller(deps: BackfillDeps): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const n = await backfillOnce(deps);
      if (n) deps.log?.(`corrected ${n} call market cap(s) from candles`);
    } finally {
      running = false;
    }
  };
}
