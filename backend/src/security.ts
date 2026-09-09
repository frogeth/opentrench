import type { TokenSecurity } from './types.js';

/**
 * Holder security: who holds the supply. GoPlus for EVM chains, RugCheck for
 * Solana. Both are free, keyless, and rate-limited; results are cached by the hub.
 */

const TIMEOUT_MS = 8000;

/** dexscreener network id → GoPlus chain id */
export const GOPLUS_CHAINS: Record<string, string> = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
  arbitrum: '42161',
  optimism: '10',
  polygon: '137',
  avalanche: '43114',
  blast: '81457',
  zksync: '324',
  linea: '59144',
  scroll: '534352',
};

const pct = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 1000) / 10 : undefined;
};

/** GoPlus token_security result for one address (percent fields are 0..1 strings). */
export function mapGoPlus(r: any, now = Date.now()): TokenSecurity | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const holders: any[] = Array.isArray(r.holders) ? r.holders : [];
  // pools / lockers are contracts: they are not "holders" in the sense the strip cares about
  const top = holders.filter((h) => String(h.is_contract) !== '1' && String(h.is_locked) !== '1').slice(0, 10);
  const top10 = top.reduce((s, h) => s + (Number(h.percent) || 0), 0);
  const devPct = pct(r.creator_percent) ?? pct(r.owner_percent);
  const holderCount = Number(r.holder_count);
  const lp: any[] = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const lpLocked = lp.filter((h) => String(h.is_locked) === '1').reduce((s, h) => s + (Number(h.percent) || 0), 0);
  const out: TokenSecurity = {
    source: 'goplus',
    fetchedAt: now,
    holders: Number.isFinite(holderCount) ? holderCount : undefined,
    top10Pct: holders.length ? Math.round(top10 * 1000) / 10 : undefined,
    devPct,
    devSold: devPct !== undefined ? devPct === 0 : undefined,
    lpLockedPct: lp.length ? Math.round(lpLocked * 1000) / 10 : undefined,
    buyTax: pct(r.buy_tax),
    sellTax: pct(r.sell_tax),
    honeypot: r.is_honeypot === undefined ? undefined : String(r.is_honeypot) === '1',
  };
  for (const k of Object.keys(out) as (keyof TokenSecurity)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** RugCheck full report (pct fields are already 0..100). */
export function mapRugCheck(r: any, now = Date.now()): TokenSecurity | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const known: Record<string, any> = r.knownAccounts ?? {};
  const isPool = (addr: string) => /amm|pool|lp|raydium|orca|meteora|pump/i.test(String(known[addr]?.type ?? known[addr]?.name ?? ''));
  const holders: any[] = Array.isArray(r.topHolders) ? r.topHolders : [];
  const real = holders.filter((h) => !isPool(String(h.address ?? h.owner ?? '')));
  const top10 = real.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  const insiders = real.filter((h) => h.insider).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  const supply = Number(r.token?.supply);
  const creatorBal = Number(r.creatorBalance);
  const devPct = supply > 0 && Number.isFinite(creatorBal) ? Math.round((creatorBal / supply) * 1000) / 10 : undefined;
  const out: TokenSecurity = {
    source: 'rugcheck',
    fetchedAt: now,
    holders: Number.isFinite(Number(r.totalHolders)) ? Number(r.totalHolders) : undefined,
    top10Pct: holders.length ? Math.round(top10 * 10) / 10 : undefined,
    devPct,
    devSold: devPct !== undefined ? devPct === 0 : undefined,
    insidersPct: holders.length ? Math.round(insiders * 10) / 10 : undefined,
    lpLockedPct: r.markets?.[0]?.lp?.lpLockedPct !== undefined ? Math.round(Number(r.markets[0].lp.lpLockedPct) * 10) / 10 : undefined,
    mintable: r.mintAuthority ? true : r.mintAuthority === null ? false : undefined,
    freezable: r.freezeAuthority ? true : r.freezeAuthority === null ? false : undefined,
    score: Number.isFinite(Number(r.score_normalised)) ? Number(r.score_normalised) : undefined,
  };
  for (const k of Object.keys(out) as (keyof TokenSecurity)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export type SecurityFetcher = (network: string, address: string) => Promise<TokenSecurity | undefined>;

export function createSecurityFetcher(fetchImpl: typeof fetch = fetch): SecurityFetcher {
  const get = async (url: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'opentrench/1.0' } });
      if (!res.ok) return undefined;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };
  return async (network, address) => {
    if (network === 'solana') {
      const json = await get(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report`);
      return mapRugCheck(json);
    }
    const chain = GOPLUS_CHAINS[network];
    if (!chain) return undefined;
    const json = await get(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${address.toLowerCase()}`);
    return mapGoPlus(json?.result?.[address.toLowerCase()]);
  };
}
