import { encodeAbiParameters, keccak256 } from 'viem';
import { QUOTES } from './onchain/discover.js';
import { applyCreatorFields, decodeGeniusTokenInfo, decodePonsV1Launch, decodeStrings, fetchIpfsJson, readCapped, rpcUrl, type LaunchpadInfo } from './launchpads.js';

/**
 * EVM launchpads read off the chain like the others in launchpads.ts: each one's own contract must
 * name the token (a token answering the same calls proves nothing), every address below is hardcoded
 * after checking it on-chain (2026-09-28), and nothing from any launchpad's site is loaded except the
 * creator's metadata JSON, and that only from a fixed host (Nad.fun's storage) or through our IPFS
 * gateways (UBI.fun), then through applyCreatorFields like every creator field.
 */

const TIMEOUT_MS = 7000;
const RPC_MAX_BYTES = 256_000;
const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const pad = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
const str = (h: string | undefined) => (h ? decodeStrings(h, 1)?.[0] : undefined);
/** the address in a return word, only when the word is a clean address */
const addrWord = (h: string | undefined, i = 0): string | undefined => {
  const w = h && h.length >= 2 + (i + 1) * 64 ? h.slice(2 + i * 64, 2 + (i + 1) * 64) : undefined;
  return w && /^0{24}/.test(w) ? '0x' + w.slice(24).toLowerCase() : undefined;
};
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', tokenURI: '0x3c130d90', launchFactory: '0x536dac9b', getLaunchedToken: '0x3cf28b5a', getTokenInfo: '0xabb1dc44', liquidityPool: '0x665a11ca' };

/** Several eth_calls in one request; each answer hex no bigger than a call could return, or undefined. No redirects. */
async function calls(rpc: string, list: { to: string; data: string }[], fetchImpl: typeof fetch): Promise<(string | undefined)[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpc, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(list.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [c, 'latest'] }))) });
    if (!res.ok) return list.map(() => undefined);
    const text = await readCapped(res, RPC_MAX_BYTES);
    const json = text === undefined ? undefined : JSON.parse(text);
    if (!Array.isArray(json)) return list.map(() => undefined);
    return list.map((_, id) => {
      const r = json.find((x: any) => Number(x?.id) === id)?.result;
      return typeof r === 'string' && r.length > 2 && r.length <= 131_072 && HEX.test(r) ? r : undefined;
    });
  } catch {
    return list.map(() => undefined);
  } finally {
    clearTimeout(t);
  }
}

// ---------- NOXA Fun (Robinhood, MegaETH, Monad, Arc): Pons V1's contracts, NOXA's own factories ----------

/**
 * NOXA runs the Pons V1 contract stack (docs.noxa.fi/contracts/noxa-fun), so a NOXA token answers
 * the Pons calls too. The token's launchFactory() says which factory to ask (only a hint: the token
 * wrote it), and that factory's record must name the token. Robinhood's current factory is not in
 * NOXA's docs; its launches name it and its record names them. Monad and Arc: factory code and
 * locker checked, no launch found to test against.
 */
export const NOXA_FACTORIES: { network: string; factory: string }[] = [
  { network: 'robinhood', factory: '0xdd84fddea1206115b37dbbc0ba5721530e1ba9c5' },
  { network: 'robinhood', factory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB' },
  { network: 'megaeth', factory: '0xAc303930F2f7A78BBB037f3f4622Bd02f5545B9a' },
  { network: 'monad', factory: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85' },
  { network: 'arc', factory: '0xE7d4E64079FE467A21801B36Ccc6D9B3F66BD372' },
];

/** NOXA's getTokenInfo is the Genius layout wrapped in one more tuple; socials are (telegram, twitter, discord, website, farcaster). */
export function decodeNoxaTokenInfo(hex: string): { logo: string; telegram: string; twitter: string; website: string } | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 5 || data.length > 65_536 || BigInt('0x' + data.slice(0, 64)) !== 32n) return undefined;
  const info = decodeGeniusTokenInfo('0x' + data.slice(64));
  if (!info) return undefined;
  const [telegram, twitter, , website] = info.socials;
  return { logo: info.logo, telegram, twitter, website };
}

