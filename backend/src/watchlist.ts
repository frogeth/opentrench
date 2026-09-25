import type { ServerEvent, TokenInfo, WatchAlertHit, WatchAlerts, WatchEntry } from './types.js';
import type { ConfigStore } from './config.js';
import { WATCHLIST_MAX, sanitizeWatchAlerts } from './config.js';
import { detectContracts } from './contracts.js';
import type { MessageHub } from './hub.js';
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

// ---------- the service: the list itself, prices for it, and its alerts ----------

export interface WatchlistDeps {
  cfg: ConfigStore;
  hub: MessageHub;
  /** DM yourself on Telegram (undefined or a no-op when not connected) */
  sendSelf?: (text: string) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  /** boot-time adoption: tokens asked about per step, and the pause between steps */
  bootBatch?: number;
  bootGapMs?: number;
}

/**
 * Owns the watchlist: add/remove/alerts (saved in config, broadcast as a `watchlist` event), keeps
 * watched tokens in the hub, samples their market caps for the 1h change, and fires their alerts.
 */
export class WatchlistService {
  readonly history = new MarketHistory();
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly onEvent = (ev: ServerEvent) => {
    if (ev.type === 'token') this.observe(ev.token);
  };

  constructor(private readonly deps: WatchlistDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.warn('[watchlist]', m));
  }

  entries(): WatchEntry[] {
    return this.deps.cfg.get().watchlist;
  }

  private entry(address: string): WatchEntry | undefined {
    return this.entries().find((e) => e.address === address);
  }

  /** Watched tokens the hub holds, for the pricing loops. */
  tokens(): TokenInfo[] {
    const out: TokenInfo[] = [];
    for (const e of this.entries()) {
      const t = this.deps.hub.getToken(e.address);
      if (t) out.push(t);
    }
    return out;
  }

  /** True once our own samples answer for the 1h change, so an API's 1h figure must not overwrite it. */
  ownsChange1h(address: string): boolean {
    return this.history.change1h(address, this.now()) !== undefined;
  }

  /** Listen for token updates and put every watched token the hub lacks (after a restart) back in it, a few at a time. */
  start(): void {
    this.deps.hub.on('event', this.onEvent);
    const missing = this.entries().filter((e) => !this.deps.hub.getToken(e.address));
    const batch = this.deps.bootBatch ?? 4;
    const step = (i: number) => {
      for (const e of missing.slice(i, i + batch)) this.deps.hub.adopt(bareToken(e));
      if (i + batch < missing.length) setTimeout(() => step(i + batch), this.deps.bootGapMs ?? 1000).unref?.();
    };
    if (missing.length) step(0);
  }

  stop(): void {
    this.deps.hub.off('event', this.onEvent);
  }

  /** Add every contract found in `raws`; the rest come back as rejected. */
  async add(raws: string[]): Promise<{ added: string[]; rejected: string[] }> {
    const rejected: string[] = [];
    const want: { address: string; chain: WatchEntry['chain'] }[] = [];
    for (const raw of raws) {
      const found = detectContracts(String(raw ?? ''));
      if (!found.length) rejected.push(String(raw));
      for (const c of found) if (!want.some((w) => w.address === c.address)) want.push(c);
    }
    const fresh = want.filter((c) => !this.entry(c.address));
    const room = Math.max(0, WATCHLIST_MAX - this.entries().length);
    for (const c of fresh.slice(room)) rejected.push(c.address);
    const take = fresh.slice(0, room);
    const infos = await Promise.all(take.map((c) => this.deps.hub.lookup(c.address).catch(() => undefined)));
    const now = this.now();
    const added: WatchEntry[] = take.map((c, i) => {
      const info = infos[i];
      const e: WatchEntry = { address: c.address, chain: c.chain, addedAt: now };
      if (info?.network) e.network = info.network;
      if (info?.marketCap) e.addedMarketCap = info.marketCap;
      return e;
    });
    if (added.length) {
      // newest first; an add that raced another (same address) is kept once
      this.deps.cfg.update((cfg) => {
        const have = new Set(cfg.watchlist.map((e) => e.address));
        cfg.watchlist = [...added.filter((e) => !have.has(e.address)), ...cfg.watchlist].slice(0, WATCHLIST_MAX);
      });
      take.forEach((c, i) => this.deps.hub.adopt(infos[i] ?? bareToken({ address: c.address, chain: c.chain, addedAt: now })));
      this.broadcast();
    }
    return { added: added.map((e) => e.address), rejected };
  }

  remove(addresses: string[]): void {
    const gone = new Set(addresses.map((a) => detectContracts(String(a))[0]?.address ?? String(a)));
    if (!this.entries().some((e) => gone.has(e.address))) return;
    this.deps.cfg.update((cfg) => {
      cfg.watchlist = cfg.watchlist.filter((e) => !gone.has(e.address));
    });
    for (const a of gone) this.history.drop(a);
    this.broadcast();
  }

  /** Replace a token's alerts; one whose condition already holds starts fired. Undefined when not watched. */
  setAlerts(address: string, raw: unknown): WatchEntry | undefined {
    const e = this.entry(address);
    if (!e) return undefined;
    const { fired: _ignored, ...asked } = (raw && typeof raw === 'object' ? raw : {}) as any;
    const alerts = sanitizeWatchAlerts(asked);
    if (alerts) {
      const t = this.deps.hub.getToken(address);
      const fired = initialFired(alerts, t?.marketCap, this.change1h(address, t));
      if (Object.keys(fired).length) alerts.fired = fired;
    }
    this.save(address, (x) => {
      if (alerts) x.alerts = alerts;
      else delete x.alerts;
    });
    this.broadcast();
    return this.entry(address);
  }

  private change1h(address: string, t?: TokenInfo): number | undefined {
    return this.history.change1h(address, this.now()) ?? t?.change1h;
  }

  /** A watched token's market moved: sample it, publish our 1h change, fire what its alerts say. */
  private observe(t: TokenInfo): void {
    const e = this.entry(t.address);
    if (!e) return;
    const now = this.now();
    this.history.add(t.address, t.marketCap, now);
    const own = this.history.change1h(t.address, now);
    if (own !== undefined) {
      const rounded = Math.round(own * 10) / 10;
      // the event this sends comes back through here and finds nothing new: no loop
      if (rounded !== t.change1h) this.deps.hub.updateMarket(t.address, { change1h: rounded });
    }
    // a lookup that failed on add: the first market cap seen is the one "since added" counts from
    if (e.addedMarketCap === undefined && t.marketCap) {
      this.save(t.address, (x) => {
        x.addedMarketCap = t.marketCap;
        if (!x.network && t.network) x.network = t.network;
      });
      this.broadcast();
    }
    if (!e.alerts) return;
    const change1h = own ?? t.change1h;
    const { hits, fired } = checkAlerts(e.alerts, { marketCap: t.marketCap, change1h, priceAt: t.priceAt }, now);
    if (JSON.stringify(fired) !== JSON.stringify(e.alerts.fired ?? {})) {
      this.save(t.address, (x) => {
        if (!x.alerts) return;
        if (Object.keys(fired).length) x.alerts.fired = fired;
        else delete x.alerts.fired;
      });
      this.broadcast();
    }
    for (const h of hits) {
      const hit: WatchAlertHit = { address: t.address, kind: h.kind, threshold: h.threshold, marketCap: t.marketCap!, ...(t.symbol ? { symbol: t.symbol } : {}), ...(change1h !== undefined ? { pct: change1h } : {}) };
      this.deps.hub.addAlertPing(hit, now);
      if (e.alerts.telegram && this.deps.sendSelf) {
        const lines = [`🔔 ${alertText(hit)}`, `MC ${compactUsd(hit.marketCap)}`, t.address, ...(t.buy?.panel ? [`${t.buy.provider === 'basedbot' ? 'BasedBot' : 'Cove'}: ${t.buy.panel}`] : [])];
        this.deps.sendSelf(lines.join('\n')).catch((err) => this.log(`telegram alert failed: ${err?.message ?? err}`));
      }
    }
  }

  private save(address: string, fn: (e: WatchEntry) => void): void {
    this.deps.cfg.update((cfg) => {
      const x = cfg.watchlist.find((w) => w.address === address);
      if (x) fn(x);
    });
  }

  private broadcast(): void {
    this.deps.hub.emit('event', { type: 'watchlist', entries: this.entries() } satisfies ServerEvent);
  }
}

/** A watched token with nothing known yet: the hub's enrichment fills it in. */
function bareToken(e: Pick<WatchEntry, 'address' | 'chain' | 'addedAt'>): TokenInfo {
  return { chain: e.chain, address: e.address, seen: 0, calledIn: [], calls: [], firstSeenTs: e.addedAt || Date.now(), lastCallTs: 0 };
}
