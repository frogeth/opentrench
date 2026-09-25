import { createContext, useContext } from 'react';
import type { WatchSortKey } from './api';
import type { CallRecord, TokenInfo, WatchEntry } from './types';

/** The one shared watchlist, for every card, chip and modal: ★ means the same thing everywhere. */
export interface WatchApi {
  has: (address: string) => boolean;
  /** add (any text: every contract in it) or remove one address */
  toggle: (address: string, on: boolean) => void;
}
export const WatchContext = createContext<WatchApi | null>(null);

/** ☆ / ★ toggle; renders nothing outside the provider. */
export function WatchStar({ address, className = '' }: { address: string; className?: string }) {
  const w = useContext(WatchContext);
  if (!w) return null;
  const on = w.has(address);
  return (
    <button
      className={`watch-star${on ? ' on' : ''}${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        w.toggle(address, !on);
      }}
      title={on ? 'on your watchlist · click to remove' : 'add to watchlist'}
      aria-label={on ? 'remove from watchlist' : 'add to watchlist'}
      aria-pressed={on}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

/** Drag data type for a token dropped on a watchlist column (column reordering uses text/plain). */
export const TOKEN_DRAG_TYPE = 'application/x-opentrench-token';

export type WatchSort = { key: WatchSortKey; dir: 'asc' | 'desc' };
export const DEFAULT_WATCH_SORT: WatchSort = { key: 'added', dir: 'desc' };
export interface WatchRow {
  e: WatchEntry;
  t?: TokenInfo;
}

/** Percent change of the market cap since the token was added. */
export function sinceAdded(e: WatchEntry, t?: TokenInfo): number | undefined {
  if (!e.addedMarketCap || t?.marketCap === undefined) return undefined;
  return (t.marketCap / e.addedMarketCap - 1) * 100;
}

export function lastCall(t?: TokenInfo): CallRecord | undefined {
  if (!t?.calls.length) return undefined;
  return t.calls.reduce((a, b) => (b.ts > a.ts ? b : a));
}

const sortValue = (r: WatchRow, key: WatchSortKey): number | string | undefined => {
  switch (key) {
    case 'added':
      return r.e.addedAt;
    case 'symbol':
      return r.t?.symbol?.toLowerCase();
    case 'price':
      return r.t?.priceUsd;
    case 'marketCap':
      return r.t?.marketCap;
    case 'change1h':
      return r.t?.change1h;
    case 'sinceAdded':
      return sinceAdded(r.e, r.t);
    case 'lastCall':
      return lastCall(r.t)?.ts;
  }
};

/** Rows sorted by a header; rows with no value for it always sink to the bottom. */
export function sortRows(rows: WatchRow[], sort: WatchSort): WatchRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * sign;
    return (x - y) * sign;
  });
}

/** "1.2m", "500k", "$2,500,000" → dollars; '' → undefined (clear the alert); anything else → null (invalid). */
export function parseUsd(raw: string): number | undefined | null {
  const s = raw.trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1);
  return n > 0 ? n : null;
}

/** The inverse, for filling an alert field: 1200000 → "1.2m". */
export function usdInput(n: number | undefined): string {
  if (n === undefined) return '';
  const f = (v: number, u: string) => `${Math.round(v * 100) / 100}${u}`;
  if (n >= 1e9) return f(n / 1e9, 'b');
  if (n >= 1e6) return f(n / 1e6, 'm');
  if (n >= 1e3) return f(n / 1e3, 'k');
  return String(n);
}

export function pct(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}%`;
}
