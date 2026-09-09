import type { Chain, TokenInfo } from './types.js';

/**
 * Launchpad classification, ported from frogr's per-launchpad probes.
 * Each probe answers "is this token yours?" independently and returns what it
 * knows (image, socials, name). Results fill gaps in the chart-site data, and
 * the launchpad itself becomes a badge on the card.
 */

export type Launchpad = 'pumpfun' | 'letsbonk' | 'bankr' | 'stonks' | 'pons' | 'o1';

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
  if (/^https?:\/\//i.test(s)) return s;
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
  const bare = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? `https://x.com/${bare}` : undefined;
}

function tgUrl(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
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
  o1?: (a: string) => Promise<LaunchpadInfo | undefined>;
  log?: (m: string) => void;
}

/** First launchpad that claims the token wins. Solana is decided by suffix alone. */
export function createLaunchpadClassifier(p: LaunchpadProbes): (address: string, chain: Chain) => Promise<LaunchpadInfo | undefined> {
  const log = p.log ?? ((m: string) => console.warn('[launchpad]', m));
  return async (address, chain) => {
    const bySuffix = classifyBySuffix(address, chain);
    if (bySuffix) return bySuffix;
    if (chain !== 'evm') return undefined;
    for (const [name, probe] of [
      ['bankr', p.bankr],
      ['stonks', p.stonks],
      ['pons', p.pons],
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
