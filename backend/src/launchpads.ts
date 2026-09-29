import type { Chain, TokenInfo } from './types.js';
import { imageLink, webLink } from './weblink.js';
import { CHAINS } from './onchain/chains.js';
import { isStable, knownQuote, nativeRef } from './onchain/quotes.js';

/**
 * Launchpad classification, ported from frogr's per-launchpad probes.
 * Each probe answers "is this token yours?" independently and returns what it
 * knows (image, socials, name). Results fill gaps in the chart-site data, and
 * the launchpad itself becomes a badge on the card.
 */

export type Launchpad = 'pumpfun' | 'letsbonk' | 'bankr' | 'stonks' | 'pons' | 'genius' | 'loong' | 'o1' | 'virtuals' | 'flap' | 'clanker' | 'long' | 'argus' | 'warp' | 'peach' | 'dyor' | 'synthra';

export interface LaunchpadInfo extends Partial<TokenInfo> {
  launchpad: Launchpad;
  launchpadUrl: string;
}

const TIMEOUT_MS = 7000;
/** No launchpad answer we read is anywhere near this; a bigger one is not what we asked for. */
const JSON_MAX_BYTES = 2_000_000;

/**
 * A response body as text, refused once it passes `max` bytes: a launchpad's API, an IPFS gateway and
 * a node are all servers we do not run, and none gets to make us buffer whatever it likes.
 */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = res.body?.getReader?.();
  if (!reader) {
    // test doubles without a stream: the same cap, after the fact
    const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    return text.length > max ? undefined : text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url: string, fetchImpl: typeof fetch, headers: Record<string, string> = {}, max = JSON_MAX_BYTES): Promise<any | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // a redirect could send us anywhere, the app's own local API included: none of these hosts needs one
    const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'error', headers: { accept: 'application/json', ...headers } });
    if (!res.ok) return undefined;
    const text = await readCapped(res, max);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  } finally {
    clearTimeout(t);
  }
}