export async function fetchNoxa(address: string, fetchImpl: typeof fetch = fetch, network?: string, factories = NOXA_FACTORIES): Promise<LaunchpadInfo | undefined> {
  if (!ADDRESS.test(address)) return undefined;
  const a = address.toLowerCase();
  const networks = [...new Set(factories.map((f) => f.network))].filter((n) => !network || n === network);
  const found = await Promise.all(
    networks.map(async (n) => {
      const rpc = rpcUrl(n);
      if (!rpc) return undefined;
      const [lf] = await calls(rpc, [{ to: address, data: SEL.launchFactory }], fetchImpl);
      const claimed = addrWord(lf);
      const factory = factories.find((f) => f.network === n && f.factory.toLowerCase() === claimed);
      if (!factory) return undefined;
      const [rec] = await calls(rpc, [{ to: factory.factory, data: SEL.getLaunchedToken + pad(a) }], fetchImpl);
      const launch = rec ? decodePonsV1Launch(rec) : undefined;
      // the record's paired token (word 2): what the pool must be quoted in
      return launch && launch.token === a ? { network: n, rpc, paired: addrWord(rec, 2) } : undefined;
    }),
  );
  const hit = found.find(Boolean);
  if (!hit) return undefined;
  const [info, name, symbol, pool] = await calls(hit.rpc, [SEL.getTokenInfo, SEL.name, SEL.symbol, SEL.liquidityPool].map((data) => ({ to: address, data })), fetchImpl);
  const out: LaunchpadInfo = { launchpad: 'noxa', launchpadUrl: hit.network === 'robinhood' ? `https://fun.noxa.fi/token/${a}` : 'https://fun.noxa.fi', network: hit.network };
  const meta = info ? decodeNoxaTokenInfo(info) : undefined;
  applyCreatorFields(out, { name: str(name), symbol: str(symbol), image: meta?.logo, telegram: meta?.telegram, twitter: meta?.twitter, website: meta?.website });
  // no curve: the token trades in its Uniswap v3-style pool from the first block. The pool is only used when the
  // factory's record pairs the token with a quote asset we know by address (WETH, USDC…), and the pool holds exactly
  // those two: a token paired with a look-alike "USDC" of its own is never priced off that pool
  const p = addrWord(pool);
  const known = hit.paired && QUOTES[hit.network]?.some((q) => q.address === hit.paired);
  if (p && !/^0x0{40}$/.test(p) && known) {
    const [t0, t1] = await calls(hit.rpc, [{ to: p, data: '0x0dfe1681' }, { to: p, data: '0xd21220a7' }], fetchImpl);
    const pair = [addrWord(t0), addrWord(t1)].sort().join();
    if (pair === [a, hit.paired].sort().join()) {
      out.pairAddress = p;
      out.dex = 'uniswap';
    }
  }
  return out;
}

// ---------- Nad.fun (Monad): its bonding curve contracts' records ----------

/** Nad.fun V2 BondingCurve (an upgradeable proxy) and V1 BondingCurve, from DefiLlama's adapter, each checked with real launches. */
export const NADFUN = { v2: '0x9f3832732923252A21044F21eE6bd87F09514ae4', v1: '0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE' };
const NAD_SEL = { getCurve: '0x61f029fb', curves: '0x2cc3dc6e', isGraduated: '0x68a4c8b7' };
/** Nad.fun only mints vanity addresses ending in 7777; nothing else is asked about. */
export const nadfunCandidate = (address: string) => ADDRESS.test(address) && address.toLowerCase().endsWith('7777');
/** the metadata JSON lives on Nad.fun's own storage; a tokenURI pointing anywhere else is never fetched */
const NAD_METADATA = /^https:\/\/storage\.nadapp\.net\/metadata\/[0-9a-f-]{36}\.json$/;

export async function fetchNadfun(address: string, fetchImpl: typeof fetch = fetch, network?: string): Promise<LaunchpadInfo | undefined> {
  if (!nadfunCandidate(address) || (network && network !== 'monad')) return undefined;
  const rpc = rpcUrl('monad');
  if (!rpc) return undefined;
  const a = address.toLowerCase();
  const [v2, v1, v1grad, uri, name, symbol] = await calls(
    rpc,
    [
      { to: NADFUN.v2, data: NAD_SEL.getCurve + pad(a) },
      { to: NADFUN.v1, data: NAD_SEL.curves + pad(a) },
      { to: NADFUN.v1, data: NAD_SEL.isGraduated + pad(a) },
      { to: address, data: SEL.tokenURI },
      { to: address, data: SEL.name },
      { to: address, data: SEL.symbol },
    ],
    fetchImpl,
  );
  const out: LaunchpadInfo = { launchpad: 'nadfun', launchpadUrl: `https://nad.fun/tokens/${a}`, network: 'monad' };
  if (v2 && v2.length >= 2 + 16 * 64 && addrWord(v2, 0) === a) {
    // V2 record: (token, creator, quoteToken, …, graduated at word 10, …, pair at word 14)
    const graduated = BigInt('0x' + v2.slice(2 + 10 * 64, 2 + 11 * 64)) === 1n;
    out.launchpadNote = graduated ? 'graduated' : 'bonding';
    const pair = addrWord(v2, 14);
    if (graduated && pair && !/^0x0{40}$/.test(pair)) {
      out.pairAddress = pair;
      out.dex = 'nadfun';
    }
  } else if (v1 && v1.length >= 2 + 8 * 64 && /[1-9a-fA-F]/.test(v1.slice(2, 2 + 8 * 64))) {
    // V1 keeps a curve per token; one that was never created is all zeros
    out.launchpadNote = v1grad && /^0x0*1$/.test(v1grad) ? 'graduated' : 'bonding';
  } else return undefined;
  const u = str(uri)?.trim();
  const meta = u && NAD_METADATA.test(u) ? await getCappedJson(u, fetchImpl) : undefined;
  applyCreatorFields(out, {
    name: str(name),
    symbol: str(symbol),
    // an image is shown only when the metadata says plainly it is not NSFW (a "true", a 1, anything else hides it)
    image: meta && (meta.is_nsfw === false || meta.is_nsfw === undefined) ? meta.image_uri : undefined,
    website: meta?.website,
    twitter: meta?.twitter,
    telegram: meta?.telegram,
  });
  return out;
}

