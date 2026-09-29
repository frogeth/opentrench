import { readCapped, type LaunchpadInfo } from './launchpads.js';
import { findProgramAddress, utf8 } from './onchain/pda.js';
import { base58, decodeSolanaPool, PROGRAMS, SOL_MINT } from './onchain/solana.js';

/**
 * Solana launchpads, read off the chain: which program holds the mint's curve, and which brand's
 * config that curve was launched under, decide the badge. A mint's vanity suffix proves nothing
 * (tens of thousands of "…pump" mints are Meteora DBC launches, and a sixth of BONK.fun's do not end
 * in "bonk"), so it is only a hint for when the chain cannot be asked.
 *
 * Brands are matched by exact account keys, checked on-chain 2026-09-28: a LaunchLab platform
 * config's name is whatever its creator typed (130 configs call themselves "StonkFun"), so names are
 * never read. Nothing from any launchpad's site is loaded.
 *
 * What a brand badge proves: Bags signs every pool it creates (the DBC pool's creator is a required
 * signer), so a Bags badge means Bags made it. A config or platform key (BONK.fun, StonkFun, Moonshot,
 * Believe, daos.fun, trends.fun) means the coin runs on that brand's curve and pays it fees; anyone may
 * create a pool under a public config, the way Jupiter labels these coins too, so it does not prove
 * the coin went through the brand's own app.
 */

const TIMEOUT_MS = 7000;
const RPC_MAX_BYTES = 256_000;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type SolanaPad = 'pumpfun' | 'letsbonk' | 'stonkfun' | 'launchlab' | 'bags' | 'moonshot' | 'believe' | 'daosfun' | 'trends' | 'dbc';

/** LaunchLab platform configs (pool byte 173) by brand; any other platform is Raydium LaunchLab itself. */
export const LAUNCHLAB_PLATFORMS: Record<string, SolanaPad> = {
  // BONK.fun: name "letsbonk.fun", fee wallet YvWXoyyRpD5fPVZHZV6SY8NS1nuTFmyewxudD3mwuE3
  FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1: 'letsbonk',
  BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4: 'letsbonk',
  '82NMHVCKwehXgbXMyzL41mvv3sdkypaMCtTxvJ4CtTzm': 'letsbonk',
  // StonkFun (stonkfun.xyz): name "StonkFun", fee wallet 5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG
  '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt': 'stonkfun',
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7': 'stonkfun',
};

/** Meteora DBC pool configs (pool byte 72) that belong to one brand. */
export const DBC_CONFIGS: Record<string, SolanaPad> = {
  FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM: 'moonshot',
  '7SXEnhGRXVkR5LEE4o6xXYwcX6QJbFemMS3mbmMRHSDn': 'believe',
  BkoMF8PzYwoVQTKcQ6uNeQrHytw1jJN6ig4JzjcKS3iF: 'daosfun',
  '7UNpFBfTdWrcfS7aBQzEaPgZCfPJe8BDgHzwmWUZaMaF': 'trends',
};
/** DBC pool creators (pool byte 104; the creator signs the pool's creation, so it cannot be borrowed). Bags launches every token itself. */
export const DBC_CREATORS: Record<string, SolanaPad> = {
  BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv: 'bags',
};

/** Where a mint's page is on each brand; brands without a per-token page we could check link to the token on Jupiter. */
export function solanaPadUrl(pad: SolanaPad, mint: string): string {
  switch (pad) {
    case 'pumpfun':
      return `https://pump.fun/coin/${mint}`;
    case 'letsbonk':
      return `https://letsbonk.fun/token/${mint}`;
    case 'stonkfun':
      return `https://www.stonkfun.xyz/token/${mint}`;
    case 'launchlab':
      return `https://raydium.io/launchpad/token/?mint=${mint}`;
    case 'bags':
      return `https://bags.fm/${mint}`;
    default:
      return `https://jup.ag/tokens/${mint}`;
  }
}

/** What the chain said: `definitive` false means it could not be asked (then a suffix may still hint). */
export interface SolanaVerdict {
  definitive: boolean;
  info?: LaunchpadInfo;
}

async function rpc(url: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const text = await readCapped(res, RPC_MAX_BYTES);
    if (text === undefined) throw new Error('rpc answer too large');
    const json = JSON.parse(text);
    if (json?.error) throw new Error('rpc error');
    return json?.result;
  } finally {
    clearTimeout(t);
  }
}

