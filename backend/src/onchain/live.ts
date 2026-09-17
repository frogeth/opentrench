import { encodeAbiParameters, keccak256 } from 'viem';
import type { TokenInfo } from '../types.js';
import { CHAINS } from './chains.js';
import type { Endpoints } from './endpoints.js';
import { SEL, V4_POOLS_SLOT, addressWord, decodePumpCurve, decodeString, isV4PoolId, orientBySanity, priceFromReserves, priceFromSqrt, pumpPriceSol, words, type PoolKind } from './pools.js';
import type { QuoteSource } from './quotes.js';
import { evmCalls, evmCallsDetailed, isRevert, solanaAccounts, type EvmResult, type FetchLike } from './rpc.js';

/**
 * Live prices straight from the pool: Uniswap v2 reserves, v3 slot0, v4 PoolManager storage, and
 * the pump.fun bonding curve. One batched RPC per chain per tick. The price arrives in the quote
 * asset and becomes dollars through QuoteSource; the market cap follows the same supply the API
 * sources reported (their market cap over their price), so the number moves live but does not jump
 * when the source switches. Everything else on the card (liquidity, volume, 24h change) keeps
 * coming from Dexscreener / GeckoTerminal.
 */
export interface LiveDeps {
  endpoints: Endpoints;
  quotes: QuoteSource;
  apply: (address: string, info: Partial<TokenInfo>) => void;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface NetworkStatus {
  /** tokens priced on-chain in the last tick */
  live: number;
  /** tokens this tick could not price (pool type not supported, quote not priced, no pool yet) */
  skipped: number;
  /** why, counted by reason */
  reasons: Record<string, number>;
  lastOkAt?: number;
  lastError?: string;
}

interface PoolMeta {
  pair: string;
  kind: PoolKind | 'unsupported';
  reason?: string;
  tokenIs0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  /** total supply in whole tokens, from the chain */
  chainSupply?: number;
  supplyAt: number;
  /** market cap ÷ price as the API sources last reported them, so live caps match theirs */
  apiSupply?: number;
  /** the quote asset as read from the pool itself, for tokens no API has described yet */
  quoteSymbol?: string;
  quoteAddress?: string;
  lastPrice?: number;
  /** when the pool last answered with a price */
  liveAt?: number;
  /** when an unsupported pool may be looked at again */
  retryAt: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const SUPPLY_TTL_MS = 10 * 60_000;
const RETRY_MS = 10 * 60_000;
const NO_QUOTE_RETRY_MS = 60_000;
/** a pool that has not answered for this long hands the price back to the API sources */
const LIVE_STALE_MS = 60_000;

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const v4Slot = (poolId: string) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId as `0x${string}`, V4_POOLS_SLOT]));
const isPumpfun = (t: TokenInfo) => t.network === 'solana' && /^pump\.?fun$/i.test(t.dex ?? '');