export function ipfsToHttp(uri: string | undefined | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (/^https?:\/\//i.test(s)) {
    // public gateway URL → our proxy (ipfs.io 403s randomly)
    const g = /^https?:\/\/[^/]+\/ipfs\/([A-Za-z0-9]+)(\/[^?#]*)?/i.exec(s);
    if (g) return `/api/ipfs/${g[1]}${g[2] ?? ''}`;
    const sub = /^https?:\/\/([A-Za-z0-9]{40,})\.ipfs\.[^/]+(\/[^?#]*)?/i.exec(s);
    if (sub) return `/api/ipfs/${sub[1]}${sub[2] ?? ''}`;
    return s;
  }
  const m = /^(?:ipfs:\/\/|ipfs\/)?(?:ipfs\/)?([A-Za-z0-9]+)(\/.*)?$/.exec(s);
  if (!m) return undefined;
  // served by our own gateway-hopping proxy (see ipfs.ts) — never a single flaky gateway
  return `/api/ipfs/${m[1]}${m[2] ?? ''}`;
}

/**
 * Which node answers for a chain when a probe reads it: the app's endpoints (the user's own RPC, then
 * Alchemy) once index.ts wires them, the public one from the chain table until then and in tests.
 */
let rpcFor: (network: string) => string | undefined = (n) => CHAINS[n]?.rpc;
export function setLaunchpadRpc(fn: (network: string) => string | undefined): void {
  rpcFor = (n) => fn(n) ?? CHAINS[n]?.rpc;
}
export const rpcUrl = (network: string): string | undefined => rpcFor(network);

/** A web link whose host is one of `hosts` (or a subdomain of one); anything else is not that kind of link. */
function linkOn(v: string, hosts: string[]): string | undefined {
  const ok = webLink(v);
  if (!ok) return undefined;
  const host = new URL(ok).hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith('.' + h)) ? ok : undefined;
}

/** An X profile or post: a handle, or a link that really is on x.com / twitter.com. A "twitter" that points anywhere else is dropped. */
export function xUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  // "x.com/name" or "twitter.com/name" typed without the scheme
  if (/^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(s)) return linkOn(`https://${s}`, ['x.com', 'twitter.com']);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return linkOn(s, ['x.com', 'twitter.com']);
  const bare = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? `https://x.com/${bare}` : undefined;
}

/** A Telegram link: a handle, or a link that really is on t.me / telegram.me. */
export function tgUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  // "t.me/name" typed without the scheme
  if (/^(?:t|telegram)\.me\//i.test(s)) return linkOn(`https://${s}`, ['t.me', 'telegram.me']);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return linkOn(s, ['t.me', 'telegram.me']);
  const bare = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{3,32}$/.test(bare) ? `https://t.me/${bare}` : undefined;
}

/** What a coin's creator wrote about it, from wherever a launchpad keeps it. Every field is untrusted. */
export interface CreatorFields {
  name?: unknown;
  symbol?: unknown;
  image?: unknown;
  website?: unknown;
  twitter?: unknown;
  telegram?: unknown;
}

/**
 * The one door creator-written metadata goes through: names and tickers cleaned and capped, the image
 * only as our IPFS proxy path or a web address, the website only as http(s), socials only on their own
 * hosts. A field that fails its check is left out, never passed through as it came.
 */
export function applyCreatorFields(out: Partial<TokenInfo>, f: CreatorFields): void {
  const name = cleanLabel(typeof f.name === 'string' ? f.name : undefined, 64);
  if (name) out.name = name;
  const symbol = cleanLabel(typeof f.symbol === 'string' ? f.symbol : undefined, 16);
  if (symbol) out.symbol = symbol;
  const img = imageLink(typeof f.image === 'string' ? ipfsToHttp(f.image) : undefined);
  if (img) out.imageUrl = img;
  const site = webLink(f.website);
  if (site) out.website = site;
  const x = xUrl(f.twitter);
  if (x) out.twitter = x;
  const tg = tgUrl(f.telegram);
  if (tg) out.telegram = tg;
}

/** An IPFS content id (and path) from `ipfs://…`, a bare CID or a gateway URL; undefined for anything else. */
export function ipfsCid(uri: unknown): { cid: string; path: string } | undefined {
  if (typeof uri !== 'string') return undefined;
  const s = uri.trim();
  const m =
    /^https:\/\/[^/?#]+\/ipfs\/([A-Za-z0-9]+)((?:\/[A-Za-z0-9._~-]+)*)\/?$/i.exec(s) ??
    /^https:\/\/([A-Za-z0-9]{40,})\.ipfs\.[^/?#]+((?:\/[A-Za-z0-9._~-]+)*)\/?$/i.exec(s) ??
    /^(?:ipfs:\/\/)?(?:ipfs\/)?([A-Za-z0-9]+)((?:\/[A-Za-z0-9._~-]+)*)$/.exec(s);
  if (!m || m[1].length < 32 || m[1].length > 128) return undefined;
  if (m[2].split('/').some((seg) => seg === '.' || seg === '..')) return undefined;
  return { cid: m[1], path: m[2] };
}

/** Gateways that serve IPFS JSON as of 2026-09-28 (ipfs.io and dweb.link now answer every request with a notice). */
export const IPFS_JSON_GATEWAYS = ['https://gateway.pinata.cloud/ipfs/'];
const IPFS_JSON_MAX_BYTES = 64_000;

/** A creator's metadata JSON off IPFS: an object or nothing, never more than a small, fixed size. */
export async function fetchIpfsJson(uri: unknown, fetchImpl: typeof fetch, gateways = IPFS_JSON_GATEWAYS): Promise<Record<string, unknown> | undefined> {
  const id = ipfsCid(uri);
  if (!id) return undefined;
  for (const gw of gateways) {
    const json = await getJson(gw + id.cid + id.path, fetchImpl, {}, IPFS_JSON_MAX_BYTES).catch(() => undefined);
    if (json && typeof json === 'object' && !Array.isArray(json)) return json;
  }
  return undefined;
}

// ---------- Solana launchpads: the mint address says it all ----------

export function classifyBySuffix(address: string, chain: Chain): LaunchpadInfo | undefined {
  if (chain !== 'sol') return undefined;
  if (address.endsWith('pump')) return { launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${address}` };
  if (address.endsWith('bonk')) return { launchpad: 'letsbonk', launchpadUrl: `https://letsbonk.fun/token/${address}` };
  return undefined;
}

// ---------- pump.fun (Solana): frontend API, works before any DEX pair ----------

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * pump.fun's record for a mint. It must be the record for the mint asked about. The quote is not set
 * here: a curve can be raised in SOL or USDC, and the curve account itself says which (see onchain/solana.ts).
 */
export function mapPumpfun(c: any, mint?: string): LaunchpadInfo | undefined {
  if (!c || typeof c.mint !== 'string' || !SOLANA_ADDRESS.test(c.mint)) return undefined;
  if (mint !== undefined && c.mint !== mint) return undefined;
  const out: LaunchpadInfo = { launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${c.mint}`, network: 'solana', dex: 'pump.fun' };
  applyCreatorFields(out, { name: c.name, symbol: c.symbol, image: c.image_uri, website: c.website, twitter: c.twitter, telegram: c.telegram });
  const mc = Number(c.usd_market_cap);
  if (Number.isFinite(mc) && mc > 0) out.marketCap = mc;
  // the bonding curve account is the "pool" while the token is on the curve: it is what the live pricer reads
  if (typeof c.bonding_curve === 'string' && SOLANA_ADDRESS.test(c.bonding_curve)) out.pairAddress = c.bonding_curve;
  const created = Number(c.created_timestamp);
  if (Number.isFinite(created) && created > 0) out.pairCreatedAt = created;
  return out;
}

export async function fetchPumpfun(mint: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  if (!SOLANA_ADDRESS.test(mint)) return undefined;
  const json = await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, fetchImpl, {
    'user-agent': 'Mozilla/5.0 (trenchfeed)',
  });
  return json ? mapPumpfun(json, mint) : undefined;
}

// ---------- Virtuals (Base / Solana / Robinhood): agent API ----------

const VIRTUALS_API = 'https://api.virtuals.io/api/virtuals';

export function mapVirtuals(v: any, address: string): LaunchpadInfo | undefined {
  if (!v?.id) return undefined;
  // the record must be the token asked about (as its token or its pre-launch token), not whatever the list returned first
  const a = address.toLowerCase();
  if (String(v.tokenAddress ?? '').toLowerCase() !== a && String(v.preToken ?? '').toLowerCase() !== a) return undefined;
  const chain = String(v.chain ?? 'BASE').toUpperCase();
  const network = chain === 'SOLANA' ? 'solana' : chain === 'ROBINHOOD' ? 'robinhood' : 'base';
  const ref = v.symbol ? String(v.symbol).toLowerCase() : String(v.id);
  const out: LaunchpadInfo = { launchpad: 'virtuals', launchpadUrl: `https://app.virtuals.io/virtuals/${encodeURIComponent(ref)}`, network };
  const s = v.socials ?? {};
  applyCreatorFields(out, {
    name: v.name,
    symbol: v.symbol,
    image: v.image?.url,
    twitter: s.VERIFIED_LINKS?.TWITTER ?? s.x ?? s.TWITTER ?? s.VERIFIED_USERNAMES?.TWITTER,
    website: s.VERIFIED_LINKS?.WEBSITE ?? s.website ?? s.WEBSITE,
    telegram: s.VERIFIED_LINKS?.TELEGRAM ?? s.telegram ?? s.TELEGRAM,
  });
  const lp = v.lpCreatedAt ? Date.parse(String(v.lpCreatedAt)) : NaN;
  if (Number.isFinite(lp)) out.pairCreatedAt = lp;
  return out;
}

export async function fetchVirtuals(address: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  const a = encodeURIComponent(address);
  const q =
    `filters%5B%24or%5D%5B0%5D%5BtokenAddress%5D%5B%24eqi%5D=${a}` +
    `&filters%5B%24or%5D%5B1%5D%5BpreToken%5D%5B%24eqi%5D=${a}` +
    `&populate=%2A&pagination%5BpageSize%5D=1`;
  const json = await getJson(`${VIRTUALS_API}?${q}`, fetchImpl);
  const v = json?.data?.[0];
  return v ? mapVirtuals(v, address) : undefined;
}

// ---------- Flap (BNB, Robinhood, Monad, Base): the Portal's own record, metadata on IPFS ----------

export const BSC_RPC = 'https://bsc-dataseed.binance.org';

/**
 * Flap's Portal on each chain we support (docs.flap.sh deployed-contract-addresses; each checked on
 * 2026-09-28: `getTokenV8Safe` answers a record for a real Flap token and reverts TokenNotFound for
 * anything else). X Layer has one too; that chain is not in the app. `page` is flap.sh's path segment.
 */
export const FLAP_PORTALS: { network: string; portal: string; page: string }[] = [
  { network: 'bsc', portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0', page: 'bnb' },
  { network: 'robinhood', portal: '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09', page: 'robinhood' },
  { network: 'monad', portal: '0x30e8ee7b5881bf2E158A0514f2150aabe2c68b23', page: 'monad' },
  { network: 'base', portal: '0x0000BC1c4fD15Dd79029AF8F5d77D68ae4490000', page: 'base' },
];
/** The Portal only creates vanity addresses: 7777 (tax), 8888 (standard) and 1111 (Monad tax V3, X Layer). Nothing else is asked about. */
const FLAP_SUFFIXES = ['7777', '8888', '1111'];
const FLAP_SEL = { getTokenV8Safe: '0x62fafcca', metaURI: '0x67605787' };
const FLAP_GATEWAYS = ['https://flap.mypinata.cloud/ipfs/', ...IPFS_JSON_GATEWAYS];

export function flapCandidate(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && FLAP_SUFFIXES.some((x) => address.toLowerCase().endsWith(x));
}

export interface FlapRecord {
  /** 1 tradable on the curve · 4 on a DEX · 5 staged */
  status: number;
  /** curve progress, 1e18 = 100% */
  progress: bigint;
  /** address(0) = the chain's native coin */
  quote: string;
}

/** getTokenV8Safe: an 18-word static struct, status first; status 0 (Invalid) or anything unknown is not a token. */
export function decodeFlapRecord(hex: string): FlapRecord | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 18 || !/^[0-9a-fA-F]*$/.test(data)) return undefined;
  const w = (i: number) => BigInt('0x' + data.slice(i * 64, i * 64 + 64));
  const status = Number(w(0));
  if (status !== 1 && status !== 4 && status !== 5) return undefined;
  return { status, progress: w(15), quote: '0x' + data.slice(9 * 64 + 24, 10 * 64) };
}

export function flapNote(r: FlapRecord): string {
  if (r.status === 4) return 'graduated';
  if (r.status === 5) return 'staged';
  const pct = Number((r.progress * 1000n) / 10n ** 18n) / 10;
  return `bonding · ${Math.min(100, pct).toFixed(1)}%`;
}

export function mapFlap(meta: Record<string, unknown> | undefined, network: string, address: string, record?: FlapRecord): LaunchpadInfo {
  const page = FLAP_PORTALS.find((p) => p.network === network)?.page ?? network;
  const out: LaunchpadInfo = { launchpad: 'flap', launchpadUrl: `https://flap.sh/${page}/${address.toLowerCase()}`, network };
  if (record) out.launchpadNote = flapNote(record);
  if (meta) applyCreatorFields(out, { name: meta.name, symbol: meta.symbol, image: meta.image, website: meta.website, twitter: meta.twitter, telegram: meta.telegram });
  return out;
}

/**
 * Flap: the Portal's record says the token is one of its launches (answering metaURI() alone proves
 * nothing: any contract can). The creator's metadata is then read off IPFS through fixed gateways,
 * whatever gateway host the token names.
 */
export async function fetchFlap(address: string, fetchImpl: typeof fetch = fetch, network?: string, portals = FLAP_PORTALS): Promise<LaunchpadInfo | undefined> {
  if (!flapCandidate(address)) return undefined;
  const arg = address.slice(2).toLowerCase().padStart(64, '0');
  const asked = network ? portals.filter((p) => p.network === network) : portals;
  const hits = await Promise.all(
    asked.map(async (p) => {
      const rpc = rpcUrl(p.network);
      const res = rpc ? await ethCall(rpc, p.portal, FLAP_SEL.getTokenV8Safe + arg, fetchImpl).catch(() => undefined) : undefined;
      const record = res ? decodeFlapRecord(res) : undefined;
      return record ? { p, rpc: rpc!, record } : undefined;
    }),
  );
  const hit = hits.find(Boolean);
  if (!hit) return undefined;
  const uri = await ethCall(hit.rpc, address, FLAP_SEL.metaURI, fetchImpl).catch(() => undefined);
  const cid = uri ? decodeStrings(uri, 1)?.[0] : undefined;
  const meta = cid ? await fetchIpfsJson(cid, fetchImpl, FLAP_GATEWAYS) : undefined;
  return mapFlap(meta, hit.p.network, address, hit.record);
}

// ---------- Clanker (Base, Arbitrum, Ethereum, Monad, Robinhood): the v4 factory's record, metadata on the token ----------

/**
 * Clanker v4 factories (clanker.gitbook.io deployed-contracts; Robinhood from DefiLlama's adapter).
 * Each checked on 2026-09-28: tokenDeploymentInfo names a real clanker token and answers zeros for
 * anything else. Unichain has one too; that chain is not in the app. The clanker.world search API is
 * no longer asked: it refused connections from here, and the chain says everything it did.
 */
export const CLANKER_FACTORIES: { network: string; factory: string }[] = [
  { network: 'base', factory: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9' },
  { network: 'arbitrum', factory: '0xEb9D2A726Edffc887a574dC7f46b3a3638E8E44f' },
  { network: 'ethereum', factory: '0x6C8599779B03B00AAaE63C6378830919Abb75473' },
  { network: 'monad', factory: '0xF9a0C289Eab6B571c6247094a853810987E5B26D' },
  { network: 'robinhood', factory: '0xD3f2cC1731b7Fd17f28798835C2E02f0a1839A94' },
];
const CLANKER_SEL = { tokenDeploymentInfo: '0x22adcdb1', imageUrl: '0xaba83150', metadata: '0x392f37e9' };
/** the token's metadata() is a JSON string its admin writes; nothing legitimate is this big */
const CLANKER_METADATA_MAX = 16_000;

/** tokenDeploymentInfo(token) → (token, hook, locker, address[] extensions), ABI-encoded as one dynamic tuple. The token it names. */
export function decodeClankerDeployment(hex: string): string | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 4 || !/^[0-9a-fA-F]*$/.test(data)) return undefined;
  const off = Number(BigInt('0x' + data.slice(0, 64)));
  if (off !== 32 || data.length < (off + 32 * 3) * 2) return undefined;
  const w = data.slice(off * 2, off * 2 + 64);
  if (!/^0{24}/.test(w)) return undefined;
  const token = '0x' + w.slice(24);
  return /^0x0{40}$/.test(token) ? undefined : token;
}

/** The socials inside a clanker token's metadata JSON: socialMediaUrls [{ platform, url }]. */
export function clankerSocials(json: string | undefined): { website?: string; twitter?: string; telegram?: string } {
  const out: { website?: string; twitter?: string; telegram?: string } = {};
  if (!json || json.length > CLANKER_METADATA_MAX) return out;
  let meta: any;
  try {
    meta = JSON.parse(json);
  } catch {
    return out;
  }
  const list = Array.isArray(meta?.socialMediaUrls) ? meta.socialMediaUrls.slice(0, 20) : [];
  for (const sl of list) {
    const n = typeof sl?.platform === 'string' ? sl.platform.toLowerCase() : '';
    if (typeof sl?.url !== 'string') continue;
    if ((n === 'x' || n === 'twitter') && !out.twitter) out.twitter = sl.url;
    else if (n === 'telegram' && !out.telegram) out.telegram = sl.url;
    else if (n === 'website' && !out.website) out.website = sl.url;
  }
  return out;
}

export async function fetchClanker(address: string, fetchImpl: typeof fetch = fetch, network?: string, factories = CLANKER_FACTORIES): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const a = address.toLowerCase();
  const arg = a.slice(2).padStart(64, '0');
  const asked = network ? factories.filter((f) => f.network === network) : factories;
  const hits = await Promise.all(
    asked.map(async (f) => {
      const rpc = rpcUrl(f.network);
      const res = rpc ? await ethCall(rpc, f.factory, CLANKER_SEL.tokenDeploymentInfo + arg, fetchImpl).catch(() => undefined) : undefined;
      // the factory answers zeros for a token it did not deploy: only a record naming this token counts
      return res && decodeClankerDeployment(res) === a ? { network: f.network, rpc: rpc! } : undefined;
    }),
  );
  const hit = hits.find(Boolean);
  if (!hit) return undefined;
  const [name, symbol, image, metadata] = await ethCalls(hit.rpc, [SEL.name, SEL.symbol, CLANKER_SEL.imageUrl, CLANKER_SEL.metadata].map((data) => ({ to: address, data })), fetchImpl);
  const str = (h: string | undefined) => (h ? decodeStrings(h, 1)?.[0] : undefined);
  const out: LaunchpadInfo = { launchpad: 'clanker', launchpadUrl: `https://www.clanker.world/clanker/${a}`, network: hit.network };
  applyCreatorFields(out, { name: str(name), symbol: str(symbol), image: str(image), ...clankerSocials(str(metadata)) });
  return out;
}

// ---------- Bankr (Base + Robinhood) ----------

export function mapBankrLaunch(json: any, address: string): LaunchpadInfo | undefined {
  const l = json?.launch ?? json;
  if (!l || typeof l !== 'object' || !l.tokenAddress) return undefined;
  if (String(l.tokenAddress).toLowerCase() !== address.toLowerCase()) return undefined;
  const out: LaunchpadInfo = { launchpad: 'bankr', launchpadUrl: `https://bankr.bot/launches/${address.toLowerCase()}` };
  if (l.chain) out.network = String(l.chain).toLowerCase() === 'robinhood' ? 'robinhood' : 'base';
  applyCreatorFields(out, { name: l.tokenName, symbol: l.tokenSymbol, website: l.websiteUrl, twitter: l.deployer?.xUsername ?? l.feeRecipient?.xUsername, image: l.imageUri });
  return out;
}

export async function fetchBankrLaunch(address: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const json = await getJson(`https://api.bankr.bot/token-launches/${address}`, fetchImpl);
  if (!json || json.error) return undefined;
  return mapBankrLaunch(json, address);
}

// ---------- Stonks (Base): one cached launch list ----------

const STONKS_API = 'https://www.thestonks.exchange/api/coins';
const STONKS_TTL_MS = 60_000;
let stonksCache: { at: number; coins: any[] } | undefined;

export function mapStonksCoin(c: any, address: string): LaunchpadInfo {
  const out: LaunchpadInfo = {
    launchpad: 'stonks',
    launchpadUrl: `https://www.thestonks.exchange/token/${address.toLowerCase()}`,
    network: 'base',
  };
  applyCreatorFields(out, { name: c.name, symbol: c.symbol, image: c.image, website: c.website, twitter: c.twitter, telegram: c.telegram });
  const created = Number(c.created_at);
  if (Number.isFinite(created) && created > 0) out.pairCreatedAt = created * 1000;
  return out;
}

export async function fetchStonks(address: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<LaunchpadInfo | undefined> {
  const a = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) return undefined;
  if (!stonksCache || now - stonksCache.at > STONKS_TTL_MS) {
    const json = await getJson(STONKS_API, fetchImpl);
    const coins = Array.isArray(json) ? json : (json?.coins ?? json?.data ?? []);
    if (!Array.isArray(coins)) return undefined;
    stonksCache = { at: now, coins };
  }
  const hit = stonksCache.coins.find((c) => String(c?.token ?? '').toLowerCase() === a);
  return hit ? mapStonksCoin(hit, address) : undefined;
}

export function __resetStonksCache(): void {
  stonksCache = undefined;
}

// ---------- Pons (Robinhood Chain): self-describing token contract ----------

export const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SEL = { socials: '0x53cd512a', logo: '0xfb7f21eb', name: '0x06fdde03', symbol: '0x95d89b41' };

/** Decode ABI-encoded return data made of `n` dynamic strings. */
export function decodeStrings(hex: string, n: number): string[] | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * n) return undefined;
  const word = (i: number) => data.slice(i * 64, i * 64 + 64);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const off = parseInt(word(i), 16);
    if (!Number.isFinite(off) || off * 2 + 64 > data.length) return undefined;
    const len = parseInt(data.slice(off * 2, off * 2 + 64), 16);
    const start = off * 2 + 64;
    if (!Number.isFinite(len) || start + len * 2 > data.length) return undefined;
    out.push(Buffer.from(data.slice(start, start + len * 2), 'hex').toString('utf8'));
  }
  return out;
}