async function getCappedJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const text = await readCapped(res, 64_000);
    const json = text === undefined ? undefined : JSON.parse(text);
    return json && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

// ---------- UBI.fun (Arc): a Flaunch fork, Uniswap v4 from the first block ----------

/**
 * UBI.fun's Flaunch (the ERC-721 that mints one NFT per launch) and its PositionManager (the v4 hook).
 * Found from a swap on Arc, checked 2026-09-28: tokenId(token) is the launch's NFT id (0 for anything
 * else), the token names this Flaunch, and poolKey(token) is its v4 pool against USDC.
 */
export const UBIFUN = { flaunch: '0x93e5a7565008db9688ba5211fa552d8b108b9c75', positionManager: '0xc780c0f4aac690908854d351b8bfda2812daefdc' };
const UBI_SEL = { tokenId: '0x7ca31724', flaunch: '0x87211ceb', poolKey: '0x55d1cb60' };
const ARC_USDC = '0x3600000000000000000000000000000000000000';

/** poolKey(token) → (currency0, currency1, uint24 fee, int24 tickSpacing, hooks) and the v4 pool id it hashes to. */
export function ubiPool(hex: string, token: string): { poolId: string; quote: string } | undefined {
  if (hex.length < 2 + 5 * 64) return undefined;
  const c0 = addrWord(hex, 0), c1 = addrWord(hex, 1), hooks = addrWord(hex, 4);
  const fee = BigInt('0x' + hex.slice(2 + 2 * 64, 2 + 3 * 64));
  const tsWord = BigInt('0x' + hex.slice(2 + 3 * 64, 2 + 4 * 64));
  // the key comes from UBI.fun's own PositionManager, which is also the pool's hook; anything else is not its pool
  if (!c0 || !c1 || hooks !== UBIFUN.positionManager || fee >= 1n << 24n) return undefined;
  const t = token.toLowerCase();
  if (c0 !== t && c1 !== t) return undefined;
  // int24 sign-extended to a word; a tickSpacing is small and positive
  if (tsWord === 0n || tsWord > 32767n) return undefined;
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [c0 as `0x${string}`, c1 as `0x${string}`, Number(fee), Number(tsWord), hooks as `0x${string}`],
    ),
  );
  return { poolId, quote: c0 === t ? c1 : c0 };
}

export async function fetchUbifun(address: string, fetchImpl: typeof fetch = fetch, network?: string): Promise<LaunchpadInfo | undefined> {
  if (!ADDRESS.test(address) || (network && network !== 'arc')) return undefined;
  const rpc = rpcUrl('arc');
  if (!rpc) return undefined;
  const a = address.toLowerCase();
  const [id, flaunch, key, uri, name, symbol] = await calls(
    rpc,
    [
      { to: UBIFUN.flaunch, data: UBI_SEL.tokenId + pad(a) },
      { to: address, data: UBI_SEL.flaunch },
      { to: UBIFUN.positionManager, data: UBI_SEL.poolKey + pad(a) },
      { to: address, data: SEL.tokenURI },
      { to: address, data: SEL.name },
      { to: address, data: SEL.symbol },
    ],
    fetchImpl,
  );
  // the launch NFT must exist for this token, and the token must name this Flaunch
  if (!id || id.length !== 66 || /^0x0+$/.test(id) || addrWord(flaunch) !== UBIFUN.flaunch) return undefined;
  const out: LaunchpadInfo = { launchpad: 'ubifun', launchpadUrl: `https://ubi.fun/markets/${a}`, network: 'arc' };
  const pool = key ? ubiPool(key, a) : undefined;
  if (pool) {
    out.pairAddress = pool.poolId;
    out.quoteAddress = pool.quote;
    if (pool.quote === ARC_USDC) out.quoteSymbol = 'USDC';
    out.dex = 'uniswap';
  }
  const u = str(uri)?.trim();
  // only an IPFS tokenURI is read, through our own gateways, whatever host it names
  const meta = u && /^ipfs:\/\//i.test(u) ? await fetchIpfsJson(u, fetchImpl) : undefined;
  applyCreatorFields(out, { name: str(name), symbol: str(symbol), image: meta?.image, website: meta?.website, twitter: meta?.twitter, telegram: meta?.telegram });
  return out;
}