export function createLivePricer(deps: LiveDeps) {
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const meta = new Map<string, PoolMeta>();
  const status = new Map<string, NetworkStatus>();
  let inflight = false;

  const metaFor = (t: TokenInfo): PoolMeta | undefined => {
    const m = meta.get(t.address);
    return m && m.pair === t.pairAddress ? m : undefined;
  };
  const skip = (st: NetworkStatus, reason: string) => {
    st.skipped++;
    st.reasons[reason] = (st.reasons[reason] ?? 0) + 1;
  };
  const unsupported = (st: NetworkStatus, t: TokenInfo, reason: string, retryMs = RETRY_MS): PoolMeta => {
    const m: PoolMeta = { pair: t.pairAddress ?? '', kind: 'unsupported', reason, tokenIs0: false, tokenDecimals: 0, quoteDecimals: 0, supplyAt: 0, retryAt: now() + retryMs };
    meta.set(t.address, m);
    skip(st, reason);
    return m;
  };
  /** the supply the API sources implied; captured whenever their numbers were the latest */
  const noteApiSupply = (t: TokenInfo, m: PoolMeta) => {
    if (t.priceSource !== 'chain' && t.marketCap && t.priceUsd && t.marketCap > 0 && t.priceUsd > 0) m.apiSupply = t.marketCap / t.priceUsd;
  };
  const publish = (t: TokenInfo, m: PoolMeta, priceQuote: number, quoteUsd: number, supply: number | undefined): boolean => {
    const priceUsd = priceQuote * quoteUsd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
    m.lastPrice = priceUsd;
    m.liveAt = now();
    // nothing moved and the card already shows this number: no event
    if (t.priceUsd === priceUsd && t.priceSource === 'chain') return true;
    const info: Partial<TokenInfo> = { priceUsd, priceSource: 'chain', priceAt: now() };
    if (!t.quoteSymbol && m.quoteSymbol) info.quoteSymbol = m.quoteSymbol;
    if (!t.quoteAddress && m.quoteAddress) info.quoteAddress = m.quoteAddress;
    const s = m.apiSupply ?? supply;
    if (s && s > 0) info.marketCap = priceUsd * s;
    deps.apply(t.address, info);
    return true;
  };

  async function evmNetwork(network: string, tokens: TokenInfo[], st: NetworkStatus): Promise<void> {
    const chain = CHAINS[network];
    const ep = deps.endpoints.urlFor(network);
    if (!chain || !ep) return;
    const toResolve: TokenInfo[] = [];
    const ready: { t: TokenInfo; m: PoolMeta }[] = [];
    for (const t of tokens) {
      const m = metaFor(t);
      if (!m) toResolve.push(t);
      else if (m.kind === 'unsupported') {
        if (now() >= m.retryAt) toResolve.push(t);
        else skip(st, m.reason ?? 'unsupported');
      } else ready.push({ t, m });
    }
    if (toResolve.length) await resolveEvm(chain.v4, ep.url, toResolve, ready, st);
    if (!ready.length) return;

    const calls = ready.map(({ t, m }) => {
      if (m.kind === 'v4') return { to: chain.v4!, data: SEL.extsload + pad32(v4Slot(t.pairAddress!)) };
      return { to: t.pairAddress!, data: m.kind === 'v3' ? SEL.slot0 : SEL.getReserves };
    });
    const supplyIdx: number[] = [];
    for (const [i, { t, m }] of ready.entries()) {
      if (now() - m.supplyAt > SUPPLY_TTL_MS) {
        supplyIdx.push(i);
        calls.push({ to: t.address, data: SEL.totalSupply });
      }
    }
    const res = await evmCalls(ep.url, calls, fetchImpl);
    supplyIdx.forEach((i, k) => {
      const [w] = res[ready.length + k] ? words(res[ready.length + k]!) : [];
      if (w !== undefined) {
        ready[i].m.chainSupply = Number(w) / 10 ** ready[i].m.tokenDecimals;
        ready[i].m.supplyAt = now();
      }
    });
    ready.forEach(({ t, m }, i) => {
      const r = res[i];
      const quoteSymbol = t.quoteSymbol ?? m.quoteSymbol;
      const quoteUsd = quoteSymbol ? deps.quotes.usd(quoteSymbol) : undefined;
      if (!r || quoteUsd === undefined) {
        skip(st, !r ? 'pool did not answer' : `paired with ${quoteSymbol}, which is not priced`);
        return;
      }
      noteApiSupply(t, m);
      let price = 0;
      if (m.kind === 'v2') {
        const [r0, r1] = words(r);
        if (r0 !== undefined && r1 !== undefined) price = m.tokenIs0 ? priceFromReserves(r0, r1, m.tokenDecimals, m.quoteDecimals) : priceFromReserves(r1, r0, m.tokenDecimals, m.quoteDecimals);
      } else {
        const [w] = words(r);
        const sqrt = w === undefined ? 0n : m.kind === 'v4' ? w & ((1n << 160n) - 1n) : w;
        price = priceFromSqrt(sqrt, m.tokenDecimals, m.quoteDecimals, m.tokenIs0);
      }
      if (publish(t, m, price, quoteUsd, m.chainSupply)) st.live++;
      else skip(st, 'pool returned no price');
    });
  }

  /** First sight of a pool: learn its type, orientation and decimals in two batches. */
  async function resolveEvm(v4: string | undefined, url: string, tokens: TokenInfo[], ready: { t: TokenInfo; m: PoolMeta }[], st: NetworkStatus): Promise<void> {
    const plan: { t: TokenInfo; base: number; v4: boolean }[] = [];
    const calls: { to: string; data: string }[] = [];
    for (const t of tokens) {
      const pair = t.pairAddress ?? '';
      // a v2/v3 pair tells us its quote itself (token0/token1 + symbol()); a v4 id cannot
      if (t.quoteSymbol && deps.quotes.usd(t.quoteSymbol) === undefined) {
        unsupported(st, t, `paired with ${t.quoteSymbol}, which is not priced`, NO_QUOTE_RETRY_MS);
        continue;
      }
      if (isV4PoolId(pair)) {
        if (!t.quoteSymbol) {
          unsupported(st, t, 'no quote asset yet', NO_QUOTE_RETRY_MS);
          continue;
        }
        if (!v4) {
          unsupported(st, t, 'Uniswap v4 pool on a chain with no known PoolManager');
          continue;
        }
        if (!t.quoteAddress) {
          unsupported(st, t, 'v4 pool without the quote token address', NO_QUOTE_RETRY_MS);
          continue;
        }
        plan.push({ t, base: calls.length, v4: true });
        calls.push({ to: v4, data: SEL.extsload + pad32(v4Slot(pair)) }, { to: t.address, data: SEL.decimals });
        if (t.quoteAddress.toLowerCase() !== ZERO) calls.push({ to: t.quoteAddress, data: SEL.decimals });
        continue;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
        unsupported(st, t, 'no pool address yet', NO_QUOTE_RETRY_MS);
        continue;
      }
      plan.push({ t, base: calls.length, v4: false });
      calls.push({ to: pair, data: SEL.token0 }, { to: pair, data: SEL.token1 }, { to: pair, data: SEL.slot0 }, { to: pair, data: SEL.getReserves }, { to: t.address, data: SEL.decimals });
    }
    if (!plan.length) return;
    const detailed = await evmCallsDetailed(url, calls, fetchImpl);
    const res = detailed.map((r) => r.result);
    // a node that is busy (per-call rate limit, timeout) is not a pool that cannot be read: look again soon
    const transient = (items: EvmResult[]): string | undefined => items.map((r) => r.error).find((e) => e && !isRevert(e));
    const second: { t: TokenInfo; m: PoolMeta; quote: string }[] = [];
    for (const p of plan) {
      const t = p.t;
      if (p.v4) {
        const [slot, dec, qdec] = [res[p.base], res[p.base + 1], res[p.base + 2]];
        const sqrtWord = slot ? words(slot)[0] : undefined;
        if (sqrtWord === undefined || sqrtWord === 0n || !dec) {
          const why = transient(detailed.slice(p.base, p.base + 3));
          if (why) unsupported(st, t, `rpc: ${why}`, NO_QUOTE_RETRY_MS);
          else unsupported(st, t, 'v4 pool did not answer');
          continue;
        }
        const quoteIsNative = t.quoteAddress!.toLowerCase() === ZERO;
        const quoteDecimals = quoteIsNative ? 18 : qdec ? Number(words(qdec)[0]) : undefined;
        if (quoteDecimals === undefined) {
          unsupported(st, t, 'quote token decimals did not answer');
          continue;
        }
        const tokenDecimals = Number(words(dec)[0]);
        const sqrt = sqrtWord & ((1n << 160n) - 1n);
        const byAddress = t.address.toLowerCase() < t.quoteAddress!.toLowerCase();
        const quoteUsd = deps.quotes.usd(t.quoteSymbol!);
        const ref = t.priceUsd && quoteUsd ? t.priceUsd / quoteUsd : undefined;
        const tokenIs0 = orientBySanity(priceFromSqrt(sqrt, tokenDecimals, quoteDecimals, true), priceFromSqrt(sqrt, tokenDecimals, quoteDecimals, false), ref, byAddress);
        const m: PoolMeta = { pair: t.pairAddress!, kind: 'v4', tokenIs0, tokenDecimals, quoteDecimals, supplyAt: 0, retryAt: 0 };
        meta.set(t.address, m);
        ready.push({ t, m });
        continue;
      }
      const [t0, t1, slot0, reserves, dec] = [res[p.base], res[p.base + 1], res[p.base + 2], res[p.base + 3], res[p.base + 4]];
      const token0 = t0 ? addressWord(t0) : undefined;
      const token1 = t1 ? addressWord(t1) : undefined;
      if (!token0 || !token1 || !dec) {
        const why = transient(detailed.slice(p.base, p.base + 5));
        if (why) unsupported(st, t, `rpc: ${why}`, NO_QUOTE_RETRY_MS);
        else unsupported(st, t, 'pool is not a Uniswap-style pair');
        continue;
      }
      const me = t.address.toLowerCase();
      const tokenIs0 = token0 === me;
      if (!tokenIs0 && token1 !== me) {
        unsupported(st, t, 'pool does not hold this token');
        continue;
      }
      const kind: PoolKind | undefined = slot0 && words(slot0)[0] ? 'v3' : reserves && words(reserves).length >= 2 ? 'v2' : undefined;
      if (!kind) {
        unsupported(st, t, 'pool is neither v2 nor v3');
        continue;
      }
      const m: PoolMeta = { pair: t.pairAddress!, kind, tokenIs0, tokenDecimals: Number(words(dec)[0]), quoteDecimals: 18, supplyAt: 0, retryAt: 0 };
      second.push({ t, m, quote: tokenIs0 ? token1 : token0 });
    }
    if (second.length) {
      const qres = await evmCalls(url, second.flatMap((s) => [{ to: s.quote, data: SEL.decimals }, { to: s.quote, data: SEL.symbol }]), fetchImpl);
      second.forEach((s, i) => {
        const w = qres[2 * i] ? words(qres[2 * i]!)[0] : undefined;
        if (w === undefined) {
          unsupported(st, s.t, 'quote token decimals did not answer');
          return;
        }
        s.m.quoteDecimals = Number(w);
        s.m.quoteAddress = s.quote;
        if (!s.t.quoteSymbol) {
          const sym = qres[2 * i + 1] ? decodeString(qres[2 * i + 1]!) : undefined;
          if (!sym) {
            unsupported(st, s.t, 'quote token has no readable symbol', NO_QUOTE_RETRY_MS);
            return;
          }
          if (deps.quotes.usd(sym) === undefined) {
            unsupported(st, s.t, `paired with ${sym}, which is not priced`, NO_QUOTE_RETRY_MS);
            return;
          }
          s.m.quoteSymbol = sym;
        }
        meta.set(s.t.address, s.m);
        ready.push({ t: s.t, m: s.m });
      });
    }
  }

  async function solanaNetwork(tokens: TokenInfo[], st: NetworkStatus): Promise<void> {
    const ep = deps.endpoints.urlFor('solana');
    if (!ep) return;
    const curve: TokenInfo[] = [];
    for (const t of tokens) {
      if (!isPumpfun(t) || !t.pairAddress) {
        skip(st, t.pairAddress ? `${t.dex ?? 'unknown'} pools are not read on-chain yet` : 'no pool address yet');
        continue;
      }
      // the curve layout is read as SOL reserves; a curve denominated in another token would be priced 1:1 wrong
      if (t.quoteSymbol && !/^W?SOL$/i.test(t.quoteSymbol)) {
        skip(st, `paired with ${t.quoteSymbol}, which is not priced`);
        continue;
      }
      const m = metaFor(t);
      if (m?.kind === 'unsupported' && now() < m.retryAt) {
        skip(st, m.reason ?? 'unsupported');
        continue;
      }
      curve.push(t);
    }
    if (!curve.length) return;
    const solUsd = deps.quotes.usd('SOL');
    if (solUsd === undefined) {
      for (const _ of curve) skip(st, 'SOL is not priced yet');
      return;
    }
    const accounts = await solanaAccounts(ep.url, curve.map((t) => t.pairAddress!), fetchImpl);
    curve.forEach((t, i) => {
      const c = accounts[i] ? decodePumpCurve(accounts[i]!) : undefined;
      if (!c) {
        unsupported(st, t, 'bonding curve account not found');
        return;
      }
      if (c.complete) {
        unsupported(st, t, 'curve complete (graduated)');
        return;
      }
      const m = metaFor(t) ?? { pair: t.pairAddress!, kind: 'pumpfun' as const, tokenIs0: true, tokenDecimals: 6, quoteDecimals: 9, supplyAt: now(), retryAt: 0 };
      m.kind = 'pumpfun';
      meta.set(t.address, m);
      noteApiSupply(t, m);
      if (publish(t, m, pumpPriceSol(c), solUsd, Number(c.tokenTotalSupply) / 1e6)) st.live++;
      else skip(st, 'curve returned no price');
    });
  }

  return {
    /** price every token that has a pool; one tick */
    async refresh(tokens: TokenInfo[]): Promise<void> {
      if (inflight) return;
      inflight = true;
      try {
        const byNet = new Map<string, TokenInfo[]>();
        for (const t of tokens) {
          if (!t.network || !CHAINS[t.network]) continue;
          (byNet.get(t.network) ?? byNet.set(t.network, []).get(t.network)!).push(t);
        }
        await Promise.all(
          [...byNet].map(async ([network, list]) => {
            const st: NetworkStatus = { ...(status.get(network) ?? { live: 0, skipped: 0, reasons: {} }), live: 0, skipped: 0, reasons: {} };
            try {
              if (CHAINS[network].kind === 'solana') await solanaNetwork(list, st);
              else await evmNetwork(network, list, st);
              st.lastOkAt = now();
              st.lastError = undefined;
            } catch (e) {
              st.lastError = (e as Error).message;
              log(`${network}: ${st.lastError}`);
            }
            status.set(network, st);
          }),
        );
      } finally {
        inflight = false;
      }
    },
    status(): Record<string, NetworkStatus> {
      return Object.fromEntries(status);
    },
    /** the pool answered for this token recently: the API sources should not overwrite its price */
    isLive(address: string): boolean {
      const m = meta.get(address);
      return !!m && m.kind !== 'unsupported' && m.liveAt !== undefined && now() - m.liveAt < LIVE_STALE_MS;
    },
    /** why a token is not priced live (undefined when it is, or was never looked at) */
    reason(address: string): string | undefined {
      const m = meta.get(address);
      return m?.kind === 'unsupported' ? m.reason : undefined;
    },
  };
}

export type LivePricer = ReturnType<typeof createLivePricer>;
