import { useMemo } from 'react';
import type { CallRecord, TokenInfo } from '../types';
import { money, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { ChainBadge } from './ChainBadge';
import { HoverCard } from './HoverCard';
import { Logo } from './Logo';
import { VirtualItem } from './Virtual';

/** The windows a trending column can show; the header switches between them. */
export const TREND_WINDOWS = ['5m', '1h', '6h', '24h'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
const WINDOW_MS: Record<TrendWindow, number> = { '5m': 5 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };
export const TOP_N = 10;
const fmtX = (x: number) => `${x >= 10 ? x.toFixed(0) : x.toFixed(2)}x`;

export function trendWindow(w: string | undefined): TrendWindow {
  return (TREND_WINDOWS as readonly string[]).includes(w ?? '') ? (w as TrendWindow) : '1h';
}

interface Row {
  t: TokenInfo;
  /** the calls inside the window, newest first */
  calls: CallRecord[];
  n: number;
  lastTs: number;
  /** market cap at the first-ever call: the entry */
  entry?: number;
  /** current ÷ entry */
  x?: number;
}

/** What is getting the most call attention right now: tokens ranked by calls in the window, then recency. */
export function rankTrending(tokens: Record<string, TokenInfo>, windowKey: TrendWindow, inScope: (chatName: string) => boolean, now = Date.now(), limit = TOP_N): Row[] {
  const since = now - WINDOW_MS[windowKey];
  const rows: Row[] = [];
  for (const t of Object.values(tokens)) {
    const calls = t.calls.filter((c) => c.ts >= since && c.ts <= now && inScope(c.chatName)).sort((a, b) => b.ts - a.ts);
    if (calls.length === 0) continue;
    const entry = t.firstCallMarketCap ?? t.calls.find((c) => c.marketCap)?.marketCap;
    rows.push({ t, calls, n: calls.length, lastTs: calls[0].ts, entry, x: entry && t.marketCap ? t.marketCap / entry : undefined });
  }
  return rows.sort((a, b) => b.n - a.n || b.lastTs - a.lastTs).slice(0, limit);
}

function TokenCalls({ r, now }: { r: Row; now: number }) {
  return (
    <div className="hc-calls">
      <div className="hc-calls-head">
        {r.t.symbol ?? r.t.address.slice(0, 8)} · {r.n} call{r.n === 1 ? '' : 's'} in window
      </div>
      <div className="hc-calls-list">
        {r.calls.slice(0, 30).map((c) => (
          <a key={c.msgId} className="hc-call" href={c.link} target="_blank" rel="noreferrer">
            <Avatar src={c.avatar} name={c.author} size={22} />
            <span className="hc-call-who">
              <b>{c.author}</b>
              <span>
                <Logo source={c.source} size={9} /> {c.chatName.replace(/\s*\([^)]*\)\s*$/, '')}
              </span>
            </span>
            <span className="hc-call-mc">{c.marketCap ? money(c.marketCap) : ''}</span>
            <span className="hc-call-ago">{timeAgo(c.ts, now)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** The trending body: rank, token, calls in the window, entry MC, current MC, multiplier, last call. */
export function TrendingList({
  tokens,
  window: windowKey,
  inScope,
  now,
  onSelect,
}: {
  tokens: Record<string, TokenInfo>;
  window: TrendWindow;
  inScope: (chatName: string) => boolean;
  now: number;
  /** open the token (modal) */
  onSelect: (address: string) => void;
}) {
  const rows = useMemo(() => rankTrending(tokens, windowKey, inScope, now), [tokens, windowKey, inScope, now]);
  if (rows.length === 0) return <div className="empty">No calls in the last {windowKey}.</div>;
  return (
    <>
      <div className="trend-head">
        <span>token</span>
        <span>calls</span>
        <span>entry</span>
        <span>mc</span>
        <span>x</span>
        <span>last</span>
      </div>
      {rows.map((r, i) => (
        <VirtualItem key={r.t.address} id={`trend:${r.t.address}`} estimate={38}>
          <HoverCard width={320} card={<TokenCalls r={r} now={now} />}>
            <div className={`trend-row${i < 3 ? ' caller-top' : ''}`} onClick={() => onSelect(r.t.address)}>
              <span className="trend-who">
                <span className="caller-rank">{i + 1}</span>
                {r.t.imageUrl ? <img className="avatar" src={r.t.imageUrl} alt="" style={{ width: 24, height: 24, borderRadius: 6 }} /> : <Avatar name={r.t.symbol ?? '?'} size={24} />}
                <b>{r.t.symbol ? `$${r.t.symbol}` : r.t.address.slice(0, 6)}</b>
                <ChainBadge network={r.t.network} chain={r.t.chain} />
              </span>
              <span>{r.n}</span>
              <span className="muted">{r.entry ? money(r.entry) : '—'}</span>
              <span>{r.t.marketCap ? money(r.t.marketCap) : '—'}</span>
              <span className={r.x === undefined ? 'muted' : r.x >= 1 ? 'up' : 'down'}>{r.x === undefined ? '—' : fmtX(r.x)}</span>
              <span className="muted">{timeAgo(r.lastTs, now)}</span>
            </div>
          </HoverCard>
        </VirtualItem>
      ))}
    </>
  );
}