interface Account {
  owner: string;
  data: Uint8Array;
}
/** getMultipleAccounts, each answer checked: a base58 owner and base64 data no bigger than a pool or config account. */
async function accounts(url: string, keys: string[], fetchImpl: typeof fetch): Promise<(Account | undefined)[]> {
  const result = await rpc(url, 'getMultipleAccounts', [keys, { encoding: 'base64' }], fetchImpl);
  const values = result?.value;
  if (!Array.isArray(values) || values.length !== keys.length) throw new Error('rpc answer malformed');
  return values.map((v: any) => {
    if (!v) return undefined;
    const b64 = v?.data?.[0];
    if (typeof v.owner !== 'string' || !B58.test(v.owner) || typeof b64 !== 'string' || b64.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return undefined;
    return { owner: v.owner, data: new Uint8Array(Buffer.from(b64, 'base64')) };
  });
}

/** The pool accounts of `program` whose `offset` holds the mint: at most a couple of keys, never the accounts themselves. */
async function poolsHolding(url: string, program: string, size: number, offset: number, mint: string, fetchImpl: typeof fetch): Promise<string[]> {
  const result = await rpc(url, 'getProgramAccounts', [program, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, { memcmp: { offset, bytes: mint } }] }], fetchImpl);
  if (!Array.isArray(result)) throw new Error('rpc answer malformed');
  return result
    .map((r: any) => r?.pubkey)
    .filter((k: unknown): k is string => typeof k === 'string' && B58.test(k))
    .slice(0, 4);
}

/** Anchor account discriminators (sha256("account:<Name>")[..8]), checked on live pools: only a pool account is read as one. */
const LAUNCHLAB_POOL = 'f7ede3f5d7c3de46'; // PoolState
const DBC_POOL = 'd5e005d16245775c'; // VirtualPool
const isAccount = (d: Uint8Array, disc: string) => d.length >= 8 && Buffer.from(d.subarray(0, 8)).toString('hex') === disc;

const key = (d: Uint8Array, o: number): string | undefined => (d.length >= o + 32 ? base58(d.subarray(o, o + 32)) : undefined);
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const pct = (num: bigint, den: bigint): string | undefined => (den > 0n ? `${Math.min(100, Number((num * 1000n) / den) / 10).toFixed(1)}%` : undefined);

function quoteLabel(mint: string | undefined): { quoteSymbol?: string; quoteAddress?: string } {
  if (!mint) return {};
  if (mint === SOL_MINT) return { quoteSymbol: 'SOL', quoteAddress: mint };
  if (mint === USDC_MINT) return { quoteSymbol: 'USDC', quoteAddress: mint };
  if (mint === USD1_MINT) return { quoteSymbol: 'USD1', quoteAddress: mint };
  // any other quote (a tokenized stock, STONK): the pricer finds its price by address
  return { quoteAddress: mint };
}

/** A LaunchLab pool account for this mint → the badge, its progress, and the pool while it still trades. */
export function fromLaunchLab(mint: string, pool: string, d: Uint8Array): LaunchpadInfo | undefined {
  if (d.length !== 429 || !isAccount(d, LAUNCHLAB_POOL)) return undefined;
  const p = decodeSolanaPool('raydiumLaunchlab', d, mint);
  const platform = key(d, 173);
  if (!p || !platform) return undefined;
  const pad = LAUNCHLAB_PLATFORMS[platform] ?? 'launchlab';
  const out: LaunchpadInfo = { launchpad: pad, launchpadUrl: solanaPadUrl(pad, mint), network: 'solana' };
  if (p.done) out.launchpadNote = 'graduated';
  else {
    const raised = pct(u64(d, 61), u64(d, 69));
    out.launchpadNote = raised ? `bonding · ${raised}` : 'bonding';
    Object.assign(out, { pairAddress: pool, dex: 'raydium-launchlab' }, quoteLabel(p.quoteMint));
  }
  return out;
}

/** A Meteora DBC pool account for this mint → the brand (by creator, then config) or plain DBC. */
export function fromDbc(mint: string, pool: string, d: Uint8Array): LaunchpadInfo | undefined {
  if (d.length !== 424 || !isAccount(d, DBC_POOL)) return undefined;
  const p = decodeSolanaPool('meteoraDbc', d, mint);
  const config = key(d, 72);
  const creator = key(d, 104);
  if (!p || !config || !creator) return undefined;
  const pad = DBC_CREATORS[creator] ?? DBC_CONFIGS[config] ?? 'dbc';
  const out: LaunchpadInfo = { launchpad: pad, launchpadUrl: solanaPadUrl(pad, mint), network: 'solana' };
  if (p.done) out.launchpadNote = 'graduated';
  else {
    out.launchpadNote = 'bonding';
    // the quote mint is in the config; the pricer reads it from there
    Object.assign(out, { pairAddress: pool, dex: 'meteora-dbc' });
  }
  return out;
}