const ETH_CALL_MAX_HEX = 262_144;

async function ethCall(rpc: string, to: string, data: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      signal: ctl.signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (!res.ok) return undefined;
    const text = await readCapped(res, ETH_CALL_MAX_HEX + 1024);
    if (text === undefined) return undefined;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    const r = json?.result;
    // a node's answer is data from outside: hex only, and nothing a contract call would legitimately return this big
    return typeof r === 'string' && r.length > 2 && r.length <= ETH_CALL_MAX_HEX && /^0x[0-9a-fA-F]*$/.test(r) ? r : undefined;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pons (ponsfamily.com, Robinhood Chain). V1 launched straight into a Uniswap v3 pool; V2 is the
 * Genius stack (a curve, then a v4 pool). NOXA Fun runs the same V1 contracts, so a token answering
 * the Pons calls proves nothing: the token's launchFactory() says which factory to ask (it is only a
 * hint, the token wrote it), and that factory's own record must name the token. Factories checked
 * on-chain 2026-09-28; the older V2 factory is not in their docs but its launches are live.
 */
export const PONS_V1_FACTORIES = ['0x0c37a24F5D23A486FA692d1500881d698B1F77a4', '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'];
export const PONS_V2_FACTORIES = ['0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8'];
const PONS_SEL = { launchFactory: '0x536dac9b', liquidityPool: '0x665a11ca' };
const ponsPage = (a: string) => `https://www.ponsfamily.com/launchpad/${a.toLowerCase()}`;

