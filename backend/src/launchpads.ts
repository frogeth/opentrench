import type { Chain, TokenInfo } from './types.js';

/**
 * Launchpad classification, ported from frogr's per-launchpad probes.
 * Each probe answers "is this token yours?" independently and returns what it
 * knows (image, socials, name). Results fill gaps in the chart-site data, and
 * the launchpad itself becomes a badge on the card.
 */

export type Launchpad = 'pumpfun' | 'letsbonk' | 'bankr' | 'stonks' | 'pons' | 'o1' | 'virtuals' | 'flap' | 'clanker' | 'long' | 'argus' | 'warp' | 'peach' | 'dyor' | 'synthra';

export interface LaunchpadInfo extends Partial<TokenInfo> {
  launchpad: Launchpad;
  launchpadUrl: string;
}

const TIMEOUT_MS = 7000;

async function getJson(url: string, fetchImpl: typeof fetch, headers: Record<string, string> = {}): Promise<any | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', ...headers } });
    if (!res.ok) return undefined;
    return await res.json();
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

function xUrl(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  // "x.com/name" or "twitter.com/name" typed without the scheme
  if (/^(?:www\.)?(?:x|twitter)\.com\//i.test(s)) return `https://${s}`;
  const bare = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? `https://x.com/${bare}` : undefined;
}

function tgUrl(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  // "t.me/name" typed without the scheme
  if (/^t\.me\//i.test(s)) return `https://${s}`;
  const bare = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{3,}$/.test(bare) ? `https://t.me/${bare}` : undefined;
}

// ---------- Solana launchpads: the mint address says it all ----------

export function classifyBySuffix(address: string, chain: Chain): LaunchpadInfo | undefined {
  if (chain !== 'sol') return undefined;
  if (address.endsWith('pump')) return { launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${address}` };
  if (address.endsWith('bonk')) return { launchpad: 'letsbonk', launchpadUrl: `https://letsbonk.fun/token/${address}` };
  return undefined;
}

// ---------- pump.fun (Solana): frontend API, works before any DEX pair ----------

export function mapPumpfun(c: any): LaunchpadInfo | undefined {
  if (!c?.mint) return undefined;
  const out: LaunchpadInfo = { launchpad: 'pumpfun', launchpadUrl: `https://pump.fun/coin/${c.mint}`, network: 'solana', quoteSymbol: 'SOL', dex: 'pump.fun' };
  if (c.name) out.name = String(c.name);
  if (c.symbol) out.symbol = String(c.symbol);
  const img = ipfsToHttp(c.image_uri);
  if (img) out.imageUrl = img;
  const mc = Number(c.usd_market_cap);
  if (Number.isFinite(mc) && mc > 0) out.marketCap = mc;
  // the bonding curve account is the "pool" while the token is on the curve: it is what the live pricer reads
  if (typeof c.bonding_curve === 'string' && c.bonding_curve) out.pairAddress = c.bonding_curve;
  const created = Number(c.created_timestamp);
  if (Number.isFinite(created) && created > 0) out.pairCreatedAt = created;
  const x = xUrl(c.twitter);
  if (x) out.twitter = x;
  const tg = tgUrl(c.telegram);
  if (tg) out.telegram = tg;
  if (c.website) out.website = String(c.website);
  return out;
}

export async function fetchPumpfun(mint: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  const json = await getJson(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`, fetchImpl, {
    'user-agent': 'Mozilla/5.0 (trenchfeed)',
  });
  return json ? mapPumpfun(json) : undefined;
}

// ---------- Virtuals (Base / Solana / Robinhood): agent API ----------

const VIRTUALS_API = 'https://api.virtuals.io/api/virtuals';

export function mapVirtuals(v: any, address: string): LaunchpadInfo | undefined {
  if (!v?.id) return undefined;
  const chain = String(v.chain ?? 'BASE').toUpperCase();
  const network = chain === 'SOLANA' ? 'solana' : chain === 'ROBINHOOD' ? 'robinhood' : 'base';
  const ref = v.symbol ? String(v.symbol).toLowerCase() : String(v.id);
  const out: LaunchpadInfo = { launchpad: 'virtuals', launchpadUrl: `https://app.virtuals.io/virtuals/${ref}`, network };
  if (v.name) out.name = String(v.name);
  if (v.symbol) out.symbol = String(v.symbol);
  if (v.image?.url) out.imageUrl = String(v.image.url);
  const s = v.socials ?? {};
  const tw = s.VERIFIED_LINKS?.TWITTER ?? s.x ?? s.TWITTER ?? (s.VERIFIED_USERNAMES?.TWITTER ? `https://x.com/${s.VERIFIED_USERNAMES.TWITTER}` : undefined);
  const x = xUrl(tw);
  if (x) out.twitter = x;
  const web = s.VERIFIED_LINKS?.WEBSITE ?? s.website ?? s.WEBSITE;
  if (web) out.website = String(web);
  const tg = tgUrl(s.VERIFIED_LINKS?.TELEGRAM ?? s.telegram ?? s.TELEGRAM);
  if (tg) out.telegram = tg;
  const lp = v.lpCreatedAt ? Date.parse(String(v.lpCreatedAt)) : NaN;
  if (Number.isFinite(lp)) out.pairCreatedAt = lp;
  void address;
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

// ---------- Flap (Robinhood + BNB): metaURI() on the token, JSON on IPFS ----------

export const BSC_RPC = 'https://bsc-dataseed.binance.org';
const FLAP_SEL = { metaURI: '0x67605787' };
const FLAP_GATEWAYS = ['https://flap.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

export function mapFlap(meta: any, network: string, address: string): LaunchpadInfo {
  const out: LaunchpadInfo = { launchpad: 'flap', launchpadUrl: `https://flap.sh/token/${address.toLowerCase()}`, network };
  const img = ipfsToHttp(meta?.image);
  if (img) out.imageUrl = img;
  const x = xUrl(meta?.twitter);
  if (x) out.twitter = x;
  const tg = tgUrl(meta?.telegram);
  if (tg) out.telegram = tg;
  if (meta?.website) out.website = String(meta.website);
  if (meta?.name) out.name = String(meta.name);
  if (meta?.symbol) out.symbol = String(meta.symbol);
  return out;
}

export async function fetchFlap(address: string, fetchImpl: typeof fetch = fetch, rpcs: [string, string][] = [['robinhood', ROBINHOOD_RPC], ['bsc', BSC_RPC]]): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  for (const [network, rpc] of rpcs) {
    const res = await ethCall(rpc, address, FLAP_SEL.metaURI, fetchImpl).catch(() => undefined);
    const uri = res ? decodeStrings(res, 1)?.[0] : undefined;
    if (!uri) continue;
    const cid = uri.trim().replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
    let meta: any;
    for (const gw of FLAP_GATEWAYS) {
      meta = await getJson(gw + cid, fetchImpl).catch(() => undefined);
      if (meta) break;
    }
    return mapFlap(meta ?? {}, network, address);
  }
  return undefined;
}

// ---------- Clanker (Base / Robinhood / BNB): search endpoint, best effort ----------

const CLANKER_CHAINS: Record<number, string> = { 8453: 'base', 4663: 'robinhood', 56: 'bsc' };

export function mapClanker(json: any, address: string): LaunchpadInfo | undefined {
  const list: any[] = Array.isArray(json?.data) ? json.data : [];
  const d = list.find((t) => String(t?.contract_address ?? '').toLowerCase() === address.toLowerCase());
  if (!d) return undefined;
  const out: LaunchpadInfo = {
    launchpad: 'clanker',
    launchpadUrl: `https://www.clanker.world/clanker/${address.toLowerCase()}`,
    network: CLANKER_CHAINS[Number(d.chain_id ?? 8453)] ?? 'base',
  };
  if (d.name) out.name = String(d.name);
  if (d.symbol) out.symbol = String(d.symbol);
  const img = d.img_url ?? d.image ?? d.metadata?.image;
  if (img) out.imageUrl = ipfsToHttp(String(img));
  for (const sl of d.socialLinks ?? []) {
    const n = String(sl?.name ?? '').toLowerCase();
    if (!sl?.link) continue;
    if (n === 'website' && !out.website) out.website = String(sl.link);
    if ((n === 'twitter' || n === 'x') && !out.twitter) out.twitter = String(sl.link);
    if (n === 'telegram' && !out.telegram) out.telegram = String(sl.link);
  }
  const created = d.created_at ? Date.parse(String(d.created_at)) : NaN;
  if (Number.isFinite(created)) out.pairCreatedAt = created;
  return out;
}

export async function fetchClanker(address: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  const json = await getJson(`https://www.clanker.world/api/tokens/search?q=${encodeURIComponent(address)}`, fetchImpl, {
    'user-agent': 'Mozilla/5.0 (trenchfeed)',
  });
  return json ? mapClanker(json, address) : undefined;
}

// ---------- Bankr (Base + Robinhood) ----------

export function mapBankrLaunch(json: any, address: string): LaunchpadInfo | undefined {
  const l = json?.launch ?? json;
  if (!l || typeof l !== 'object' || !l.tokenAddress) return undefined;
  const out: LaunchpadInfo = { launchpad: 'bankr', launchpadUrl: `https://bankr.bot/launches/${address.toLowerCase()}` };
  if (l.tokenName) out.name = String(l.tokenName);
  if (l.tokenSymbol) out.symbol = String(l.tokenSymbol);
  if (l.chain) out.network = String(l.chain).toLowerCase() === 'robinhood' ? 'robinhood' : 'base';
  if (l.websiteUrl) out.website = String(l.websiteUrl);
  const x = l.deployer?.xUsername ?? l.feeRecipient?.xUsername;
  if (x) out.twitter = `https://x.com/${String(x).replace(/^@/, '')}`;
  const img = ipfsToHttp(l.imageUri);
  if (img) out.imageUrl = img;
  return out;
}

export async function fetchBankrLaunch(address: string, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  const json = await getJson(`https://api.bankr.bot/token-launches/${encodeURIComponent(address)}`, fetchImpl);
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
  if (c.name) out.name = String(c.name);
  if (c.symbol) out.symbol = String(c.symbol);
  if (c.image) out.imageUrl = ipfsToHttp(String(c.image));
  if (c.website) out.website = String(c.website);
  const x = xUrl(c.twitter);
  if (x) out.twitter = x;
  const tg = tgUrl(c.telegram);
  if (tg) out.telegram = tg;
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

async function ethCall(rpc: string, to: string, data: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (!res.ok) return undefined;
    const json: any = await res.json();
    const r = json?.result;
    return typeof r === 'string' && r.length > 2 ? r : undefined;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchPons(address: string, fetchImpl: typeof fetch = fetch, rpc = ROBINHOOD_RPC): Promise<LaunchpadInfo | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const socials = await ethCall(rpc, address, SEL.socials, fetchImpl).catch(() => undefined);
  const fields = socials ? decodeStrings(socials, 5) : undefined;
  if (!fields) return undefined; // socials() reverts → not a Pons token
  const [twitter, telegram, , website] = fields;
  const out: LaunchpadInfo = { launchpad: 'pons', launchpadUrl: 'https://www.ponsfamily.com/launchpad', network: 'robinhood' };
  const x = xUrl(twitter);
  if (x) out.twitter = x;
  const tg = tgUrl(telegram);
  if (tg) out.telegram = tg;
  if (website?.trim()) out.website = website.trim();
  const [logo, name, symbol] = await Promise.all(
    [SEL.logo, SEL.name, SEL.symbol].map((s) => ethCall(rpc, address, s, fetchImpl).catch(() => undefined)),
  );
  const logoStr = logo ? decodeStrings(logo, 1)?.[0] : undefined;
  const img = ipfsToHttp(logoStr);
  if (img) out.imageUrl = img;
  const nameStr = name ? decodeStrings(name, 1)?.[0] : undefined;
  if (nameStr) out.name = nameStr;
  const symStr = symbol ? decodeStrings(symbol, 1)?.[0] : undefined;
  if (symStr) out.symbol = symStr;
  return out;
}

// ---------- o1 (Base + Robinhood): keyed API ----------

const O1_API = 'https://api.launch.o1.exchange/v1';
const O1_CHAINS: [number, string][] = [
  [8453, 'base'],
  [4663, 'robinhood'],
  // docs.o1.exchange/launchpad/api: Monad and Arc mainnet joined the list
  [143, 'monad'],
  [5042, 'arc'],
];

export async function fetchO1(address: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<LaunchpadInfo | undefined> {
  if (!apiKey || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const hits = await Promise.all(
    O1_CHAINS.map(async ([id, network]) => {
      const json = await getJson(`${O1_API}/tokens/${id}/${address.toLowerCase()}`, fetchImpl, { 'x-api-key': apiKey }).catch(() => undefined);
      return json?.data?.token ? { network, t: json.data.token } : undefined;
    }),
  );
  const hit = hits.find(Boolean);
  if (!hit) return undefined;
  const out: LaunchpadInfo = { launchpad: 'o1', launchpadUrl: 'https://launch.o1.exchange', network: hit.network };
  if (hit.t.name) out.name = String(hit.t.name);
  if (hit.t.symbol) out.symbol = String(hit.t.symbol);
  if (hit.t.image_url) out.imageUrl = String(hit.t.image_url);
  if (hit.t.website) out.website = String(hit.t.website);
  const x = xUrl(hit.t.x);
  if (x) out.twitter = x;
  const tg = tgUrl(hit.t.telegram);
  if (tg) out.telegram = tg;
  return out;
}

// ---------- orchestrator ----------

export interface LaunchpadProbes {
  bankr?: (a: string) => Promise<LaunchpadInfo | undefined>;
  stonks?: (a: string) => Promise<LaunchpadInfo | undefined>;
  pons?: (a: string) => Promise<LaunchpadInfo | undefined>;
  flap?: (a: string) => Promise<LaunchpadInfo | undefined>;
  virtuals?: (a: string) => Promise<LaunchpadInfo | undefined>;
  clanker?: (a: string) => Promise<LaunchpadInfo | undefined>;
  o1?: (a: string) => Promise<LaunchpadInfo | undefined>;
  pumpfun?: (a: string) => Promise<LaunchpadInfo | undefined>;
  /** Long (Robinhood Chain): cheap, it only asks for the `1e18` suffix */
  argus?: (address: string) => Promise<LaunchpadInfo | undefined>;
  warp?: (address: string) => Promise<LaunchpadInfo | undefined>;
  peach?: (address: string) => Promise<LaunchpadInfo | undefined>;
  dyor?: (address: string) => Promise<LaunchpadInfo | undefined>;
  synthra?: (address: string) => Promise<LaunchpadInfo | undefined>;
  long?: (a: string) => Promise<LaunchpadInfo | undefined>;
  log?: (m: string) => void;
}

/**
 * First launchpad that claims the token wins. Solana: pump.fun mints (suffix)
 * get the pump.fun API for image/mcap; letsbonk by suffix. EVM: probes in order.
 */
export function createLaunchpadClassifier(p: LaunchpadProbes): (address: string, chain: Chain) => Promise<LaunchpadInfo | undefined> {
  const log = p.log ?? ((m: string) => console.warn('[launchpad]', m));
  return async (address, chain) => {
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
      ['flap', p.flap],
      ['virtuals', p.virtuals],
      ['clanker', p.clanker],
      ['o1', p.o1],
    ] as const) {
      if (!probe) continue;
      try {
        const hit = await probe(address);
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

async function rpcBatch(rpc: string, calls: { method: string; params: unknown[] }[], fetchImpl: typeof fetch): Promise<any[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))), signal: ctl.signal });
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return calls.map((_, id) => json.find((r: any) => Number(r?.id) === id));
  } finally {
    clearTimeout(t);
  }
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
      if (log?.data) {
        // data: (string name, string symbol, bytes32 poolId, string imageURI, string website, string twitter, string telegram)
        const strings = decodeDynamicStrings(String(log.data), [0, 1, 3, 4, 5, 6]);
        if (strings) {
          const [name, symbol, image, website, twitter, telegram] = strings;
          if (name) out.name = name;
          if (symbol) out.symbol = symbol;
          const img = ipfsToHttp(image);
          if (img) out.imageUrl = img;
          if (website?.trim()) out.website = website.trim();
          const x = xUrl(twitter);
          if (x) out.twitter = x;
          const tg = tgUrl(telegram);
          if (tg) out.telegram = tg;
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
  if (d.name) out.name = String(d.name);
  if (d.ticker) out.symbol = String(d.ticker);
  const img = ipfsToHttp(d.image ? String(d.image) : undefined);
  if (img) out.imageUrl = img;
  const x = xUrl(d.twitter ? String(d.twitter) : undefined);
  if (x) out.twitter = x;
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
  if (d.name) out.name = String(d.name);
  if (d.symbol) out.symbol = String(d.symbol);
  const img = ipfsToHttp(d.image_url ? String(d.image_url) : d.image_uri ? String(d.image_uri) : undefined);
  if (img) out.imageUrl = img;
  const x = xUrl(d.x ? String(d.x) : d.twitter ? String(d.twitter) : undefined);
  if (x) out.twitter = x;
  if (d.website) out.website = String(d.website);
  const tg = tgUrl(d.telegram ? String(d.telegram) : undefined);
  if (tg) out.telegram = tg;
  const price = num(d.price_usd), mcap = num(d.market_cap_usd), liq = num(d.liquidity_usd), vol = num(d.volume_24h_usd), chg = num(d.price_change_24h), created = num(d.created_at);
  if (price !== undefined && price > 0) out.priceUsd = price;
  if (mcap !== undefined) out.marketCap = mcap;
  if (liq !== undefined) out.liquidity = liq;
  if (vol !== undefined) out.volume24h = vol;
  if (chg !== undefined) out.change24h = chg;
  if (created) out.pairCreatedAt = created * 1000;
  const status = String(d.status ?? '').toUpperCase();
  const progress = num(d.progress);
  out.launchpadNote = status === 'GRADUATED' ? 'graduated' : progress !== undefined ? `bonding · ${Math.round(progress)}%` : status ? status.toLowerCase() : 'bonding';
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
  if (t.name) out.name = String(t.name);
  if (t.symbol) out.symbol = String(t.symbol);
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
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SYNTHRA_TOKEN_QUERY, variables: { id: address.toLowerCase() } }), signal: ctl.signal });
    if (!res.ok) return undefined;
    const json = await res.json();
    return json?.data?.token ?? undefined;
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
    if (t.metadataURI) {
      const meta = await getJson(`${api}/metadata/${encodeURIComponent(String(t.metadataURI))}`, fetchImpl).catch(() => undefined);
      const d = meta?.data;
      if (d) {
        const img = d.image?.thumb ?? d.image?.full;
        if (img) out.imageUrl = String(img);
        const soc = d.socials ?? {};
        const x = xUrl(soc.x ?? soc.twitter);
        if (x) out.twitter = x;
        const tg = tgUrl(soc.telegram);
        if (tg) out.telegram = tg;
        if (soc.website) out.website = String(soc.website);
      }
    }
    return out;
  }
  return undefined;
}
