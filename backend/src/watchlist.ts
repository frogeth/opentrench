import type { WatchAlertHit, WatchAlerts } from './types.js';
import { compactUsd } from './vampy/normalize.js';

const HOUR_MS = 60 * 60_000;
/** one sample per this long: the 3s live ticks would otherwise fill the ring for nothing */
const SAMPLE_GAP_MS = 25_000;
/** kept a little past the hour so "an hour ago" always has a sample to land on */
const KEEP_MS = 65 * 60_000;
/** the oldest sample must be at least this old before the ring answers for "1h" */
const SPAN_MS = 55 * 60_000;
/** a price older than this is not trusted to fire an alert */
const STALE_MS = 2 * 60_000;
/** re-arm margins: a token hovering right at a line must not fire again and again */
const REARM_ABOVE = 0.97;
const REARM_BELOW = 1.03;

type Sample = { ts: number; mc: number };

/**
 * Market caps of watched tokens over the last hour, sampled from whatever prices them (live pools or the
 * API), so the 1h change and the move alert read the same numbers. In memory only: after a restart the
 * API's own 1h figure stands in until an hour has been seen again.
 */
export class MarketHistory {
  private rings = new Map<string, Sample[]>();

  add(address: string, marketCap: number | undefined, ts: number): void {
    if (typeof marketCap !== 'number' || !Number.isFinite(marketCap) || marketCap <= 0) return;
    let ring = this.rings.get(address);
    if (!ring) this.rings.set(address, (ring = []));
    const last = ring[ring.length - 1];
    if (last && ts - last.ts < SAMPLE_GAP_MS) return;
    ring.push({ ts, mc: marketCap });
    while (ring.length && ring[0].ts < ts - KEEP_MS) ring.shift();
  }

  /** Percent change against the sample nearest an hour ago; undefined until the ring spans the hour. */
  change1h(address: string, now: number): number | undefined {
    const ring = this.rings.get(address);
    if (!ring || ring.length < 2 || now - ring[0].ts < SPAN_MS) return undefined;
    const target = now - HOUR_MS;
    let base = ring[0];
    for (const s of ring) if (Math.abs(s.ts - target) < Math.abs(base.ts - target)) base = s;
    const latest = ring[ring.length - 1];
    return (latest.mc / base.mc - 1) * 100;
  }

  size(address: string): number {
    return this.rings.get(address)?.length ?? 0;
  }

  drop(address: string): void {
    this.rings.delete(address);
  }
}

export type AlertKind = 'above' | 'below' | 'move';
export type Fired = NonNullable<WatchAlerts['fired']>;
export interface MarketNow {
  marketCap?: number;
  change1h?: number;
  priceAt?: number;
}

/**
 * Which alerts go off now, and the fired state to keep. Each fires once and re-arms only after the market
 * cap is back past the line by a margin (3% for caps, half the move for the 1h move). A stale or missing
 * price changes nothing.
 */
export function checkAlerts(alerts: WatchAlerts, m: MarketNow, now: number): { hits: { kind: AlertKind; threshold: number }[]; fired: Fired } {
  const fired: Fired = { ...alerts.fired };
  const hits: { kind: AlertKind; threshold: number }[] = [];
  const mc = m.marketCap;
  if (mc === undefined || !Number.isFinite(mc) || m.priceAt === undefined || now - m.priceAt > STALE_MS) return { hits, fired };
  const step = (kind: AlertKind, threshold: number | undefined, met: boolean, rearm: boolean) => {
    if (threshold === undefined) return;
    if (!fired[kind] && met) {
      fired[kind] = true;
      hits.push({ kind, threshold });
    } else if (fired[kind] && rearm) delete fired[kind];
  };
  step('above', alerts.above, alerts.above !== undefined && mc >= alerts.above, alerts.above !== undefined && mc < alerts.above * REARM_ABOVE);
  step('below', alerts.below, alerts.below !== undefined && mc <= alerts.below, alerts.below !== undefined && mc > alerts.below * REARM_BELOW);
  if (m.change1h !== undefined && Number.isFinite(m.change1h)) {
    const move = Math.abs(m.change1h);
    step('move', alerts.movePct, alerts.movePct !== undefined && move >= alerts.movePct, alerts.movePct !== undefined && move < alerts.movePct / 2);
  }
  return { hits, fired };
}

/** Fired state for freshly set alerts: one whose condition already holds starts fired, so it waits for the next crossing. */
export function initialFired(alerts: WatchAlerts, marketCap: number | undefined, change1h?: number): Fired {
  const fired: Fired = {};
  if (marketCap !== undefined) {
    if (alerts.above !== undefined && marketCap >= alerts.above) fired.above = true;
    if (alerts.below !== undefined && marketCap <= alerts.below) fired.below = true;
  }
  if (alerts.movePct !== undefined && change1h !== undefined && Math.abs(change1h) >= alerts.movePct) fired.move = true;
  return fired;
}

/** "$PEPE crossed above $1.2M (+38% 1h)" — the line a watchlist alert shows in pings and on Telegram. */
export function alertText(hit: WatchAlertHit): string {
  const name = hit.symbol ? `$${hit.symbol}` : `${hit.address.slice(0, 6)}…`;
  const pct = hit.pct !== undefined && Number.isFinite(hit.pct) ? `${hit.pct >= 0 ? '+' : ''}${Math.round(hit.pct)}% 1h` : undefined;
  if (hit.kind === 'move') return `${name} moved ${pct ?? `${hit.threshold}%`} (${compactUsd(hit.marketCap)})`;
  return `${name} crossed ${hit.kind} ${compactUsd(hit.threshold)}${pct ? ` (${pct})` : ''}`;
}