/** V1 getLaunchedToken: 13 words (token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount). */
export function decodePonsV1Launch(hex: string): { token: string } | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 13 || !/^[0-9a-fA-F]*$/.test(data)) return undefined;
  if (BigInt('0x' + data.slice(11 * 64, 12 * 64)) !== 1n) return undefined;
  return { token: '0x' + data.slice(24, 64) };
}

export async function fetchPons(address: string, fetchImpl: typeof fetch = fetch, rpc = rpcUrl('robinhood') ?? ROBINHOOD_RPC): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const a = address.toLowerCase();
  const lf = await ethCall(rpc, address, PONS_SEL.launchFactory, fetchImpl).catch(() => undefined);
  const factory = lf && lf.length >= 66 && /^0x0{24}/.test(lf) ? '0x' + lf.slice(26, 66) : undefined;
  if (!factory) return undefined;
  const v2 = PONS_V2_FACTORIES.find((f) => f.toLowerCase() === factory);
  if (v2) return fetchGeniusStack({ ...PONS_STACK, factory: v2 }, address, fetchImpl, rpc);
  const v1 = PONS_V1_FACTORIES.find((f) => f.toLowerCase() === factory);
  if (!v1) return undefined; // NOXA, or anything else claiming a factory
  const rec = await ethCall(rpc, v1, GENIUS_SEL.getLaunchedToken + a.slice(2).padStart(64, '0'), fetchImpl).catch(() => undefined);
  const launch = rec ? decodePonsV1Launch(rec) : undefined;
  if (!launch || launch.token !== a) return undefined;
  const [info, name, symbol, pool] = await ethCalls(rpc, [GENIUS_SEL.getTokenInfo, SEL.name, SEL.symbol, PONS_SEL.liquidityPool].map((data) => ({ to: address, data })), fetchImpl);
  const out: LaunchpadInfo = { launchpad: 'pons', launchpadUrl: ponsPage(a), network: 'robinhood' };
  const meta = info && info.length <= TOKEN_INFO_MAX_HEX ? decodeGeniusTokenInfo(info) : undefined;
  const str = (h: string | undefined) => (h ? decodeStrings(h, 1)?.[0] : undefined);
  applyCreatorFields(out, { name: str(name), symbol: str(symbol), image: meta?.logo, twitter: meta?.socials[0], telegram: meta?.socials[1], website: meta?.socials[3] });
  // V1 has no curve: the token trades in its Uniswap v3 pool from the first block, and the pricer checks the pool holds it
  if (pool && pool.length >= 66 && /^0x0{24}/.test(pool) && !/^0x0{64}/.test(pool.slice(0, 66))) {
    out.pairAddress = '0x' + pool.slice(26, 66);
    out.dex = 'uniswap';
  }
  return out;
}

// ---------- o1 (Base, Robinhood, Monad, Arc, BNB): the factory's record; the keyed API only adds to it ----------

const O1_API = 'https://api.launch.o1.exchange/v1';
/**
 * o1's v4-minimal factories (docs.o1.exchange production-contracts, DefiLlama's adapter). Each checked
 * on 2026-09-28: creatorRights(token) answers for a real o1 token and reverts for anything else
 * (0xec7f19d0). X Layer has one too; that chain is not in the app. The public API serves only Base,
 * Robinhood, Monad and Arc, so it is asked (with the user's key) only there.
 */
export const O1_FACTORIES: { network: string; chainId: number; factory: string; api: boolean }[] = [
  { network: 'base', chainId: 8453, factory: '0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC', api: true },
  { network: 'robinhood', chainId: 4663, factory: '0xcE9C48cFa068947f77738c81Be406B53338E5B0d', api: true },
  { network: 'monad', chainId: 143, factory: '0x99C09A90feED8D5e57A19A8C1F103AE29BA5b5b7', api: true },
  { network: 'arc', chainId: 5042, factory: '0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605', api: true },
  { network: 'bsc', chainId: 56, factory: '0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605', api: false },
];
const O1_SEL = { creatorRights: '0x39b372a1', contractURI: '0xe8a3d485' };

/** creatorRights: (originalCreator, currentCreator, pendingCreator, feeRecipient, bytes32 poolId, bool metadataEditable); a launch has a creator and a pool. */
export function decodeO1Rights(hex: string): { poolId: string } | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 6 || !/^[0-9a-fA-F]*$/.test(data)) return undefined;
  if (/^0+$/.test(data.slice(0, 64)) || /^0+$/.test(data.slice(4 * 64, 5 * 64))) return undefined;
  return { poolId: '0x' + data.slice(4 * 64, 5 * 64) };
}

export async function fetchO1(address: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, network?: string, factories = O1_FACTORIES): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const a = address.toLowerCase();
  const arg = a.slice(2).padStart(64, '0');
  const asked = network ? factories.filter((f) => f.network === network) : factories;
  const hits = await Promise.all(
    asked.map(async (f) => {
      const rpc = rpcUrl(f.network);
      const res = rpc ? await ethCall(rpc, f.factory, O1_SEL.creatorRights + arg, fetchImpl).catch(() => undefined) : undefined;
      return res && decodeO1Rights(res) ? { f, rpc: rpc! } : undefined;
    }),
  );
  const hit = hits.find(Boolean);
  if (!hit) return undefined;
  const out: LaunchpadInfo = { launchpad: 'o1', launchpadUrl: 'https://launch.o1.exchange', network: hit.f.network };
  // the key only adds image and socials; the badge never depended on it
  const t = apiKey && hit.f.api ? (await getJson(`${O1_API}/tokens/${hit.f.chainId}/${a}`, fetchImpl, { 'x-api-key': apiKey }).catch(() => undefined))?.data?.token : undefined;
  if (t && typeof t === 'object') {
    applyCreatorFields(out, { name: t.name, symbol: t.symbol, image: t.image_url, website: t.website, twitter: t.x, telegram: t.telegram });
    return out;
  }
  // no key: the token's own name and ticker, and its metadata JSON when it lives on IPFS (an http contractURI is a
  // host the creator picked, and is never fetched)
  const [name, symbol, uri] = await ethCalls(hit.rpc, [SEL.name, SEL.symbol, O1_SEL.contractURI].map((data) => ({ to: address, data })), fetchImpl);
  const str = (h: string | undefined) => (h ? decodeStrings(h, 1)?.[0] : undefined);
  const u = str(uri);
  const meta = u && /^ipfs:\/\//i.test(u.trim()) ? await fetchIpfsJson(u, fetchImpl) : undefined;
  applyCreatorFields(out, { name: str(name), symbol: str(symbol), image: meta?.image, website: meta?.website, twitter: meta?.twitter ?? meta?.x, telegram: meta?.telegram });
  return out;
}

// ---------- orchestrator ----------

