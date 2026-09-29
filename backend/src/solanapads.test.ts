import { describe, it, expect, vi } from 'vitest';
import { classifySolana as classifyWith, LAUNCHLAB_PLATFORMS, memoryCache, USD1_MINT, type SolanaCache } from './solanapads.js';
import { createLaunchpadClassifier } from './launchpads.js';
import { decodeBase58, findProgramAddress, utf8 } from './onchain/pda.js';
import { PROGRAMS, SOL_MINT } from './onchain/solana.js';

const URL_ = 'https://solana.test';
/** a fresh memo per call unless a test hands one in: each case asks the chain itself */
const classifySolana = (m: string, u: string | undefined, f: typeof fetch, c: SolanaCache = memoryCache()) => classifyWith(m, u, f, c);
const LL_DISC = Buffer.from('f7ede3f5d7c3de46', 'hex');
const DBC_DISC = Buffer.from('d5e005d16245775c', 'hex');
// a real pump-style mint and real keys (checked on-chain 2026-09-28)
const MINT = '2jkQhGUSzD39Kg5Pn8Y9y8e664fMv7s4cUxMk9EYh3eF';
const OTHER = '8FhU2M7sHjp5i13xFLDxLaCLJUDwvRLdoiT6j5tqbonk';
const XSTOCK = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const BONK_PLATFORM = 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1';
const STONK_PLATFORM = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
const IMPOSTOR_PLATFORM = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
const BAGS = 'BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv';
const MOONSHOT = 'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM';
const SOME_CONFIG = '8PNVrZZVLrJkV1FacPFvo7U45FcWWcj8mWmGQnhA9VFj';
const SOMEONE = '9iSD3wkC1aq3FcwgjJfEua9FkkZJWv7Cuxs6sKjc3VnR';
const POOL_A = 'CXmPJ456Mg3F9eWFNmr992ZMh7ozV2o9ZWQjHK4yyu2Y';
const POOL_D = 'Gt487MasXw1W1jJkemgx6FNaQoq3EYy9ZD5XuEsVRGJB';

const put = (d: Uint8Array, o: number, v: bigint) => {
  for (let i = 0; i < 8; i++) d[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
};
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');
const curvePda = (m: string) => findProgramAddress([utf8('bonding-curve'), m], PROGRAMS.pumpfun).address;
const llPda = (m: string, q: string) => findProgramAddress([utf8('pool'), m, q], PROGRAMS.raydiumLaunchlab).address;

function pumpCurve(o: { complete?: boolean } = {}) {
  const d = new Uint8Array(151);
  put(d, 8, 1_000_000_000_000_000n);
  put(d, 16, 30_000_000_000n);
  put(d, 40, 1_000_000_000_000_000n);
  d[48] = o.complete ? 1 : 0;
  return d;
}
function launchLab(o: { mint?: string; quote?: string; platform: string; status?: number }) {
  const d = new Uint8Array(429);
  d.set(LL_DISC, 0);
  d[17] = o.status ?? 0;
  d[18] = 6;
  d[19] = 9;
  put(d, 37, 1_073_025_605_596_382n);
  put(d, 45, 30_000_852_951n);
  put(d, 61, 21_250_000_000n); // real quote raised
  put(d, 69, 85_000_000_000n); // to raise: 25%
  d.set(decodeBase58(o.platform), 173);
  d.set(decodeBase58(o.mint ?? MINT), 205);
  d.set(decodeBase58(o.quote ?? SOL_MINT), 237);
  return d;
}
function dbc(o: { mint?: string; config?: string; creator?: string; migrated?: boolean }) {
  const d = new Uint8Array(424);
  d.set(DBC_DISC, 0);
  d.set(decodeBase58(o.config ?? SOME_CONFIG), 72);
  d.set(decodeBase58(o.creator ?? SOMEONE), 104);
  d.set(decodeBase58(o.mint ?? MINT), 136);
  put(d, 280, 1n << 40n);
  d[305] = o.migrated ? 1 : 0;
  return d;
}

/** A pretend Solana node: accounts by key, program-account lookups by (program, offset, mint). */
function node(accounts: Record<string, { owner: string; data: Uint8Array | string }>, lookups: Record<string, string[]> = {}, over: { raw?: (method: string) => unknown } = {}) {
  const asked: { method: string; params: any; redirect?: string }[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    const { method, params } = JSON.parse(init.body);
    asked.push({ method, params, redirect: init.redirect });
    const raw = over.raw?.(method);
    if (raw !== undefined) return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (method === 'getMultipleAccounts') {
      const value = params[0].map((k: string) => {
        const a = accounts[k];
        return a ? { owner: a.owner, data: [typeof a.data === 'string' ? a.data : b64(a.data), 'base64'] } : null;
      });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }));
    }
    if (method === 'getProgramAccounts') {
      const f = params[1].filters.find((x: any) => x.memcmp).memcmp;
      const keys = lookups[`${params[0]}|${f.offset}|${f.bytes}`] ?? [];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: keys.map((pubkey) => ({ pubkey, account: { data: ['', 'base64'] } })) }));
    }
    return new Response('{}');
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, asked };
}

