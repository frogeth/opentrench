import { encodeAbiParameters, keccak256 } from 'viem';
import type { TokenInfo } from '../types.js';
import { CHAINS } from './chains.js';
import type { Endpoints } from './endpoints.js';
import { SEL, V4_POOLS_SLOT, addressWord, decodeString, isV4PoolId, orientBySanity, priceFromReserves, priceFromSqrt, words } from './pools.js';
import { isStable, nativeRef, quoteKey, type QuoteRef } from './quotes.js';
import { evmCalls, evmCallsDetailed, isRevert, solanaAccounts, type EvmResult, type FetchLike, type SolanaAccount } from './rpc.js';
import { decodeSolanaPool, kindOf, mintDecimals, tokenAccountAmount, type SolanaKind, type SolanaPool } from './solana.js';

/**
 * Live prices straight from the pools, for the tokens on someone's screen. Uniswap v2 / v3 / v4
 * and Pons curves on EVM chains; pump.fun, PumpSwap, Raydium (v4, CPMM, CLMM, LaunchLab), Meteora
 * (DLMM, DAMM v2, DBC) and Orca on Solana. One batched RPC per chain per round.
 *
 * A pool gives the price in its quote asset. That asset is priced on-chain as well: a stable is a
 * dollar, a native coin comes from a reference pool on its home chain (quotes.ts), and anything
 * else — a tokenized stock, WHYPE, a meme used as a quote — is priced through its own main pool,
 * discovered once (Dexscreener's directory, never its price) and read live like any token. So a
 * tick prices the deepest quotes first, then the quotes, then the tokens.
 *
 * The market cap follows the supply the API sources implied (their cap over their price) so the
 * number moves live but never jumps when the source switches; the chain's total supply is the
 * fallback. Liquidity, volume and 24h change keep coming from Dexscreener / GeckoTerminal.
 */
export interface LiveDeps {
  endpoints: Endpoints;
  apply: (address: string, info: Partial<TokenInfo>) => void;
  /** where a quote asset trades: its main pool and what that pool is quoted in (a directory lookup, cached here) */
  discover?: (network: string, address: string) => Promise<Partial<TokenInfo> | undefined>;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface NetworkStatus {
  /** tokens priced on-chain in the last tick */
  live: number;
  /** tokens this tick could not price */
  skipped: number;
  /** why, counted by reason */
  reasons: Record<string, number>;
  lastOkAt?: number;
  lastError?: string;
}

/** A token or a quote asset: anything with a pool to read. */
interface Item {
  key: string;
  address: string;
  network: string;
  symbol: string;
  pairAddress: string;
  quoteSymbol?: string;
  quoteAddress?: string;
  dex?: string;
  /** a reference price in quote units, for orienting pools that do not say which side is which */
  ref?: number;
  /** the feed token this is (absent for quote assets) */
  token?: TokenInfo;
}

type EvmKind = 'v2' | 'v3' | 'v4' | 'curve2';
interface PoolMeta {
  pair: string;
  kind: EvmKind | 'sol' | 'unsupported';
  reason?: string;
  solKind?: SolanaKind;
  /** Solana: the static half of the decoded pool (vaults, fees to subtract, quote mint) */
  sol?: SolanaPool;
  tokenIs0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  /** the quote as the pool itself reports it (may differ from what an API said) */
  quoteSymbol?: string;
  quoteAddress?: string;
  chainSupply?: number;
  supplyAt: number;
  apiSupply?: number;
  lastPrice?: number;
  liveAt?: number;
  retryAt: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const SUPPLY_TTL_MS = 10 * 60_000;
const RETRY_MS = 10 * 60_000;
const SOON_MS = 60_000;
const LIVE_STALE_MS = 60_000;
const QUOTE_STALE_MS = 120_000;
const DISCOVER_TTL_MS = 10 * 60_000;
const DISCOVER_FAIL_MS = 60_000;
const VISIBLE_TTL_MS = 30_000;
const MAX_DEPTH = 3;

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const v4Slot = (poolId: string) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId as `0x${string}`, V4_POOLS_SLOT]));
const MASK160 = (1n << 160n) - 1n;