export interface LaunchpadProbes {
  bankr?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  stonks?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  pons?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  /** Genius (BNB Chain): one factory call says whether the token is a launch */
  genius?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  /** Loong (BNB Chain, a Genius fork): only addresses ending in 9999 are asked about */
  loong?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  flap?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  virtuals?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  clanker?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  o1?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  pumpfun?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  /** Long (Robinhood Chain): cheap, it only asks for the `1e18` suffix */
  argus?: (address: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  warp?: (address: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  peach?: (address: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  dyor?: (address: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  synthra?: (address: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  long?: (a: string, network?: string) => Promise<LaunchpadInfo | undefined>;
  log?: (m: string) => void;
}

/**
 * First launchpad that claims the token wins. Solana: pump.fun mints (suffix)
 * get the pump.fun API for image/mcap; letsbonk by suffix. EVM: probes in order.
 */
export function createLaunchpadClassifier(p: LaunchpadProbes): (address: string, chain: Chain, network?: string) => Promise<LaunchpadInfo | undefined> {
  const log = p.log ?? ((m: string) => console.warn('[launchpad]', m));
  // `network` is where the chart sites or the chain placed the token; a multi-chain probe then asks that chain alone
  return async (address, chain, network) => {
    const bySuffix = classifyBySuffix(address, chain);
    if (bySuffix?.launchpad === 'pumpfun' && p.pumpfun) {
      try {
        const full = await p.pumpfun(address);
        if (full) return full;
      } catch (e: any) {
        log(`pumpfun probe failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (bySuffix) return bySuffix;
    if (chain === 'sol') {
      // not every pump.fun mint ends in "pump" (a vanity suffix the creator can skip): ask pump.fun
      // itself, a 404 is cheap and settles it
      if (p.pumpfun) {
        try {
          return await p.pumpfun(address);
        } catch (e: any) {
          log(`pumpfun probe failed for ${address}: ${e?.message ?? e}`);
        }
      }
      return undefined;
    }
    if (chain !== 'evm') return undefined;
    for (const [name, probe] of [
      ['long', p.long],
      ['argus', p.argus],
      ['warp', p.warp],
      ['peach', p.peach],
      ['dyor', p.dyor],
      ['synthra', p.synthra],
      ['bankr', p.bankr],
      ['stonks', p.stonks],
      ['pons', p.pons],
      ['genius', p.genius],
      ['loong', p.loong],
      ['flap', p.flap],
      ['virtuals', p.virtuals],
      ['clanker', p.clanker],
      ['o1', p.o1],
    ] as const) {
      if (!probe) continue;
      try {
        const hit = await probe(address, network);
        if (hit) return hit;
      } catch (e: any) {
        log(`${name} probe failed for ${address}: ${e?.message ?? e}`);
      }
    }
    return undefined;
  };
}


// ---------- Argus (Arc): on-chain Portals, no API ----------

const ARC_RPC = 'https://rpc.blockdaemon.mainnet.arc.io';
/** Every Argus Portal (arguspad.io/argus-v4.json); a token launched through any of them answers launches(token) with its creator. */
export const ARGUS_PORTALS: { address: string; v4: boolean }[] = [
  { address: '0xB021Be536808f551b31789422Fd28a6c9c6e97Da', v4: true },
  { address: '0xA5628A11c412596E1f63b75a2C0284F843C549d6', v4: true },
  { address: '0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E', v4: true },
  { address: '0xa36c443A797771Df82533B8B4A86F0AFfd970862', v4: true },
  { address: '0x7A17Ab0106C46C0be30623F3EB7F299CC0058338', v4: true },
  { address: '0xBed9880A0ba12722ba4b8791c0B6F8c74338246C', v4: false },
  { address: '0x0F1C7Cb26D6cD36BD4189E41947658b39437587A', v4: false },
];
const ARGUS_SEL = { launches: '0x1f2d8550', bonded: '0xe88dc357' } as const; // keccak of launches(address), bonded()
/** v4 TokenCreated(address indexed token, address indexed creator, string name, string symbol, bytes32 poolId, string imageURI, string website, string twitter, string telegram) */
const ARGUS_TOKEN_CREATED = '0x1d8917231579f8ce39407f0d616f36f357b07329b0ce5164d0754ac15145ce0a';
/** Arc RPCs cap eth_getLogs at 100k blocks a query; the launch event is looked for window by window, newest first, this many windows back */
const ARGUS_LOG_WINDOW = 99_000;
const ARGUS_LOG_WINDOWS = 8;

const RPC_BATCH_MAX_BYTES = 2_000_000;

async function rpcBatch(rpc: string, calls: { method: string; params: unknown[] }[], fetchImpl: typeof fetch): Promise<any[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpc, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))), signal: ctl.signal });
    if (!res.ok) return [];
    const text = await readCapped(res, RPC_BATCH_MAX_BYTES);
    let json: unknown;
    try {
      json = text === undefined ? undefined : JSON.parse(text);
    } catch {
      return [];
    }
    if (!Array.isArray(json)) return [];
    // a node's answer is data from outside: a call's result is kept only as hex; logs keep their shape and are checked where read
    return calls.map((_, id) => {
      const r = json.find((x: any) => Number(x?.id) === id);
      if (!r || typeof r !== 'object') return undefined;
      if (typeof r.result === 'string' && !/^0x[0-9a-fA-F]*$/.test(r.result)) return { ...r, result: undefined };
      return r;
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Several eth_calls in one request (public nodes rate-limit bursts of single calls: Base answers the
 * fourth parallel one with "over rate limit"). Each answer is hex no bigger than a call could return, or undefined.
 */
async function ethCalls(rpc: string, calls: { to: string; data: string }[], fetchImpl: typeof fetch): Promise<(string | undefined)[]> {
  const rows = await rpcBatch(rpc, calls.map((c) => ({ method: 'eth_call', params: [c, 'latest'] })), fetchImpl).catch(() => []);
  return calls.map((_, i) => {
    const r = rows[i]?.result;
    return typeof r === 'string' && r.length > 2 && r.length <= ETH_CALL_MAX_HEX ? r : undefined;
  });
}

/** The word at index i of an ABI-encoded return, as hex without 0x. */
const word = (hex: string, i: number): string | undefined => (hex.length >= 2 + (i + 1) * 64 ? hex.slice(2 + i * 64, 2 + (i + 1) * 64) : undefined);
const wordAddr = (hex: string, i: number): string | undefined => {
  const w = word(hex, i);
  return w ? '0x' + w.slice(24) : undefined;
};

/**
 * Argus: a token is one of theirs when a Portal's launches(token) names a creator. The hook's
 * bonded() says whether it has left the curve. The launch event (name, symbol, image, socials) is
 * read from recent logs when the RPC still has them; a pruned range costs nothing but the image.
 */
export async function fetchArgus(address: string, fetchImpl: typeof fetch = fetch, rpc = ARC_RPC, portals = ARGUS_PORTALS): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const a = address.toLowerCase();
  const arg = a.slice(2).padStart(64, '0');
  const rows = await rpcBatch(rpc, portals.map((p) => ({ method: 'eth_call', params: [{ to: p.address, data: ARGUS_SEL.launches + arg }, 'latest'] })), fetchImpl);
  let hit: { portal: (typeof portals)[number]; result: string } | undefined;
  rows.forEach((r, i) => {
    const res = r?.result;
    if (!hit && typeof res === 'string' && res.length > 66 && !/^0x0{64}/.test(res)) hit = { portal: portals[i], result: res };
  });
  if (!hit) return undefined;
  const out: LaunchpadInfo = { launchpad: 'argus', launchpadUrl: `https://argus.world/token/${a}`, network: 'arc', quoteSymbol: 'USDC', dex: 'argus' };
  const hook = hit.portal.v4 ? wordAddr(hit.result, 4) : undefined;
  const buyTax = hit.portal.v4 ? parseInt(word(hit.result, 6) ?? '0', 16) : NaN;
  const sellTax = hit.portal.v4 ? parseInt(word(hit.result, 7) ?? '0', 16) : NaN;
  const calls: { method: string; params: unknown[] }[] = [];
  if (hook && !/^0x0{40}$/.test(hook)) calls.push({ method: 'eth_call', params: [{ to: hook, data: ARGUS_SEL.bonded }, 'latest'] });
  calls.push({ method: 'eth_blockNumber', params: [] });
  const extra = await rpcBatch(rpc, calls, fetchImpl).catch(() => []);
  const bonded = calls.length === 2 ? /1$/.test(String(extra[0]?.result ?? '')) : undefined;
  const latest = parseInt(String(extra[calls.length - 1]?.result ?? '0x0'), 16);
  const notes: string[] = [];
  if (bonded !== undefined) notes.push(bonded ? 'graduated' : 'bonding');
  if (Number.isFinite(buyTax) && Number.isFinite(sellTax) && (buyTax || sellTax)) notes.push(`${buyTax / 100}% / ${sellTax / 100}% tax`);
  if (notes.length) out.launchpadNote = notes.join(' · ');
  if (hit.portal.v4 && latest > 0) {
    // the launch event carries what the chain sites lack; Arc RPCs prune old logs, so a miss here is not an error
    try {
      let log: any;
      for (let i = 0; i < ARGUS_LOG_WINDOWS && !log; i++) {
        const to = latest - i * ARGUS_LOG_WINDOW;
        const from = Math.max(0, to - ARGUS_LOG_WINDOW + 1);
        const [lg] = await rpcBatch(rpc, [{ method: 'eth_getLogs', params: [{ address: hit.portal.address, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [ARGUS_TOKEN_CREATED, '0x' + arg] }] }], fetchImpl);
        if (lg?.error) break; // pruned that far back: what we have will do
        log = Array.isArray(lg?.result) ? lg.result[0] : undefined;
        if (from === 0) break;
      }
      if (typeof log?.data === 'string' && /^0x[0-9a-fA-F]*$/.test(log.data) && log.data.length <= ETH_CALL_MAX_HEX) {
        // data: (string name, string symbol, bytes32 poolId, string imageURI, string website, string twitter, string telegram)
        const strings = decodeDynamicStrings(String(log.data), [0, 1, 3, 4, 5, 6]);
        if (strings) {
          const [name, symbol, image, website, twitter, telegram] = strings;
          applyCreatorFields(out, { name, symbol, image, website, twitter, telegram });
        }
      }
    } catch {
      /* pruned or slow: badge and status still stand */
    }
  }
  return out;
}

/** The string members of an ABI-encoded tuple, by head-word index (other members skipped). */
export function decodeDynamicStrings(hex: string, stringSlots: number[]): string[] | undefined {
  try {
    const body = hex.replace(/^0x/, '');
    const out: string[] = [];
    for (const slot of stringSlots) {
      const off = parseInt(body.slice(slot * 64, slot * 64 + 64), 16) * 2;
      const len = parseInt(body.slice(off, off + 64), 16) * 2;
      if (!Number.isFinite(off) || !Number.isFinite(len) || off + 64 + len > body.length) return undefined;
      out.push(Buffer.from(body.slice(off + 64, off + 64 + len), 'hex').toString('utf8'));
    }
    return out;
  } catch {
    return undefined;
  }
}


// ---------- Warp (Arc): public read API over its own factory ----------

const WARP_API = 'https://warp-arc-production.up.railway.app';

export function mapWarp(d: any, address: string): LaunchpadInfo | undefined {
  if (!d || typeof d !== 'object' || d.error) return undefined;
  const a = address.toLowerCase();
  if (String(d.address ?? d.id ?? '').toLowerCase() !== a) return undefined;
  // Warp's terminal also indexes tokens from other launchpads and pools; those come back `external` and are not Warp launches
  const status = String(d.status ?? '').toLowerCase();
  if (status !== 'live' && status !== 'migrated') return undefined;
  const out: LaunchpadInfo = { launchpad: 'warp', launchpadUrl: `https://circlewarp.fun/trade/${a}`, network: 'arc', quoteSymbol: 'USDC', dex: 'warp' };
  applyCreatorFields(out, { name: d.name, symbol: d.ticker, image: d.image, twitter: d.twitter });
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const price = num(d.price), mcap = num(d.mcap), liq = num(d.liquidity), chg = num(d.change24h), vol = num(d.volume);
  if (price !== undefined && price > 0) out.priceUsd = price;
  if (mcap !== undefined) out.marketCap = mcap;
  if (liq !== undefined) out.liquidity = liq;
  if (chg !== undefined) out.change24h = chg;
  if (vol !== undefined) out.volume24h = vol;
  if (d.pairAddress && /^0x[0-9a-fA-F]{40}$/.test(String(d.pairAddress))) out.pairAddress = String(d.pairAddress).toLowerCase();
  const created = num(d.createdAt);
  if (created) out.pairCreatedAt = created;
  const migrated = d.migrated === true || d.migrated === 'true' || d.status === 'migrated';
  const progress = num(d.progress);
  out.launchpadNote = migrated ? 'graduated to WarpDex' : progress !== undefined ? `bonding · ${Math.round(progress)}% to $69K` : 'bonding';
  return out;
}

/** Warp: its read API answers 404 for anything it did not launch. */
export async function fetchWarp(address: string, fetchImpl: typeof fetch = fetch, api = WARP_API): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const json = await getJson(`${api}/api/tokens/${address.toLowerCase()}`, fetchImpl);
  return json ? mapWarp(json, address) : undefined;
}


// ---------- Peach (Arc): public launchpad API ----------

const PEACH_API = 'https://api.peach.ag/arc/v1/launchpad';

export function mapPeach(d: any, address: string): LaunchpadInfo | undefined {
  if (!d || typeof d !== 'object' || d.error) return undefined;
  const a = address.toLowerCase();
  if (String(d.token ?? '').toLowerCase() !== a) return undefined;
  const out: LaunchpadInfo = { launchpad: 'peach', launchpadUrl: `https://www.peach.ag/arc/tokens/${a}`, network: 'arc', quoteSymbol: 'USDC', dex: 'peach' };
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  applyCreatorFields(out, { name: d.name, symbol: d.symbol, image: d.image_url ?? d.image_uri, twitter: d.x ?? d.twitter, website: d.website, telegram: d.telegram });
  const price = num(d.price_usd), mcap = num(d.market_cap_usd), liq = num(d.liquidity_usd), vol = num(d.volume_24h_usd), chg = num(d.price_change_24h), created = num(d.created_at);
  if (price !== undefined && price > 0) out.priceUsd = price;
  if (mcap !== undefined) out.marketCap = mcap;
  if (liq !== undefined) out.liquidity = liq;
  if (vol !== undefined) out.volume24h = vol;
  if (chg !== undefined) out.change24h = chg;
  if (created) out.pairCreatedAt = created * 1000;
  const status = String(d.status ?? '').toUpperCase();
  const progress = num(d.progress);
  out.launchpadNote = status === 'GRADUATED' ? 'graduated' : progress !== undefined ? `bonding · ${Math.round(progress)}%` : (cleanLabel(status.toLowerCase(), 24) ?? 'bonding');
  return out;
}

/** Peach: its launchpad API answers 404 for anything it did not launch. */
export async function fetchPeach(address: string, fetchImpl: typeof fetch = fetch, api = PEACH_API): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const json = await getJson(`${api}/tokens/${address.toLowerCase()}`, fetchImpl);
  return json ? mapPeach(json, address) : undefined;
}

// ---------- DYOR Launch (Arc, Robinhood): factory + curve, no API ----------

/** LaunchFactory per chain (dyorswap.org/docs/launch-curve); the curve is created per token by the factory */
export const DYOR_CHAINS: { network: string; chainId: number; factory: string; rpc: string; /** the reader contract dyorswap.org's own page asks; it also knows the earlier (V2) launches the current factory does not */ reader?: string }[] = [
  { network: 'arc', chainId: 5042, factory: '0xa2448256e2A2e2Fc02a8faff1Dbcc91C640FFcD8', rpc: ARC_RPC, reader: '0xDb3e73989EaE0a5132d668099C529F51A97EE8C3' },
  { network: 'robinhood', chainId: 4663, factory: '0xA22CAC40344aEf32BD0952e98b2E1B3ef8914C0F', rpc: ROBINHOOD_RPC },
];
const DYOR_SEL = { launchCurveOf: '0x86e14352', graduated: '0xe7c2b772', salePairReserve: '0xdcce240a', graduationPairAmount: '0xbdf50293', /** the reader's per-token call (undocumented; answers a number for a DYOR token, reverts for anything else) */ readerToken: '0x9fc66651' } as const;

/**
 * DYOR: the factory's launchCurveOf(token) names the curve when the token is one of theirs; the
 * curve's graduated() and its raised / target pair amounts give the status.
 */
export async function fetchDyor(address: string, fetchImpl: typeof fetch = fetch, chains = DYOR_CHAINS): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const a = address.toLowerCase();
  const arg = a.slice(2).padStart(64, '0');
  for (const chain of chains) {
    let rows: any[];
    try {
      rows = await rpcBatch(chain.rpc, [{ method: 'eth_call', params: [{ to: chain.factory, data: DYOR_SEL.launchCurveOf + arg }, 'latest'] }], fetchImpl);
    } catch {
      continue;
    }
    const curve = typeof rows[0]?.result === 'string' ? wordAddr(rows[0].result, 0) : undefined;
    if (!curve || /^0x0{40}$/.test(curve)) {
      // not on the current factory; an earlier DYOR launch (V2) still answers on the reader the site itself uses
      if (!chain.reader) continue;
      const older = await rpcBatch(chain.rpc, [{ method: 'eth_call', params: [{ to: chain.reader, data: DYOR_SEL.readerToken + arg }, 'latest'] }], fetchImpl).catch(() => []);
      if (typeof older[0]?.result !== 'string' || older[0].result.length <= 2) continue;
      return { launchpad: 'dyor', launchpadUrl: `https://dyorswap.org/token?address=${a}&chainId=${chain.chainId}`, network: chain.network };
    }
    const out: LaunchpadInfo = { launchpad: 'dyor', launchpadUrl: `https://dyorswap.org/token?address=${a}&chainId=${chain.chainId}`, network: chain.network, quoteSymbol: chain.network === 'arc' ? 'USDC' : 'ETH', dex: 'dyor' };
    try {
      const st = await rpcBatch(chain.rpc, [
        { method: 'eth_call', params: [{ to: curve, data: DYOR_SEL.graduated }, 'latest'] },
        { method: 'eth_call', params: [{ to: curve, data: DYOR_SEL.salePairReserve }, 'latest'] },
        { method: 'eth_call', params: [{ to: curve, data: DYOR_SEL.graduationPairAmount }, 'latest'] },
      ], fetchImpl);
      const graduated = /1$/.test(String(st[0]?.result ?? ''));
      const raised = BigInt(st[1]?.result ?? '0x0');
      const target = BigInt(st[2]?.result ?? '0x0');
      out.launchpadNote = graduated ? 'graduated' : target > 0n ? `bonding · ${Number((raised * 1000n) / target) / 10}%` : 'bonding';
    } catch {
      out.launchpadNote = 'bonding';
    }
    return out;
  }
  return undefined;
}


// ---------- Synthra Launches (Arc, Robinhood): launches subgraph + metadata service ----------

/** docs.synthra.org/docs/contract-addresses; the subgraph per chain is what the app itself reads */
export const SYNTHRA_CHAINS: { network: string; chainId: number; subgraph: string; /** the quote asset is USD on Arc; on Robinhood it is ETH and needs the rate */ quoteIsUsd: boolean }[] = [
  { network: 'arc', chainId: 5042, subgraph: 'https://subgraph.synthra.org/subgraphs/name/arc-mainnet/synthra-launches', quoteIsUsd: true },
  { network: 'robinhood', chainId: 4663, subgraph: 'https://subgraph.synthra.org/subgraphs/name/robinhood-mainnet/synthra-launches', quoteIsUsd: false },
];
const SYNTHRA_API = 'https://api-mainnet.synthra.org/api/v1/launchpad';
const SYNTHRA_TOKEN_QUERY = 'query($id: ID!) { token(id: $id) { id name symbol metadataURI createdAt status progressBps priceUsdc marketCapUsdc holderCount volumeUsdc pool lastTradeAt } }';

export function mapSynthra(t: any, chain: (typeof SYNTHRA_CHAINS)[number], rate = 1): LaunchpadInfo | undefined {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string') return undefined;
  const a = t.id.toLowerCase();
  // the app's launchpad list; a per-token route could not be verified from here, the list is the entry
  const out: LaunchpadInfo = { launchpad: 'synthra', launchpadUrl: 'https://app.synthra.org/#/launchpad', network: chain.network, quoteSymbol: chain.quoteIsUsd ? 'USDC' : 'ETH', dex: 'synthra' };
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  applyCreatorFields(out, { name: t.name, symbol: t.symbol });
  const price = num(t.priceUsdc), mcap = num(t.marketCapUsdc), vol = num(t.volumeUsdc), created = num(t.createdAt);
  if (price !== undefined && price > 0) out.priceUsd = price * rate;
  if (mcap !== undefined) out.marketCap = mcap * rate;
  if (vol !== undefined) out.volume24h = vol * rate;
  if (created) out.pairCreatedAt = created * 1000;
  if (t.pool && /^0x[0-9a-fA-F]{40}$/.test(String(t.pool))) out.pairAddress = String(t.pool).toLowerCase();
  const status = String(t.status ?? '').toUpperCase();
  const bps = num(t.progressBps);
  out.launchpadNote = status === 'GRADUATED' ? 'graduated' : status === 'COMPLETE' ? 'curve complete · graduating' : bps !== undefined ? `bonding · ${Math.round(bps / 100)}%` : 'bonding';
  void a;
  return out;
}

async function synthraSubgraph(url: string, address: string, fetchImpl: typeof fetch): Promise<any | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SYNTHRA_TOKEN_QUERY, variables: { id: address.toLowerCase() } }), signal: ctl.signal });
    if (!res.ok) return undefined;
    const text = await readCapped(res, JSON_MAX_BYTES);
    const json = text === undefined ? undefined : JSON.parse(text);
    const t = json?.data?.token;
    // the subgraph is keyed by the address asked about; an answer for another token is not this one
    return t && typeof t.id === 'string' && t.id.toLowerCase() === address.toLowerCase() ? t : undefined;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Synthra: the launches subgraph names the token when it is one of theirs (Arc first, then
 * Robinhood). The metadata service fills the image and socials when it answers; the quote-rate
 * endpoint turns ETH-priced Robinhood launches into dollars.
 */
export async function fetchSynthra(address: string, fetchImpl: typeof fetch = fetch, chains = SYNTHRA_CHAINS, api = SYNTHRA_API): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  for (const chain of chains) {
    const t = await synthraSubgraph(chain.subgraph, address, fetchImpl).catch(() => undefined);
    if (!t) continue;
    let rate = 1;
    if (!chain.quoteIsUsd) {
      const q = await getJson(`${api}/quote-rate?chainId=${chain.chainId}`, fetchImpl).catch(() => undefined);
      const r = Number(q?.data?.rates?.find((x: any) => Number(x?.chainId) === chain.chainId)?.rate);
      rate = Number.isFinite(r) && r > 0 ? r : 0;
    }
    const out = mapSynthra(t, chain, rate || 1);
    if (!out) continue;
    if (!rate) {
      // no dollar rate for an ETH-priced launch: keep the badge and status, not numbers in the wrong unit
      delete out.priceUsd;
      delete out.marketCap;
      delete out.volume24h;
    }
    // the id goes into one path segment on their host: an ipfs:// id or a plain id, never anything that could climb out of it
    if (typeof t.metadataURI === 'string' && /^(?:ipfs:\/\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(t.metadataURI)) {
      const meta = await getJson(`${api}/metadata/${encodeURIComponent(t.metadataURI)}`, fetchImpl).catch(() => undefined);
      const d = meta?.data;
      if (d && typeof d === 'object') {
        const soc = d.socials ?? {};
        applyCreatorFields(out, { image: d.image?.thumb ?? d.image?.full, twitter: soc.x ?? soc.twitter, telegram: soc.telegram, website: soc.website });
      }
    }
    return out;
  }
  return undefined;
}

// ---------- Genius (BNB Chain): the factory's launch record and the token's own metadata; no API ----------

/**
 * genius.fun is a Pons v2 stack on BNB Chain (release prod-foundation-20260916, ABI 4.1.0) with a
 * documented on-chain surface and, by design, no public API. One factory call says whether a
 * token is a launch and where it trades; the token itself carries logo, description and socials.
 * Graduated tokens move to a PancakeSwap Infinity pool the live pricer does not read yet, so
 * they keep the directory price; on-curve ones are priced off the curve like Pons.
 */
export const GENIUS_FACTORY = '0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31';
export const GENIUS_SEL = { getLaunchedToken: '0x3cf28b5a', getTokenInfo: '0xabb1dc44', realQuoteReserve: '0x4f1f58fd' };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Loong (loongfamily.app) is a fork of the same stack on BNB Chain: the factory's launch record, the
 * token's getTokenInfo and the curve's reserves are byte-for-byte Genius's (checked against their
 * published ABIs and the deployed factory, 2026-09-28). Its factory only ever deploys tokens whose
 * address ends in 9999, so no other address is asked about. The address is hardcoded after checking
 * it on-chain: nothing of theirs (manifest, ABIs, scripts) is fetched at runtime.
 */
export const LOONG_FACTORY = '0x60dDcE270E1B9A8325daD4A39dB1442598b26B3A';

/** A launchpad built on the Genius stack: its chain, factory, where a token's page is, and what its addresses end in. */
export interface GeniusStack {
  launchpad: 'genius' | 'loong' | 'pons';
  network: string;
  factory: string;
  page: (address: string) => string;
  /** the chain's native coin, when a launch is paired against address(0) */
  native: string;
  /** where a graduated launch trades */
  venue: string;
  /** the factory refuses any other token address, so skip the call for anything else */
  suffix?: string;
}
export const GENIUS_STACK: GeniusStack = { launchpad: 'genius', network: 'bsc', factory: GENIUS_FACTORY, page: (a) => `https://genius.fun/token/${a}`, native: 'BNB', venue: 'PancakeSwap' };
export const LOONG_STACK: GeniusStack = { launchpad: 'loong', network: 'bsc', factory: LOONG_FACTORY, page: (a) => `https://loongfamily.app/#/token/${a}`, native: 'BNB', venue: 'PancakeSwap', suffix: '9999' };
/** Pons V2 (Robinhood Chain) is the stack Genius forked; which of its two factories launched a token comes from the token (see fetchPons). */
export const PONS_STACK: GeniusStack = { launchpad: 'pons', network: 'robinhood', factory: PONS_V2_FACTORIES[0], page: ponsPage, native: 'ETH', venue: 'Uniswap' };
export const PONS_STACKS: GeniusStack[] = PONS_V2_FACTORIES.map((factory) => ({ ...PONS_STACK, factory }));

/** Is this address one the stack's factory could have launched (right shape, right suffix)? */
export function geniusStackCandidate(stack: GeniusStack, address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && (!stack.suffix || address.toLowerCase().endsWith(stack.suffix));
}

/**
 * The label for an ERC-20 a launch is paired against, from that token's own symbol(). The pricer takes a
 * symbol reading as a dollar or a native coin at its word, so a token calling itself "USDC" or "WBNB"
 * only gets that label when its address really is one; otherwise it gets none and is not priced off it.
 */
export function curveQuoteLabel(network: string, address: string, symbol: string | undefined): string | undefined {
  const label = cleanLabel(symbol, 16);
  if (!label) return undefined;
  if ((isStable(label, undefined) || nativeRef(label)) && !knownQuote(network, address)) return undefined;
  return label;
}

/**
 * A token's name, symbol or quote ticker as a creator wrote it on-chain, made safe to show: control
 * characters and the invisible ones that flip or hide text (RTL overrides, zero-width marks) are
 * removed, and the length is capped. React already renders it as text; this stops look-alike tricks.
 */
export function cleanLabel(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const clean = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, '')
    // a pile of combining marks ("zalgo") spills over the card: at most two stay on any letter
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? [...clean].slice(0, max).join('') : undefined;
}

