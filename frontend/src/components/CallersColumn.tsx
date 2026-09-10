import { useMemo } from 'react';
import type { CallRecord, TokenInfo } from '../types';
import { isFavorite, money, normName, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { HoverCard } from './HoverCard';
import { VirtualItem } from './Virtual';

const WINDOW_MS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 } as const;
const fmtX = (x: number) => `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x`;

interface Row {
  key: string;
  name: string;
  avatar?: string;
  source: CallRecord['source'];
  calls: { t: TokenInfo; c: CallRecord; x: number; best: number }[];
  n: number;
  avg: number;
  median: number;
  best: number;
  hitRate: number;
  lastTs: number;
}

/** Rank callers by what happened after their calls: current MC and ATH versus MC at the call. */
export function rankCallers(tokens: Record<string, TokenInfo>, windowKey: keyof typeof WINDOW_MS, inScope: (chatName: string) => boolean, now = Date.now()): Row[] {
  const since = now - WINDOW_MS[windowKey];
  const by = new Map<string, Row>();
  for (const t of Object.values(tokens)) {
    for (const c of t.calls) {
      if (c.ts < since || !c.marketCap || !t.marketCap || !inScope(c.chatName)) continue;
      const x = t.marketCap / c.marketCap;
      const best = (t.athMarketCap ?? t.marketCap) / c.marketCap;
      const key = normName(c.author);
      let r = by.get(key);
      if (!r) {
        r = { key, name: c.author, avatar: c.avatar, source: c.source, calls: [], n: 0, avg: 0, median: 0, best: 0, hitRate: 0, lastTs: 0 };
        by.set(key, r);
      }
      r.calls.push({ t, c, x, best });
      if (c.ts > r.lastTs) {
        r.lastTs = c.ts;
        r.avatar = c.avatar ?? r.avatar;
        r.name = c.author;
      }
    }
  }
  const rows = [...by.values()].map((r) => {
    const xs = r.calls.map((k) => k.x).sort((a, b) => a - b);
    r.n = xs.length;
    r.avg = xs.reduce((s, v) => s + v, 0) / xs.length;
    r.median = xs[Math.floor((xs.length - 1) / 2)];
    r.best = Math.max(...r.calls.map((k) => k.best));
    r.hitRate = r.calls.filter((k) => k.best >= 2).length / xs.length;
    r.calls.sort((a, b) => b.c.ts - a.c.ts);
    return r;
  });
  // rank by median first so one moonshot does not carry a spray-and-pray caller
  return rows.sort((a, b) => b.median - a.median || b.avg - a.avg || b.n - a.n);
}

function CallerCalls({ r, now }: { r: Row; now: number }) {
  return (
    <div className="hc-calls">
      <div className="hc-calls-head">
        {r.name} · {r.n} call{r.n === 1 ? '' : 's'}
      </div>
      <div className="hc-calls-list">
        {r.calls.slice(0, 30).map(({ t, c, x, best }) => (
          <a key={c.msgId} className="hc-call" href={c.link} target="_blank" rel="noreferrer">
            {t.imageUrl ? <img className="avatar" src={t.imageUrl} alt="" style={{ width: 22, height: 22, borderRadius: 6 }} /> : <Avatar name={t.symbol ?? '?'} size={22} />}
            <span className="hc-call-who">
              <b>{t.symbol ?? t.address.slice(0, 6)}</b>
              <span>
                <Logo source={c.source} size={9} /> {money(c.marketCap)} → {money(t.marketCap)}
              </span>
            </span>
            <span className={`hc-call-mc ${x >= 1 ? 'up' : 'down'}`} title={`best ${fmtX(best)}`}>
              {fmtX(x)}
            </span>
            <span className="hc-call-ago">{timeAgo(c.ts, now)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** The leaderboard body: one row per caller with calls, median, avg, best, hit rate, last call. */
export function CallersList({
  tokens,
  window: windowKey = '7d',
  inScope,
  now,
  favorites,
  onSearch,
}: {
  tokens: Record<string, TokenInfo>;
  window?: keyof typeof WINDOW_MS;
  inScope: (chatName: string) => boolean;
  now: number;
  favorites: string[];
  /** put the caller's name in the search box */
  onSearch: (name: string) => void;
}) {
  const rows = useMemo(() => rankCallers(tokens, windowKey, inScope, now), [tokens, windowKey, inScope, now]);
  if (rows.length === 0) return <div className="empty">No calls with market cap data in this window yet.</div>;
  return (
    <>
      <div className="callers-head">
        <span>caller</span>
        <span>calls</span>
        <span>median</span>
        <span>avg</span>
        <span>best</span>
        <span>≥2x</span>
        <span>last</span>
      </div>
      {rows.map((r, i) => (
        <VirtualItem key={r.key} id={`caller:${r.key}`} estimate={44}>
          <HoverCard width={320} card={<CallerCalls r={r} now={now} />}>
            <div className={`caller-row${i < 3 ? ' caller-top' : ''}`} onClick={() => onSearch(r.name)}>
              <span className="caller-who">
                <span className="caller-rank">{i + 1}</span>
                <Avatar src={r.avatar} name={r.name} size={24} crown={isFavorite(favorites, r.name)} />
                <b>{r.name}</b>
              </span>
              <span>{r.n}</span>
              <span className={r.median >= 1 ? 'up' : 'down'}>{fmtX(r.median)}</span>
              <span className={r.avg >= 1 ? 'up' : 'down'}>{fmtX(r.avg)}</span>
              <span className="gold">{fmtX(r.best)}</span>
              <span>{Math.round(r.hitRate * 100)}%</span>
              <span className="muted">{timeAgo(r.lastTs, now)}</span>
            </div>
          </HoverCard>
        </VirtualItem>
      ))}
    </>
  );
}