/** A pump.fun curve for this mint → the badge; while on the curve, the curve is its pool. */
export function fromPumpCurve(mint: string, curve: string, d: Uint8Array): LaunchpadInfo | undefined {
  const p = decodeSolanaPool('pumpfun', d, mint);
  if (!p) return undefined;
  const out: LaunchpadInfo = { launchpad: 'pumpfun', launchpadUrl: solanaPadUrl('pumpfun', mint), network: 'solana', dex: 'pump.fun' };
  if (p.done) out.launchpadNote = 'graduated';
  else {
    out.pairAddress = curve;
    // a curve that names its quote (USDC) says so; one that does not is SOL, or whatever a directory knows better
    if (p.quoteNamed) Object.assign(out, quoteLabel(p.quoteMint));
  }
  return out;
}

type Reader = (mint: string, pool: string, d: Uint8Array) => LaunchpadInfo | undefined;
/** Where a mint's curve was found: re-read on the next lookup (its state moves), never searched for again. */
type Located = { none: true } | { none?: false; program: string; pool: string; read: Reader };
export interface SolanaCache {
  get(mint: string): Located | undefined;
  set(mint: string, v: Located): void;
}
/** A bounded memo: a mint's launchpad never changes (its pool is created with the mint), so an answer is kept for good. */
export function memoryCache(max = 20_000): SolanaCache {
  const m = new Map<string, Located>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      if (m.size >= max) m.delete(m.keys().next().value!);
      m.set(k, v);
    },
  };
}
const defaultCache = memoryCache();

/** Program-wide lookups are the expensive calls: a few at a time, whatever the feed does. */
const MAX_LOOKUPS = 3;
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= MAX_LOOKUPS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * Which launchpad a mint came from, asked of the chain: the pump.fun curve and the LaunchLab pools
 * that live at derived addresses first (one request), then a lookup by mint in LaunchLab and Meteora
 * DBC for pools quoted in anything else.
 */
export async function classifySolana(mint: string, url: string | undefined, fetchImpl: typeof fetch = fetch, cache: SolanaCache = defaultCache): Promise<SolanaVerdict> {
  if (!url || !B58.test(mint)) return { definitive: false };
  const known = cache.get(mint);
  if (known?.none) return { definitive: true };
  try {
    if (known) {
      // found before: read that pool again for its current state, no search
      const [a] = await accounts(url, [known.pool], fetchImpl);
      const info = a?.owner === known.program ? known.read(mint, known.pool, a.data) : undefined;
      if (info) return { definitive: true, info };
    }
    const hit = (program: string, pool: string, read: Reader, d: Uint8Array): SolanaVerdict | undefined => {
      const info = read(mint, pool, d);
      if (!info) return undefined;
      cache.set(mint, { program, pool, read });
      return { definitive: true, info };
    };
    const curve = findProgramAddress([utf8('bonding-curve'), mint], PROGRAMS.pumpfun).address;
    const quotes = [SOL_MINT, USD1_MINT, USDC_MINT];
    const ll = quotes.map((q) => findProgramAddress([utf8('pool'), mint, q], PROGRAMS.raydiumLaunchlab).address);
    const [c, ...pools] = await accounts(url, [curve, ...ll], fetchImpl);
    if (c?.owner === PROGRAMS.pumpfun) {
      const v = hit(PROGRAMS.pumpfun, curve, fromPumpCurve, c.data);
      if (v) return v;
    }
    for (let i = 0; i < pools.length; i++) {
      const a = pools[i];
      if (a?.owner !== PROGRAMS.raydiumLaunchlab) continue;
      const v = hit(PROGRAMS.raydiumLaunchlab, ll[i], fromLaunchLab, a.data);
      if (v) return v;
    }
    // quoted in something else: look the pool up by its base mint, in both programs at once
    const scans = [
      [PROGRAMS.raydiumLaunchlab, 429, 205, fromLaunchLab],
      [PROGRAMS.meteoraDbc, 424, 136, fromDbc],
    ] as const;
    const found = await Promise.all(scans.map(([program, size, offset]) => limited(() => poolsHolding(url, program, size, offset, mint, fetchImpl))));
    for (let s = 0; s < scans.length; s++) {
      const [program, , , read] = scans[s];
      const keys = found[s];
      if (!keys.length) continue;
      const accs = await accounts(url, keys, fetchImpl);
      for (let i = 0; i < keys.length; i++) {
        const a = accs[i];
        if (a?.owner !== program) continue;
        const v = hit(program, keys[i], read, a.data);
        if (v) return v;
      }
    }
    cache.set(mint, { none: true });
    return { definitive: true };
  } catch {
    // a busy or broken node: nothing is remembered, the next lookup asks again
    return { definitive: false };
  }
}
