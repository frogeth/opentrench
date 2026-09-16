import { useMemo } from 'react';
import type { CallRecord, TokenInfo } from '../types';
import { money, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { ChainBadge, PairChip } from './ChainBadge';
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
  /** the first call ever: who found it, where, when */
  first?: CallRecord;
  /** everyone who scanned it in the window, one entry each, first to scan first */
  callers: CallRecord[];
}

/** What is getting the most call attention right now: tokens ranked by calls in the window, then recency. */
export function rankTrending(tokens: Record<string, TokenInfo>, windowKey: TrendWindow, inScope: (chatName: string) => boolean, now = Date.now(), limit = TOP_N): Row[] {
  const since = now - WINDOW_MS[windowKey];
  const rows: Row[] = [];
  for (const t of Object.values(tokens)) {
    const calls = t.calls.filter((c) => c.ts >= since && c.ts <= now && inScope(c.chatName)).sort((a, b) => b.ts - a.ts);
    if (calls.length === 0) continue;
    const entry = t.firstCallMarketCap ?? t.calls.find((c) => c.marketCap)?.marketCap;
    const first = t.calls[0] ?? (t.firstCaller as CallRecord | undefined);
    const seen = new Set<string>();
    const callers: CallRecord[] = [];
    for (const c of [...calls].reverse()) {
      const k = c.author.toLowerCase().replace(/^@/, '');
      if (seen.has(k)) continue;
      seen.add(k);
      callers.push(c);
    }
    rows.push({ t, calls, n: calls.length, lastTs: calls[0].ts, entry, x: entry && t.marketCap ? t.marketCap / entry : undefined, first, callers });
  }
  return rows.sort((a, b) => b.n - a.n || b.lastTs - a.lastTs).slice(0, limit);
}

function TokenCalls({ r, now, onJump }: { r: Row; now: number; onJump?: (msgId: string, link?: string) => void }) {
  return (
    <div className="hc-calls">
      <div className="hc-calls-head">
        {r.t.symbol ?? r.t.address.slice(0, 8)} · {r.n} scan{r.n === 1 ? '' : 's'} by {r.callers.length} in window · click one to see the message
      </div>
      <div className="hc-calls-list">
        {r.calls.slice(0, 30).map((c) => (
          <a
            key={c.msgId}
            className="hc-call"
            href={c.link}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (!onJump) return;
              e.preventDefault();
              e.stopPropagation();
              onJump(c.msgId, c.link);
            }}
          >
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
  onJump,
}: {
  tokens: Record<string, TokenInfo>;
  window: TrendWindow;
  inScope: (chatName: string) => boolean;
  now: number;
  /** open the token (modal) */
  onSelect: (address: string) => void;
  /** show a scan's message in its chat */
  onJump?: (msgId: string, link?: string) => void;
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
          <HoverCard width={340} card={<TokenCalls r={r} now={now} onJump={onJump} />}>
            <div className={`trend-row${i < 3 ? ' caller-top' : ''}`} onClick={() => onSelect(r.t.address)}>
              <div className="trend-main">
              <span className="trend-who">
                <span className="caller-rank">{i + 1}</span>
                {r.t.imageUrl ? <img className="avatar" src={r.t.imageUrl} alt="" style={{ width: 24, height: 24, borderRadius: 6 }} /> : <Avatar name={r.t.symbol ?? '?'} size={24} />}
                <b>{r.t.symbol ? `$${r.t.symbol}` : r.t.address.slice(0, 6)}</b>
                <ChainBadge network={r.t.network} chain={r.t.chain} />
                <PairChip t={r.t} />
              </span>
              <span>{r.n}</span>
              <span className="muted">{r.entry ? money(r.entry) : '—'}</span>
              <span>{r.t.marketCap ? money(r.t.marketCap) : '—'}</span>
              <span className={r.x === undefined ? 'muted' : r.x >= 1 ? 'up' : 'down'}>{r.x === undefined ? '—' : fmtX(r.x)}</span>
              <span className="muted">{timeAgo(r.lastTs, now)}</span>
              </div>
              <div className="trend-sub">
                {r.first && (
                  <span
                    className={`trend-found${onJump ? ' trend-found-jump' : ''}`}
                    title={onJump ? 'show the first call in its chat' : undefined}
                    onClick={(e) => {
                      if (!onJump) return;
                      e.stopPropagation();
                      onJump(r.first!.msgId, r.first!.link);
                    }}
                  >
                    <Avatar src={r.first.avatar} name={r.first.author} size={14} />
                    <span className="muted">found by</span> <b>{r.first.author}</b>
                    <span className="muted">
                      {' '}
                      · <Logo source={r.first.source} size={9} /> {r.first.chatName.replace(/\s*\([^)]*\)\s*$/, '')} · {timeAgo(r.first.ts, now)}
                    </span>
                  </span>
                )}
                <span className="trend-scanners" title={r.callers.map((c) => c.author).join(', ')}>
                  <span className="trend-pfps">
                    {r.callers.slice(0, 5).map((c) => (
                      <Avatar key={c.msgId} src={c.avatar} name={c.author} size={16} />
                    ))}
                  </span>
                  <span className="muted">{r.callers.length > 5 ? `+${r.callers.length - 5}` : ''}</span>
                </span>
              </div>
            </div>
          </HoverCard>
        </VirtualItem>
      ))}
    </>
  );
}
