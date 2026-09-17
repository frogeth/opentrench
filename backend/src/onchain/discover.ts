import { CHAINS } from './chains.js';
import type { Endpoints } from './endpoints.js';
import { findProgramAddress, utf8 } from './pda.js';
import { SEL, addressWord, words } from './pools.js';
import { evmCallsDetailed, solanaAccounts, type FetchLike } from './rpc.js';
import { decodeSolanaPool, PROGRAMS, SOL_MINT } from './solana.js';

/**
 * Where a fresh token trades, from the chain itself: Uniswap v2 `getPair` and v3 `getPool` on
 * each chain's factories against its usual quote assets (wrapped native, the stables), the pool
 * holding the most quote winning; on Solana the pump.fun curve and LaunchLab pool are derived
 * addresses of the mint. Seconds after a launch the pool exists while no site has indexed it.
 * v4 pools and PumpSwap/Raydium AMMs have no derivable address: those wait for the directory.
 */
export interface Discovered {
  pairAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
  dex: string;
  /** v3 fee tier, when it is one */
  fee?: number;
  /** the pool's quote balance in whole units (its depth, for picking between pools) */
  depth?: number;
}

interface Factories {
  v2?: string;
  v3?: string;
  v3Fees?: number[];
}
export interface QuoteAsset {
  symbol: string;
  address: string;
  decimals: number;
}

