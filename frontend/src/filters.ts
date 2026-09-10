import type { ColumnFilters } from './api';
import type { FeedMessage, TokenInfo } from './types';
import { normName } from './format';

const inRange = (v: number | undefined, min?: number, max?: number) => {
  if (min === undefined && max === undefined) return true;
  if (v === undefined) return false;
  return (min === undefined || v >= min) && (max === undefined || v <= max);
};
const nameIn = (list: string[] | undefined, name: string) => !!list?.length && list.some((n) => normName(n) === normName(name));

/** Is any filter set at all (drives the lit funnel icon)? */
export function filtersActive(f?: ColumnFilters): boolean {
  if (!f) return false;
  return Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : v !== undefined && v !== false));
}

/** Calls column: does this token pass? `callerOf` = the callers that count for it. */
export function tokenPasses(t: TokenInfo, f: ColumnFilters | undefined, now = Date.now()): boolean {
  if (!f) return true;
  const callers = t.calls.length ? t.calls.map((c) => c.author) : t.firstCaller ? [t.firstCaller.author] : [];
  if (f.showOnly?.length && !callers.some((a) => nameIn(f.showOnly, a))) return false;
  if (f.muted?.length && callers.length && callers.every((a) => nameIn(f.muted, a))) return false;
  if (f.chains?.length && !f.chains.includes(t.network ?? t.chain)) return false;
  if (f.launchpads?.length && !(t.launchpad && f.launchpads.includes(t.launchpad))) return false;
  for (const m of f.must ?? []) {
    if (m === 'website' && !t.website) return false;
    if (m === 'twitter' && !t.twitter) return false;
    if (m === 'telegram' && !t.telegram) return false;
    if (m === 'social' && !(t.website || t.twitter || t.telegram)) return false;
    if (m === 'image' && !t.imageUrl) return false;
    if (m === 'devSold' && !t.security?.devSold) return false;
    if (m === 'lpLocked' && !((t.security?.lpLockedPct ?? 0) >= 90)) return false;
  }
  const s = t.security;
  const mult = t.marketCap && t.firstCallMarketCap ? t.marketCap / t.firstCallMarketCap : undefined;
  const mcLiq = t.marketCap && t.liquidity ? t.marketCap / t.liquidity : undefined;
  const ageMin = t.pairCreatedAt ? (now - t.pairCreatedAt) / 60_000 : undefined;
  return (
    inRange(t.marketCap, f.mcMin, f.mcMax) &&
    inRange(t.liquidity, f.liqMin, f.liqMax) &&
    inRange(t.volume24h, f.volMin, f.volMax) &&
    inRange(mcLiq, f.mcLiqMin, f.mcLiqMax) &&
    inRange(mult, f.multMin, f.multMax) &&
    inRange(s?.holders, f.holdersMin, f.holdersMax) &&
    inRange(ageMin, f.ageMin, f.ageMax) &&
    inRange((t.buys24h ?? 0) + (t.sells24h ?? 0) || undefined, f.txMin, f.txMax) &&
    inRange(t.buys24h, f.buysMin, f.buysMax) &&
    inRange(t.sells24h, f.sellsMin, f.sellsMax) &&
    inRange(s?.top10Pct, f.top10Min, f.top10Max) &&
    inRange(s?.snipersPct, f.snipersMin, f.snipersMax) &&
    inRange(s?.insidersPct, f.insidersMin, f.insidersMax) &&
    inRange(s?.bundlersPct, f.bundlersMin, f.bundlersMax) &&
    inRange(s?.devPct, f.devMin, f.devMax) &&
    inRange(t.seen, f.callsMin, f.callsMax)
  );
}

/** Chat column: does this message pass? */
export function messagePasses(m: FeedMessage, f: ColumnFilters | undefined): boolean {
  if (!f) return true;
  if (f.excludeBots && m.isBot) return false;
  if (f.contractsOnly && m.contracts.length === 0) return false;
  if (f.showOnly?.length && !nameIn(f.showOnly, m.author)) return false;
  if (f.muted?.length && nameIn(f.muted, m.author)) return false;
  if (f.search?.trim()) {
    const q = f.search.trim().toLowerCase();
    if (!m.text.toLowerCase().includes(q) && !m.author.toLowerCase().includes(q)) return false;
  }
  return true;
}