export function createLivePricer(deps: LiveDeps) {
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const meta = new Map<string, PoolMeta>();
  /** feed tokens' meta by plain address, for isLive (the hub only knows the address) */
  const byAddress = new Map<string, string>();
  const status = new Map<string, NetworkStatus>();
  /** dollar price of quote assets, by quote key */
  const quoteUsd = new Map<string, { usd: number; at: number }>();
  /** where a quote asset trades, by quote key */
  const discovered = new Map<string, { item?: Item; at: number; pending?: Promise<void>; error?: string }>();
  const visible = new Map<string, { addresses: string[]; at: number }>();
  let inflight = false;

  const skip = (st: NetworkStatus, reason: string) => {
    st.skipped++;
    st.reasons[reason] = (st.reasons[reason] ?? 0) + 1;
  };
  const unsupported = (st: NetworkStatus, it: Item, reason: string, retryMs = RETRY_MS): PoolMeta => {
    const m: PoolMeta = { pair: it.pairAddress, kind: 'unsupported', reason, tokenIs0: false, tokenDecimals: 0, quoteDecimals: 0, supplyAt: 0, retryAt: now() + retryMs };
    meta.set(it.key, m);
    skip(st, reason);
    return m;
  };
  const metaFor = (it: Item): PoolMeta | undefined => {
    const m = meta.get(it.key);
    return m && m.pair === it.pairAddress ? m : undefined;
  };
  const statusFor = (network: string): NetworkStatus => {
    let st = status.get(network);
    if (!st) status.set(network, (st = { live: 0, skipped: 0, reasons: {} }));
    return st;
  };

  // ---------- quotes ----------
  const itemFromRef = (r: QuoteRef): Item => ({ key: r.key, address: r.address, network: r.network, symbol: r.symbol, pairAddress: r.pairAddress, quoteSymbol: r.quoteSymbol, quoteAddress: r.quoteAddress, dex: r.dex });
  /** what an item's quote is: a dollar, or another item to price first, or a reason it cannot be priced yet */
  const quoteOf = (it: Item, m?: PoolMeta): { usd: 1 } | { item: Item } | { reason: string } => {
    const symbol = m?.quoteSymbol ?? it.quoteSymbol;
    const address = m?.quoteAddress ?? it.quoteAddress;
    if (isStable(symbol, address)) return { usd: 1 };
    const native = nativeRef(symbol);
    if (native) return { item: itemFromRef(native) };
    if (!address) return { reason: symbol ? `no address for ${symbol}` : 'no quote asset yet' };
    const key = quoteKey(it.network, address);
    const d = discovered.get(key);
    if (d?.item) return { item: d.item };
    if (d && d.pending) return { reason: `finding a pool for ${symbol ?? address.slice(0, 6)}` };
    if (d && now() - d.at < DISCOVER_FAIL_MS) return { reason: d.error ?? `no pool for ${symbol ?? address.slice(0, 6)}` };
    if (!deps.discover) return { reason: `paired with ${symbol ?? address.slice(0, 6)}, which is not priced` };
    const entry = { at: now(), pending: undefined as Promise<void> | undefined };
    entry.pending = deps
      .discover(it.network, address)
      .then((info) => {
        const pair = info?.pairAddress;
        if (!pair) {
          discovered.set(key, { at: now(), error: `no pool for ${symbol ?? info?.symbol ?? address.slice(0, 6)}` });
          return;
        }
        const sym = info?.symbol ?? symbol ?? address.slice(0, 6);
        const qUsd = info?.priceUsd;
        discovered.set(key, { at: now(), item: { key, address, network: it.network, symbol: sym, pairAddress: pair, quoteSymbol: info?.quoteSymbol, quoteAddress: info?.quoteAddress, dex: info?.dex, ref: qUsd } });
      })
      .catch((e) => {
        discovered.set(key, { at: now(), error: `lookup failed for ${symbol ?? address.slice(0, 6)}: ${(e as Error).message}` });
      });
    discovered.set(key, entry);
    return { reason: `finding a pool for ${symbol ?? address.slice(0, 6)}` };
  };
  const quoteUsdOf = (it: Item, m?: PoolMeta): number | { reason: string } => {
    const q = quoteOf(it, m);
    if ('usd' in q) return 1;
    if ('reason' in q) return q;
    const v = quoteUsd.get(q.item.key);
    if (v && now() - v.at < QUOTE_STALE_MS) return v.usd;
    return { reason: `${q.item.symbol} not priced yet` };
  };

  // ---------- publishing ----------
  const noteApiSupply = (t: TokenInfo, m: PoolMeta) => {
    if (t.priceSource !== 'chain' && t.marketCap && t.priceUsd && t.marketCap > 0 && t.priceUsd > 0) m.apiSupply = t.marketCap / t.priceUsd;
  };
  /** price in quote units → dollars; tokens go to the hub, quote assets into the quote table */
  const publish = (it: Item, m: PoolMeta, priceQuote: number, qUsd: number): boolean => {
    const priceUsd = priceQuote * qUsd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
    m.lastPrice = priceUsd;
    m.liveAt = now();
    if (!it.token) {
      quoteUsd.set(it.key, { usd: priceUsd, at: now() });
      return true;
    }
    const t = it.token;
    noteApiSupply(t, m);
    if (t.priceUsd === priceUsd && t.priceSource === 'chain') return true;
    const info: Partial<TokenInfo> = { priceUsd, priceSource: 'chain', priceAt: now() };
    const s = m.apiSupply ?? m.chainSupply;
    if (s && s > 0) info.marketCap = priceUsd * s;
    if (!t.quoteSymbol && m.quoteSymbol) info.quoteSymbol = m.quoteSymbol;
    if (!t.quoteAddress && m.quoteAddress) info.quoteAddress = m.quoteAddress;
    deps.apply(t.address, info);
    return true;
  };

  // ---------- EVM ----------
  async function evmRound(network: string, items: Item[], st: NetworkStatus): Promise<void> {
    const chain = CHAINS[network];
    const ep = deps.endpoints.urlFor(network);
    if (!chain || !ep) return;
    const toResolve: Item[] = [];
    const ready: { it: Item; m: PoolMeta }[] = [];
    for (const it of items) {
      const m = metaFor(it);
      if (!m) toResolve.push(it);
      else if (m.kind === 'unsupported') {
        if (now() >= m.retryAt) toResolve.push(it);
        else skip(st, m.reason ?? 'unsupported');
      } else ready.push({ it, m });
    }
    if (toResolve.length) await resolveEvm(chain.v4, ep.url, toResolve, ready, st);
    if (!ready.length) return;

    const calls = ready.map(({ it, m }) => {
      if (m.kind === 'v4') return { to: chain.v4!, data: SEL.extsload + pad32(v4Slot(it.pairAddress)) };
      return { to: it.pairAddress, data: m.kind === 'v3' ? SEL.slot0 : SEL.getReserves };
    });
    const supplyIdx: number[] = [];
    for (const [i, { it, m }] of ready.entries()) {
      if (it.token && now() - m.supplyAt > SUPPLY_TTL_MS) {
        supplyIdx.push(i);
        calls.push({ to: it.address, data: SEL.totalSupply });
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
    ready.forEach(({ it, m }, i) => {
      const r = res[i];
      if (!r) {
        skip(st, 'pool did not answer');
        return;
      }
      const qUsd = quoteUsdOf(it, m);
      if (typeof qUsd !== 'number') {
        skip(st, qUsd.reason);
        return;
      }
      let price = 0;
      if (m.kind === 'v2' || m.kind === 'curve2') {
        const [r0, r1] = words(r);
        if (r0 !== undefined && r1 !== undefined) price = m.tokenIs0 ? priceFromReserves(r0, r1, m.tokenDecimals, m.quoteDecimals) : priceFromReserves(r1, r0, m.tokenDecimals, m.quoteDecimals);
      } else {
        const [w] = words(r);
        const sqrt = w === undefined ? 0n : m.kind === 'v4' ? w & MASK160 : w;
        price = priceFromSqrt(sqrt, m.tokenDecimals, m.quoteDecimals, m.tokenIs0);
      }
      if (publish(it, m, price, qUsd)) st.live++;
      else skip(st, 'pool returned no price');
    });
  }

  /** First sight of an EVM pool: its type, orientation and decimals, in two batches. */
  async function resolveEvm(v4: string | undefined, url: string, items: Item[], ready: { it: Item; m: PoolMeta }[], st: NetworkStatus): Promise<void> {
    const plan: { it: Item; base: number; v4: boolean }[] = [];
    const calls: { to: string; data: string }[] = [];
    for (const it of items) {
      const pair = it.pairAddress;
      if (isV4PoolId(pair)) {
        if (!v4) {
          unsupported(st, it, 'Uniswap v4 pool on a chain with no known PoolManager');
          continue;
        }
        if (!it.quoteAddress) {
          unsupported(st, it, 'v4 pool without the quote token address', SOON_MS);
          continue;
        }
        plan.push({ it, base: calls.length, v4: true });
        calls.push({ to: v4, data: SEL.extsload + pad32(v4Slot(pair)) }, { to: it.address, data: SEL.decimals });
        if (it.quoteAddress.toLowerCase() !== ZERO) calls.push({ to: it.quoteAddress, data: SEL.decimals });
        continue;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
        unsupported(st, it, 'no pool address yet', SOON_MS);
        continue;
      }
      plan.push({ it, base: calls.length, v4: false });
      calls.push({ to: pair, data: SEL.token0 }, { to: pair, data: SEL.token1 }, { to: pair, data: SEL.slot0 }, { to: pair, data: SEL.getReserves }, { to: it.address, data: SEL.decimals });
    }
    if (!plan.length) return;
    const detailed = await evmCallsDetailed(url, calls, fetchImpl);
    const res = detailed.map((r) => r.result);
    const transient = (list: EvmResult[]): string | undefined => list.map((r) => r.error).find((e) => e && !isRevert(e));
    const second: { it: Item; m: PoolMeta; quote: string }[] = [];
    for (const p of plan) {
      const it = p.it;
      if (p.v4) {
        const [slot, dec, qdec] = [res[p.base], res[p.base + 1], res[p.base + 2]];
        const sqrtWord = slot ? words(slot)[0] : undefined;
        if (sqrtWord === undefined || sqrtWord === 0n || !dec) {
          const why = transient(detailed.slice(p.base, p.base + 3));
          unsupported(st, it, why ? `rpc: ${why}` : 'v4 pool did not answer', why ? SOON_MS : RETRY_MS);
          continue;
        }
        const quoteIsNative = it.quoteAddress!.toLowerCase() === ZERO;
        const quoteDecimals = quoteIsNative ? 18 : qdec ? Number(words(qdec)[0]) : undefined;
        if (quoteDecimals === undefined) {
          unsupported(st, it, 'quote token decimals did not answer');
          continue;
        }
        const tokenDecimals = Number(words(dec)[0]);
        const sqrt = sqrtWord & MASK160;
        const byAddress = it.address.toLowerCase() < it.quoteAddress!.toLowerCase();
        const tokenIs0 = orientBySanity(priceFromSqrt(sqrt, tokenDecimals, quoteDecimals, true), priceFromSqrt(sqrt, tokenDecimals, quoteDecimals, false), refPrice(it), byAddress);
        const m: PoolMeta = { pair: it.pairAddress, kind: 'v4', tokenIs0, tokenDecimals, quoteDecimals, quoteAddress: it.quoteAddress, quoteSymbol: it.quoteSymbol, supplyAt: 0, retryAt: 0 };
        meta.set(it.key, m);
        ready.push({ it, m });
        continue;
      }
      const [t0, t1, slot0, reserves, dec] = [res[p.base], res[p.base + 1], res[p.base + 2], res[p.base + 3], res[p.base + 4]];
      const token0 = t0 ? addressWord(t0) : undefined;
      const token1 = t1 ? addressWord(t1) : undefined;
      const reserveWords = reserves ? words(reserves) : [];
      if (!dec) {
        const why = transient(detailed.slice(p.base, p.base + 5));
        unsupported(st, it, why ? `rpc: ${why}` : 'token decimals did not answer', why ? SOON_MS : RETRY_MS);
        continue;
      }
      const tokenDecimals = Number(words(dec)[0]);
      if (!token0 || !token1) {
        // Pons-style curve: no token0/token1, but getReserves answers (quote reserve, token reserve)
        if (reserveWords.length >= 2 && it.quoteSymbol) {
          const quoteDecimals = 18;
          const [r0, r1] = reserveWords;
          const p0 = priceFromReserves(r0, r1, tokenDecimals, quoteDecimals); // token is word0
          const p1 = priceFromReserves(r1, r0, tokenDecimals, quoteDecimals); // token is word1
          const tokenIs0 = orientBySanity(p0, p1, refPrice(it), false);
          const m: PoolMeta = { pair: it.pairAddress, kind: 'curve2', tokenIs0, tokenDecimals, quoteDecimals, quoteSymbol: it.quoteSymbol, quoteAddress: it.quoteAddress, supplyAt: 0, retryAt: 0 };
          meta.set(it.key, m);
          ready.push({ it, m });
          continue;
        }
        const why = transient(detailed.slice(p.base, p.base + 5));
        unsupported(st, it, why ? `rpc: ${why}` : 'pool is not a Uniswap-style pair', why ? SOON_MS : RETRY_MS);
        continue;
      }
      const me = it.address.toLowerCase();
      const tokenIs0 = token0 === me;
      if (!tokenIs0 && token1 !== me) {
        unsupported(st, it, 'pool does not hold this token');
        continue;
      }
      const kind: EvmKind | undefined = slot0 && words(slot0)[0] ? 'v3' : reserveWords.length >= 2 ? 'v2' : undefined;
      if (!kind) {
        unsupported(st, it, 'pool is neither v2 nor v3');
        continue;
      }
      const m: PoolMeta = { pair: it.pairAddress, kind, tokenIs0, tokenDecimals, quoteDecimals: 18, supplyAt: 0, retryAt: 0 };
      second.push({ it, m, quote: tokenIs0 ? token1 : token0 });
    }
    if (second.length) {
      const qres = await evmCalls(url, second.flatMap((s) => [{ to: s.quote, data: SEL.decimals }, { to: s.quote, data: SEL.symbol }]), fetchImpl);
      second.forEach((s, i) => {
        const w = qres[2 * i] ? words(qres[2 * i]!)[0] : undefined;
        if (w === undefined) {
          unsupported(st, s.it, 'quote token decimals did not answer');
          return;
        }
        s.m.quoteDecimals = Number(w);
        s.m.quoteAddress = s.quote;
        const sym = qres[2 * i + 1] ? decodeString(qres[2 * i + 1]!) : undefined;
        s.m.quoteSymbol = s.it.quoteSymbol ?? sym;
        if (!s.m.quoteSymbol && !isStable(undefined, s.quote)) {
          unsupported(st, s.it, 'quote token has no readable symbol', SOON_MS);
          return;
        }
        meta.set(s.it.key, s.m);
        ready.push({ it: s.it, m: s.m });
      });
    }
  }
  /** a reference price in quote units (an API's number), only for orienting a pool */
  const refPrice = (it: Item): number | undefined => {
    const usd = it.token?.priceUsd ?? it.ref;
    if (!usd) return undefined;
    const q = quoteUsdOf(it);
    return typeof q === 'number' ? usd / q : undefined;
  };

  // ---------- Solana ----------
  async function solanaRound(items: Item[], st: NetworkStatus): Promise<void> {
    const ep = deps.endpoints.urlFor('solana');
    if (!ep) return;
    const toResolve: Item[] = [];
    const ready: { it: Item; m: PoolMeta }[] = [];
    for (const it of items) {
      const m = metaFor(it);
      if (!m) toResolve.push(it);
      else if (m.kind === 'unsupported') {
        if (now() >= m.retryAt) toResolve.push(it);
        else skip(st, m.reason ?? 'unsupported');
      } else ready.push({ it, m });
    }
    if (toResolve.length) await resolveSolana(ep.url, toResolve, ready, st);
    if (!ready.length) return;

    // one read for everything: pool accounts for price-in-account kinds, vaults for the rest, mints for supply
    const keys: string[] = [];
    const at = (k: string) => {
      keys.push(k);
      return keys.length - 1;
    };
    const plan = ready.map(({ it, m }) => {
      const p = m.sol!;
      const supply = it.token && now() - m.supplyAt > SUPPLY_TTL_MS ? at(it.address) : -1;
      if (p.vaults) return { pool: -1, vb: at(p.vaults[0]), vq: at(p.vaults[1]), supply };
      return { pool: at(it.pairAddress), vb: -1, vq: -1, supply };
    });
    const acc = await solanaAccounts(ep.url, keys, fetchImpl);
    ready.forEach(({ it, m }, i) => {
      const p = plan[i];
      if (p.supply >= 0 && acc[p.supply]) {
        const d = acc[p.supply]!.data;
        if (d.length >= 44) {
          m.chainSupply = Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(36, true)) / 10 ** m.tokenDecimals;
          m.supplyAt = now();
        }
      }
      let raw = 0;
      if (p.pool >= 0) {
        const a = acc[p.pool];
        const pool = a ? decodeSolanaPool(m.solKind!, a.data, it.address) : undefined;
        if (!pool) {
          skip(st, 'pool did not answer');
          return;
        }
        if (pool.done) {
          unsupported(st, it, 'curve complete (graduated)', SOON_MS);
          return;
        }
        if (pool.supplyRaw !== undefined) {
          m.chainSupply = Number(pool.supplyRaw) / 10 ** m.tokenDecimals;
          m.supplyAt = now();
        }
        raw = pool.price ?? 0;
      } else {
        const b = acc[p.vb] ? tokenAccountAmount(acc[p.vb]!.data) : undefined;
        const q = acc[p.vq] ? tokenAccountAmount(acc[p.vq]!.data) : undefined;
        if (b === undefined || q === undefined) {
          skip(st, 'pool vaults did not answer');
          return;
        }
        const less = m.sol!.vaultLess ?? [0n, 0n];
        const bn = b - less[0], qn = q - less[1];
        raw = bn > 0n && qn > 0n ? Number(qn) / Number(bn) : 0;
      }
      const qUsd = quoteUsdOf(it, m);
      if (typeof qUsd !== 'number') {
        skip(st, qUsd.reason);
        return;
      }
      const price = raw * 10 ** (m.tokenDecimals - m.quoteDecimals);
      if (publish(it, m, price, qUsd)) st.live++;
      else skip(st, 'pool returned no price');
    });
  }

  /** First sight of a Solana pool: the program says the layout; the mints say the decimals. */
  async function resolveSolana(url: string, items: Item[], ready: { it: Item; m: PoolMeta }[], st: NetworkStatus): Promise<void> {
    const accounts = await solanaAccounts(url, items.map((it) => it.pairAddress), fetchImpl);
    const pending: { it: Item; pool: SolanaPool; kind: SolanaKind }[] = [];
    items.forEach((it, i) => {
      const a = accounts[i];
      if (!a) {
        unsupported(st, it, 'pool account not found', SOON_MS);
        return;
      }
      const kind = kindOf(a.owner);
      if (!kind) {
        unsupported(st, it, `${it.dex ?? 'this'} pool program is not supported (${a.owner.slice(0, 6)}…)`);
        return;
      }
      const pool = decodeSolanaPool(kind, a.data, it.address);
      if (!pool) {
        unsupported(st, it, 'pool does not hold this token');
        return;
      }
      // a pump.fun curve does not name its quote; most are SOL, but a curve raised in another
      // token (a tokenized stock, a meme) is what the directory said it is
      if (kind === 'pumpfun' && it.quoteAddress && it.quoteAddress !== pool.quoteMint) {
        pool.quoteMint = it.quoteAddress;
        pool.quoteDecimals = undefined;
      }
      if (pool.done) {
        unsupported(st, it, 'curve complete (graduated)', SOON_MS);
        return;
      }
      pending.push({ it, pool, kind });
    });
    if (!pending.length) return;
    // DBC keeps its quote mint in the config account
    const cfgIdx = pending.map((p) => (p.pool.quoteFromConfig ? p.pool.quoteFromConfig : undefined));
    const cfgKeys = cfgIdx.filter((k): k is string => !!k);
    if (cfgKeys.length) {
      const cfgs = await solanaAccounts(url, cfgKeys, fetchImpl);
      let k = 0;
      pending.forEach((p, i) => {
        if (!cfgIdx[i]) return;
        const c = cfgs[k++];
        if (c && c.data.length >= 40) p.pool.quoteMint = base58Of(c.data.subarray(8, 40));
      });
    }
    // decimals from the mints, unless the pool already stores them
    const mintKeys: string[] = [];
    const need = pending.map((p) => {
      const b = p.pool.baseDecimals === undefined ? (mintKeys.push(p.it.address), mintKeys.length - 1) : -1;
      const q = p.pool.quoteDecimals === undefined && p.pool.quoteMint ? (mintKeys.push(p.pool.quoteMint), mintKeys.length - 1) : -1;
      return { b, q };
    });
    const mints = mintKeys.length ? await solanaAccounts(url, mintKeys, fetchImpl) : [];
    pending.forEach((p, i) => {
      const { it, pool, kind } = p;
      if (!pool.quoteMint) {
        unsupported(st, it, 'pool does not say its quote', SOON_MS);
        return;
      }
      const bd = pool.baseDecimals ?? (need[i].b >= 0 && mints[need[i].b] ? mintDecimals(mints[need[i].b]!.data) : undefined);
      const qd = pool.quoteDecimals ?? (need[i].q >= 0 && mints[need[i].q] ? mintDecimals(mints[need[i].q]!.data) : undefined);
      if (bd === undefined || qd === undefined) {
        unsupported(st, it, 'mint decimals did not answer', SOON_MS);
        return;
      }
      const m: PoolMeta = {
        pair: it.pairAddress,
        kind: 'sol',
        solKind: kind,
        sol: pool,
        tokenIs0: true,
        tokenDecimals: bd,
        quoteDecimals: qd,
        quoteAddress: pool.quoteMint,
        // the pool's quote mint is the truth; an API's symbol is only a label for it
        quoteSymbol: it.quoteAddress === pool.quoteMint ? it.quoteSymbol : pool.quoteMint === nativeRef('SOL')!.address ? 'SOL' : isStable(undefined, pool.quoteMint) ? 'USD' : it.quoteSymbol,
        supplyAt: 0,
        retryAt: 0,
      };
      meta.set(it.key, m);
      ready.push({ it, m });
    });
  }

  // ---------- the tick ----------
  const toItem = (t: TokenInfo): Item | undefined => {
    if (!t.network || !t.pairAddress || !CHAINS[t.network]) return undefined;
    const key = quoteKey(t.network, t.address);
    byAddress.set(t.address, key);
    return { key, address: t.address, network: t.network, symbol: t.symbol ?? t.address.slice(0, 6), pairAddress: t.pairAddress, quoteSymbol: t.quoteSymbol, quoteAddress: t.quoteAddress, dex: t.dex, token: t };
  };

  async function round(items: Item[]): Promise<void> {
    const byNet = new Map<string, Item[]>();
    for (const it of items) (byNet.get(it.network) ?? byNet.set(it.network, []).get(it.network)!).push(it);
    await Promise.all(
      [...byNet].map(async ([network, list]) => {
        const st = statusFor(network);
        try {
          if (CHAINS[network].kind === 'solana') await solanaRound(list, st);
          else await evmRound(network, list, st);
          st.lastOkAt = now();
          st.lastError = undefined;
        } catch (e) {
          st.lastError = (e as Error).message;
          log(`${network}: ${st.lastError}`);
        }
      }),
    );
  }

  return {
    /** price every token that has a pool: the quotes' quotes, then the quotes, then the tokens */
    async refresh(tokens: TokenInfo[]): Promise<void> {
      if (inflight) return;
      inflight = true;
      try {
        for (const st of status.values()) {
          st.live = 0;
          st.skipped = 0;
          st.reasons = {};
        }
        const levels: Item[][] = [tokens.map(toItem).filter((x): x is Item => !!x)];
        const seen = new Set(levels[0].map((it) => it.key));
        for (let depth = 0; depth < MAX_DEPTH; depth++) {
          const next: Item[] = [];
          for (const it of levels[depth]) {
            const q = quoteOf(it, metaFor(it));
            if ('item' in q && !seen.has(q.item.key)) {
              seen.add(q.item.key);
              next.push(q.item);
            }
          }
          if (!next.length) break;
          levels.push(next);
        }
        for (let i = levels.length - 1; i >= 0; i--) await round(levels[i]);
      } finally {
        inflight = false;
      }
    },
    status(): Record<string, NetworkStatus> {
      return Object.fromEntries(status);
    },
    /** the pool answered for this token recently: the API sources should not overwrite its price */
    isLive(address: string): boolean {
      const key = byAddress.get(address);
      const m = key ? meta.get(key) : undefined;
      return !!m && m.kind !== 'unsupported' && m.liveAt !== undefined && now() - m.liveAt < LIVE_STALE_MS;
    },
    /** why a token is not priced live (undefined when it is, or was never looked at) */
    reason(network: string, address: string): string | undefined {
      const m = meta.get(quoteKey(network, address));
      return m?.kind === 'unsupported' ? m.reason : undefined;
    },
    /** what a quote asset is worth right now, for the status page */
    quotes(): Record<string, number> {
      return Object.fromEntries([...quoteUsd].map(([k, v]) => [k, v.usd]));
    },
    /** a screen (one client) reports the tokens it is showing */
    setVisible(client: string, addresses: string[]): void {
      visible.set(client, { addresses, at: now() });
    },
    /** every token some screen showed in the last half minute */
    visible(): Set<string> {
      const out = new Set<string>();
      for (const [client, v] of visible) {
        if (now() - v.at > VISIBLE_TTL_MS) visible.delete(client);
        else for (const a of v.addresses) out.add(a);
      }
      return out;
    },
  };

}

/** base58 for a 32-byte key (kept here so solana.ts stays dependency-free in both directions) */
function base58Of(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export type LivePricer = ReturnType<typeof createLivePricer>;