/** factories seen on the chains in the feed (2026-09-17); a chain missing here learns its own from an existing pool's factory() */
export const FACTORIES: Record<string, Factories> = {
  ethereum: { v2: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', v3: '0x1f98431c8ad98523631ae4a59f267346ea31f984' },
  base: { v2: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', v3: '0x33128a8fc17869897dce68ed026d694621f6fdfd' },
  arbitrum: { v2: '0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9', v3: '0x1f98431c8ad98523631ae4a59f267346ea31f984' },
  bsc: { v2: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', v3: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', v3Fees: [100, 500, 2500, 10000] },
  polygon: { v3: '0x1f98431c8ad98523631ae4a59f267346ea31f984' },
  avalanche: { v3: '0x740b1c1de25031c31ff4fc9a62f554a55cdc1bad' },
  robinhood: { v2: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', v3: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' },
  arc: { v2: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba', v3: '0xf0db7b58379503491d857db50ac9ece64c653918' },
  ink: { v3: '0x640887a9ba3a9c53ed27d0f7e8246a4f933f3424' },
  hyperevm: { v3: '0xff7b3e8c00e57ea31477c32a5b52a58eea47b072' },
};
const DEFAULT_FEES = [500, 3000, 10000, 100];

/** the assets a chain's pools are usually quoted in */
export const QUOTES: Record<string, QuoteAsset[]> = {
  ethereum: [
    { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
  ],
  base: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  ],
  arbitrum: [
    { symbol: 'WETH', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 },
    { symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  ],
  bsc: [
    { symbol: 'WBNB', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', decimals: 18 },
    { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  ],
  polygon: [
    { symbol: 'WPOL', address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', decimals: 18 },
    { symbol: 'USDC', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  ],
  avalanche: [
    { symbol: 'WAVAX', address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', decimals: 18 },
    { symbol: 'USDC', address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 },
  ],
  robinhood: [
    { symbol: 'WETH', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', decimals: 18 },
    { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
  ],
  arc: [{ symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 }],
  ink: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x2d270e6886d130d724215a266106e6832161eaed', decimals: 6 },
  ],
  hyperevm: [{ symbol: 'WHYPE', address: '0x5555555555555555555555555555555555555555', decimals: 18 }],
};

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const GET_PAIR = '0xe6a43905'; // getPair(address,address)
const GET_POOL = '0x1698ee82'; // getPool(address,address,uint24)
const BALANCE_OF = '0x70a08231';
const FACTORY = '0xc45a0155';

export interface DiscoverDeps {
  endpoints: Endpoints;
  fetch?: FetchLike;
  /** an existing pool on the chain, to learn its factory when the table has none */
  knownPool?: (network: string) => string | undefined;
}

const learned = new Map<string, Factories>();

/** Uniswap-style pools for a token on one EVM chain, deepest first. */
export async function discoverEvm(network: string, token: string, deps: DiscoverDeps): Promise<Discovered[]> {
  const chain = CHAINS[network];
  const ep = deps.endpoints.urlFor(network);
  if (!chain || chain.kind !== 'evm' || !ep || !/^0x[0-9a-fA-F]{40}$/.test(token)) return [];
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const quotes = QUOTES[network] ?? [];
  if (!quotes.length) return [];
  let fac: Factories | undefined = FACTORIES[network] ?? learned.get(network);
  if (!fac) {
    const pool = deps.knownPool?.(network);
    if (!pool) return [];
    const [r, s] = await evmCallsDetailed(ep.url, [{ to: pool, data: FACTORY }, { to: pool, data: SEL.slot0 }], fetchImpl);
    const f = r.result ? addressWord(r.result) : undefined;
    if (!f) return [];
    fac = s.result ? { v3: f } : { v2: f };
    learned.set(network, fac);
  }
  const fees = fac.v3Fees ?? DEFAULT_FEES;
  const calls: { to: string; data: string }[] = [];
  const plan: { quote: QuoteAsset; fee?: number }[] = [];
  for (const q of quotes) {
    if (fac.v2) {
      plan.push({ quote: q });
      calls.push({ to: fac.v2, data: GET_PAIR + pad32(token) + pad32(q.address) });
    }
    if (fac.v3)
      for (const fee of fees) {
        plan.push({ quote: q, fee });
        calls.push({ to: fac.v3, data: GET_POOL + pad32(token) + pad32(q.address) + pad32(fee.toString(16)) });
      }
  }
  const res = await evmCallsDetailed(ep.url, calls, fetchImpl);
  const found: { plan: (typeof plan)[number]; pool: string }[] = [];
  res.forEach((r, i) => {
    const pool = r.result ? addressWord(r.result) : undefined;
    if (pool && pool !== '0x0000000000000000000000000000000000000000') found.push({ plan: plan[i], pool });
  });
  if (!found.length) return [];
  // depth: the quote the pool holds
  const bal = await evmCallsDetailed(ep.url, found.map((f) => ({ to: f.plan.quote.address, data: BALANCE_OF + pad32(f.pool) })), fetchImpl);
  const out: Discovered[] = found.map((f, i) => {
    const w = bal[i].result ? words(bal[i].result)[0] : undefined;
    const depth = w !== undefined ? Number(w) / 10 ** f.plan.quote.decimals : 0;
    return { pairAddress: f.pool, quoteSymbol: f.plan.quote.symbol, quoteAddress: f.plan.quote.address, dex: network === 'bsc' ? 'pancakeswap' : network === 'hyperevm' ? 'prjx' : 'uniswap', fee: f.plan.fee, depth };
  });
  return out.filter((o) => (o.depth ?? 0) > 0).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
}

/** pump.fun curve or LaunchLab pool of a mint, when it exists and still trades. */
export async function discoverSolana(mint: string, deps: DiscoverDeps): Promise<Discovered | undefined> {
  const ep = deps.endpoints.urlFor('solana');
  if (!ep || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return undefined;
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const curve = findProgramAddress([utf8('bonding-curve'), mint], PROGRAMS.pumpfun).address;
  const launch = findProgramAddress([utf8('pool'), mint, SOL_MINT], PROGRAMS.raydiumLaunchlab).address;
  const [c, l] = await solanaAccounts(ep.url, [curve, launch], fetchImpl);
  if (c && c.owner === PROGRAMS.pumpfun) {
    const p = decodeSolanaPool('pumpfun', c.data, mint);
    if (p && !p.done) return { pairAddress: curve, quoteSymbol: 'SOL', quoteAddress: SOL_MINT, dex: 'pumpfun' };
  }
  if (l && l.owner === PROGRAMS.raydiumLaunchlab) {
    const p = decodeSolanaPool('raydiumLaunchlab', l.data, mint);
    if (p && !p.done) return { pairAddress: launch, quoteSymbol: 'SOL', quoteAddress: SOL_MINT, dex: 'raydium-launchlab' };
  }
  return undefined;
}