describe('Solana launchpads: the chain decides', () => {
  it('a pump.fun curve: badge, and the curve as its pool while it trades', async () => {
    const { fetchImpl } = node({ [curvePda(MINT)]: { owner: PROGRAMS.pumpfun, data: pumpCurve() } });
    expect(await classifySolana(MINT, URL_, fetchImpl)).toEqual({
      definitive: true,
      info: { launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${MINT}`, network: 'solana', dex: 'pump.fun', pairAddress: curvePda(MINT) },
    });
    const done = node({ [curvePda(MINT)]: { owner: PROGRAMS.pumpfun, data: pumpCurve({ complete: true }) } });
    expect((await classifySolana(MINT, URL_, done.fetchImpl)).info).toEqual({ launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${MINT}`, network: 'solana', dex: 'pump.fun', launchpadNote: 'graduated' });
  });

  it('a LaunchLab pool under a BONK.fun platform config is BONK.fun, suffix or not, SOL or USD1', async () => {
    const sol = node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM }) } });
    expect((await classifySolana(MINT, URL_, sol.fetchImpl)).info).toEqual({
      launchpad: 'letsbonk',
      launchpadUrl: `https://letsbonk.fun/token/${MINT}`,
      network: 'solana',
      launchpadNote: 'bonding · 25.0%',
      pairAddress: llPda(MINT, SOL_MINT),
      dex: 'raydium-launchlab',
      quoteSymbol: 'SOL',
      quoteAddress: SOL_MINT,
    });
    const usd1 = node({ [llPda(MINT, USD1_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM, quote: USD1_MINT }) } });
    expect((await classifySolana(MINT, URL_, usd1.fetchImpl)).info).toMatchObject({ launchpad: 'letsbonk', quoteSymbol: 'USD1', pairAddress: llPda(MINT, USD1_MINT) });
    const grad = node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM, status: 2 }) } });
    expect((await classifySolana(MINT, URL_, grad.fetchImpl)).info).toEqual({ launchpad: 'letsbonk', launchpadUrl: `https://letsbonk.fun/token/${MINT}`, network: 'solana', launchpadNote: 'graduated' });
  });

  it('StonkFun in a tokenized-stock quote is found by mint; its quote is left for the pricer to price by address', async () => {
    const { fetchImpl } = node({ [POOL_A]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: STONK_PLATFORM, quote: XSTOCK }) } }, { [`${PROGRAMS.raydiumLaunchlab}|205|${MINT}`]: [POOL_A] });
    const v = await classifySolana(MINT, URL_, fetchImpl);
    expect(v.info).toMatchObject({ launchpad: 'stonkfun', launchpadUrl: `https://www.stonkfun.xyz/token/${MINT}`, pairAddress: POOL_A, quoteAddress: XSTOCK });
    expect(v.info?.quoteSymbol).toBeUndefined();
  });

  it('a platform that only calls itself StonkFun is plain LaunchLab: brands come from exact keys', async () => {
    expect(LAUNCHLAB_PLATFORMS[IMPOSTOR_PLATFORM]).toBeUndefined();
    const { fetchImpl } = node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: IMPOSTOR_PLATFORM }) } });
    expect((await classifySolana(MINT, URL_, fetchImpl)).info).toMatchObject({ launchpad: 'launchlab', launchpadUrl: `https://raydium.io/launchpad/token/?mint=${MINT}` });
  });

  it('Meteora DBC: Bags by the signing creator, Moonshot by its config, anything else plain DBC; a migrated pool is no pool', async () => {
    const lookup = { [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: [POOL_D] };
    const bags = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ creator: BAGS }) } }, lookup);
    expect((await classifySolana(MINT, URL_, bags.fetchImpl)).info).toEqual({ launchpad: 'bags', launchpadUrl: `https://bags.fm/${MINT}`, network: 'solana', launchpadNote: 'bonding', pairAddress: POOL_D, dex: 'meteora-dbc' });
    const moon = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ config: MOONSHOT }) } }, lookup);
    expect((await classifySolana(MINT, URL_, moon.fetchImpl)).info).toMatchObject({ launchpad: 'moonshot', launchpadUrl: `https://jup.ag/tokens/${MINT}` });
    const plain = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ migrated: true }) } }, lookup);
    expect((await classifySolana(MINT, URL_, plain.fetchImpl)).info).toEqual({ launchpad: 'dbc', launchpadUrl: `https://jup.ag/tokens/${MINT}`, network: 'solana', launchpadNote: 'graduated' });
  });

  it('a pool for another mint, a pool owned by another program, or the wrong size is not this token', async () => {
    const lookup = { [`${PROGRAMS.raydiumLaunchlab}|205|${MINT}`]: [POOL_A], [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: [POOL_D] };
    const other = node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM, mint: OTHER }) }, [POOL_A]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM, mint: OTHER }) }, [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ mint: OTHER, creator: BAGS }) } }, lookup);
    expect(await classifySolana(MINT, URL_, other.fetchImpl)).toEqual({ definitive: true });
    const wrongOwner = node({ [curvePda(MINT)]: { owner: SOMEONE, data: pumpCurve() }, [POOL_D]: { owner: PROGRAMS.raydiumLaunchlab, data: dbc({ creator: BAGS }) } }, lookup);
    expect(await classifySolana(MINT, URL_, wrongOwner.fetchImpl)).toEqual({ definitive: true });
    const short = node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: launchLab({ platform: BONK_PLATFORM }).subarray(0, 300) } });
    expect(await classifySolana(MINT, URL_, short.fetchImpl)).toEqual({ definitive: true });
  });

  it('a node that answers badly cannot decide anything', async () => {
    const tooBig = node({}, {}, { raw: () => ({ jsonrpc: '2.0', id: 1, result: { value: [{ owner: SOMEONE, data: ['A'.repeat(300_000), 'base64'] }] } }) });
    expect(await classifySolana(MINT, URL_, tooBig.fetchImpl)).toEqual({ definitive: false });
    const misaligned = node({}, {}, { raw: (m) => (m === 'getMultipleAccounts' ? { jsonrpc: '2.0', id: 1, result: { value: [null] } } : undefined) });
    expect(await classifySolana(MINT, URL_, misaligned.fetchImpl)).toEqual({ definitive: false });
    const error = node({}, {}, { raw: () => ({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'rate limited' } }) });
    expect(await classifySolana(MINT, URL_, error.fetchImpl)).toEqual({ definitive: false });
    const notJson = node({}, {}, { raw: () => '<html>' });
    expect(await classifySolana(MINT, URL_, notJson.fetchImpl)).toEqual({ definitive: false });
    // junk keys from a lookup are dropped, and non-base64 account data is ignored
    const junk = node({ [curvePda(MINT)]: { owner: PROGRAMS.pumpfun, data: '!!not base64!!' } }, { [`${PROGRAMS.raydiumLaunchlab}|205|${MINT}`]: ['javascript:alert(1)', '../../x'] });
    expect(await classifySolana(MINT, URL_, junk.fetchImpl)).toEqual({ definitive: true });
  });

  it('an account of another type in the same program is never read as a pool (discriminator)', async () => {
    const lookup = { [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: [POOL_D] };
    const forged = dbc({ creator: BAGS });
    forged.set(Buffer.from('0102030405060708', 'hex'), 0);
    expect(await classifySolana(MINT, URL_, node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: forged } }, lookup).fetchImpl)).toEqual({ definitive: true });
    const ll = launchLab({ platform: BONK_PLATFORM });
    ll.set(DBC_DISC, 0);
    expect(await classifySolana(MINT, URL_, node({ [llPda(MINT, SOL_MINT)]: { owner: PROGRAMS.raydiumLaunchlab, data: ll } }).fetchImpl)).toEqual({ definitive: true });
  });

  it('a pool under a public brand config is badged for that config, whoever created it (documented: config, not app)', async () => {
    const lookup = { [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: [POOL_D] };
    const { fetchImpl } = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ config: MOONSHOT, creator: SOMEONE }) } }, lookup);
    expect((await classifySolana(MINT, URL_, fetchImpl)).info?.launchpad).toBe('moonshot');
    // Bags is different: only the creator Bags signs with makes a Bags badge, its config alone does not
    const notBags = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ config: SOME_CONFIG, creator: SOMEONE }) } }, lookup);
    expect((await classifySolana(MINT, URL_, notBags.fetchImpl)).info?.launchpad).toBe('dbc');
  });

  it('remembers where it found a mint (re-reading only that pool) and that a mint has none; a failed lookup is not remembered', async () => {
    const cache = memoryCache();
    const lookup = { [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: [POOL_D] };
    const n1 = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ creator: BAGS }) } }, lookup);
    expect((await classifySolana(MINT, URL_, n1.fetchImpl, cache)).info?.launchpad).toBe('bags');
    const n2 = node({ [POOL_D]: { owner: PROGRAMS.meteoraDbc, data: dbc({ creator: BAGS, migrated: true }) } }, lookup);
    expect((await classifySolana(MINT, URL_, n2.fetchImpl, cache)).info).toMatchObject({ launchpad: 'bags', launchpadNote: 'graduated' });
    expect(n2.asked.map((a) => a.method)).toEqual(['getMultipleAccounts']);
    const none = node({});
    expect(await classifySolana(OTHER, URL_, none.fetchImpl, cache)).toEqual({ definitive: true });
    const again = node({});
    expect(await classifySolana(OTHER, URL_, again.fetchImpl, cache)).toEqual({ definitive: true });
    expect(again.asked).toEqual([]);
    const busy = node({}, {}, { raw: () => ({ jsonrpc: '2.0', id: 1, error: { code: 429 } }) });
    expect(await classifySolana(XSTOCK, URL_, busy.fetchImpl, cache)).toEqual({ definitive: false });
    expect(cache.get(XSTOCK)).toBeUndefined();
  });

  it('refuses a streamed answer past its cap, a non-200, a lookup that is not a list, and reads at most four keys', async () => {
    const stream = (async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 30; i++) c.enqueue(new Uint8Array(10_000).fill(32)); c.close(); } }))) as unknown as typeof fetch;
    expect(await classifySolana(MINT, URL_, stream)).toEqual({ definitive: false });
    const status = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    expect(await classifySolana(MINT, URL_, status)).toEqual({ definitive: false });
    const notList = node({}, {}, { raw: (m) => (m === 'getProgramAccounts' ? { jsonrpc: '2.0', id: 1, result: { pubkey: POOL_D } } : undefined) });
    expect(await classifySolana(MINT, URL_, notList.fetchImpl)).toEqual({ definitive: false });
    const many = Array.from({ length: 50 }, (_, i) => findProgramAddress([utf8('x' + i)], PROGRAMS.meteoraDbc).address);
    const lots = node({}, { [`${PROGRAMS.meteoraDbc}|136|${MINT}`]: many });
    await classifySolana(MINT, URL_, lots.fetchImpl);
    const reads = lots.asked.filter((a) => a.method === 'getMultipleAccounts').map((a) => a.params[0].length);
    expect(Math.max(...reads)).toBeLessThanOrEqual(4);
  });

  it('asks nothing about a string that is not a mint, refuses redirects', async () => {
    const { fetchImpl, asked } = node({});
    expect(await classifySolana('not a mint/../', URL_, fetchImpl)).toEqual({ definitive: false });
    expect(await classifySolana(MINT, undefined, fetchImpl)).toEqual({ definitive: false });
    expect(asked).toEqual([]);
    await classifySolana(MINT, URL_, fetchImpl);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.redirect === 'error')).toBe(true);
  });
});