/** getTokenInfo is capped by the contract (logo 512, description 2048, socials 256 bytes each); anything this big is not that. */
const TOKEN_INFO_MAX_HEX = 32_768;

export interface GeniusLaunch {
  /** the token the record is for; must be the one asked about */
  token: string;
  curve: string;
  /** address(0) = native BNB */
  pairToken: string;
  graduationThreshold: bigint;
  /** 0 on the curve · 1 swept (graduating) · 2 pool live · 3 rescued */
  phase: 0 | 1 | 2 | 3;
}

/** getLaunchedToken's static struct: 15 words, `exists` last; undefined when the factory has no record. */
export function decodeGeniusLaunch(hex: string): GeniusLaunch | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 15) return undefined;
  const word = (i: number) => data.slice(i * 64, i * 64 + 64);
  if (BigInt('0x' + word(14)) !== 1n) return undefined;
  const phase = Number(BigInt('0x' + word(10)));
  if (phase < 0 || phase > 3) return undefined;
  return { token: '0x' + word(0).slice(24), curve: '0x' + word(1).slice(24), pairToken: '0x' + word(4).slice(24), graduationThreshold: BigInt('0x' + word(5)), phase: phase as 0 | 1 | 2 | 3 };
}

/** getTokenInfo(): (address deployer, string logo, string description, (string twitter, telegram, discord, website, farcaster)). */
export function decodeGeniusTokenInfo(hex: string): { logo: string; description: string; socials: string[] } | undefined {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 64 * 4) return undefined;
  const wordAt = (byteOff: number): number | undefined => {
    const h = data.slice(byteOff * 2, byteOff * 2 + 64);
    if (h.length < 64) return undefined;
    const n = parseInt(h, 16);
    return Number.isFinite(n) ? n : undefined;
  };
  const strAt = (byteOff: number): string | undefined => {
    const len = wordAt(byteOff);
    if (len === undefined) return undefined;
    const start = byteOff * 2 + 64;
    if (start + len * 2 > data.length) return undefined;
    return Buffer.from(data.slice(start, start + len * 2), 'hex').toString('utf8');
  };
  const [logoOff, descOff, socOff] = [wordAt(32), wordAt(64), wordAt(96)];
  if (logoOff === undefined || descOff === undefined || socOff === undefined) return undefined;
  const logo = strAt(logoOff);
  const description = strAt(descOff);
  if (logo === undefined || description === undefined) return undefined;
  const socials: string[] = [];
  for (let i = 0; i < 5; i++) {
    const rel = wordAt(socOff + i * 32);
    const s = rel === undefined ? undefined : strAt(socOff + rel);
    if (s === undefined) return undefined;
    socials.push(s);
  }
  return { logo, description, socials };
}