describe('classifier on Solana', () => {
  const PUMPISH = 'Gy2XXE5mLZVfUYDbhy2XmqtsW4HDgpE2gWyA3Rmkpump';
  it('a "…pump" mint the chain places elsewhere (or nowhere) is not pump.fun, and pump.fun is not even asked', async () => {
    const pumpfun = vi.fn(async () => ({ launchpad: 'pumpfun' as const, launchpadUrl: 'u' }));
    const dbcHit = createLaunchpadClassifier({ solana: async () => ({ definitive: true, info: { launchpad: 'dbc' as const, launchpadUrl: 'j' } }), pumpfun, log: () => {} });
    expect((await dbcHit(PUMPISH, 'sol'))?.launchpad).toBe('dbc');
    const none = createLaunchpadClassifier({ solana: async () => ({ definitive: true }), pumpfun, log: () => {} });
    expect(await none(PUMPISH, 'sol')).toBeNull(); // null: clear any badge it had
    expect(pumpfun).not.toHaveBeenCalled();
  });

  it('a busy node: only pump.fun itself can still claim a mint; a "…bonk" suffix alone claims nothing', async () => {
    const busy = async () => ({ definitive: false });
    expect(await createLaunchpadClassifier({ solana: busy, pumpfun: async () => undefined, log: () => {} })(PUMPISH, 'sol')).toBeUndefined();
    expect((await createLaunchpadClassifier({ solana: busy, pumpfun: async () => ({ launchpad: 'pumpfun' as const, launchpadUrl: 'u', symbol: 'X' }), log: () => {} })(PUMPISH, 'sol'))?.symbol).toBe('X');
    expect(await createLaunchpadClassifier({ solana: busy, log: () => {} })('6y5Dueo81DeTdXhBDd1LyCdgeJvEwCFHzysu6HY4bonk', 'sol')).toBeUndefined();
  });

  it("pump.fun's record fills in; the chain's badge, note and pool stand, and a finished curve is no pool", async () => {
    const api = { launchpad: 'pumpfun' as const, launchpadUrl: 'https://pump.fun/coin/x', name: 'Fix', marketCap: 5, pairAddress: 'OldCurve' };
    const live = createLaunchpadClassifier({ solana: async () => ({ definitive: true, info: { launchpad: 'pumpfun' as const, launchpadUrl: 'https://pump.fun/coin/x', pairAddress: 'Curve1', quoteSymbol: 'USDC' } }), pumpfun: async () => api, log: () => {} });
    expect(await live(PUMPISH, 'sol')).toMatchObject({ name: 'Fix', marketCap: 5, pairAddress: 'Curve1', quoteSymbol: 'USDC' });
    const done = createLaunchpadClassifier({ solana: async () => ({ definitive: true, info: { launchpad: 'pumpfun' as const, launchpadUrl: 'https://pump.fun/coin/x', launchpadNote: 'graduated' } }), pumpfun: async () => api, log: () => {} });
    const out = await done(PUMPISH, 'sol');
    expect(out).toMatchObject({ name: 'Fix', launchpadNote: 'graduated' });
    expect(out?.pairAddress).toBeUndefined();
  });
});