/** Where a launch stands, for the badge: on the curve with its progress, graduating, graduated, or rescued. */
export function geniusNote(launch: GeniusLaunch, realQuote: bigint | undefined, venue = 'PancakeSwap'): string {
  if (launch.phase === 1) return 'graduating';
  if (launch.phase === 2) return `graduated to ${venue}`;
  if (launch.phase === 3) return 'rescued (delisted)';
  if (realQuote === undefined || launch.graduationThreshold <= 0n) return 'on the curve';
  const pct = Number((realQuote * 1000n) / launch.graduationThreshold) / 10;
  return `on the curve · ${Math.min(100, pct).toFixed(1)}% to graduation`;
}

/** One factory call says whether the token is a launch of this stack; then the token's own metadata and the curve. */
export async function fetchGeniusStack(stack: GeniusStack, address: string, fetchImpl: typeof fetch = fetch, rpc = rpcUrl(stack.network) ?? BSC_RPC): Promise<LaunchpadInfo | undefined> {
  if (!geniusStackCandidate(stack, address)) return undefined;
  const rec = await ethCall(rpc, stack.factory, GENIUS_SEL.getLaunchedToken + address.slice(2).toLowerCase().padStart(64, '0'), fetchImpl).catch(() => undefined);
  const launch = rec ? decodeGeniusLaunch(rec) : undefined;
  // not a launch of this stack (or the factory did not answer), or a record for some other token
  if (!launch || launch.token.toLowerCase() !== address.toLowerCase()) return undefined;
  const native = launch.pairToken.toLowerCase() === ZERO_ADDRESS;
  const [info, name, symbol, real, pairSym] = await Promise.all([
    ethCall(rpc, address, GENIUS_SEL.getTokenInfo, fetchImpl).catch(() => undefined),
    ethCall(rpc, address, SEL.name, fetchImpl).catch(() => undefined),
    ethCall(rpc, address, SEL.symbol, fetchImpl).catch(() => undefined),
    launch.phase === 0 ? ethCall(rpc, launch.curve, GENIUS_SEL.realQuoteReserve, fetchImpl).catch(() => undefined) : undefined,
    native ? undefined : ethCall(rpc, launch.pairToken, SEL.symbol, fetchImpl).catch(() => undefined),
  ]);
  const out: LaunchpadInfo = { launchpad: stack.launchpad, launchpadUrl: stack.page(address), network: stack.network };
  const realQuote = real && real.length >= 66 ? BigInt(real.slice(0, 66)) : undefined;
  out.launchpadNote = geniusNote(launch, realQuote, stack.venue);
  // everything below is what the coin's creator typed: only web links and clean labels get through
  const meta = info && info.length <= TOKEN_INFO_MAX_HEX ? decodeGeniusTokenInfo(info) : undefined;
  applyCreatorFields(out, {
    name: name ? decodeStrings(name, 1)?.[0] : undefined,
    symbol: symbol ? decodeStrings(symbol, 1)?.[0] : undefined,
    image: meta?.logo,
    twitter: meta?.socials[0],
    telegram: meta?.socials[1],
    website: meta?.socials[3],
  });
  if (launch.phase === 0) {
    // still on the curve: that is its pool, and the live pricer reads getReserves off it like a Pons curve
    out.pairAddress = launch.curve;
    out.dex = stack.launchpad;
    if (native) out.quoteSymbol = stack.native;
    else {
      out.quoteAddress = launch.pairToken;
      const ps = curveQuoteLabel(stack.network, launch.pairToken, pairSym ? decodeStrings(pairSym, 1)?.[0] : undefined);
      if (ps) out.quoteSymbol = ps;
    }
  }
  return out;
}

export const fetchGenius = (address: string, fetchImpl: typeof fetch = fetch, rpc?: string) => fetchGeniusStack(GENIUS_STACK, address, fetchImpl, rpc);
export const fetchLoong = (address: string, fetchImpl: typeof fetch = fetch, rpc?: string) => fetchGeniusStack(LOONG_STACK, address, fetchImpl, rpc);
