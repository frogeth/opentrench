import type { LongLaunch } from '../types';
import { money, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { VirtualItem } from './Virtual';

/** The Long launches column: newest stock-anchored launches on Robinhood Chain, from app.long.xyz. */
export function LongLaunches({ rows, at, now, onSelect }: { rows?: LongLaunch[]; at?: number; now: number; onSelect?: (address: string) => void }) {
  if (!rows) return <div className="empty">Loading launches from app.long.xyz…</div>;
  if (rows.length === 0) return <div className="empty">No launches yet.</div>;
  return (
    <>
      <div className="launch-head">
        <span>launch</span>
        <span>anchor</span>
        <span>mc</span>
        <span>age</span>
        <span />
      </div>
      {rows.map((r) => (
        <VirtualItem key={r.address} id={`long:${r.address}`} estimate={44}>
          <div className={`launch-row${r.stage === 'graduated' ? ' launch-graduated' : ''}`} onClick={() => onSelect?.(r.address)} title={`${r.name} · click to open`}>
            <span className="launch-who">
              {r.image ? <img className="avatar" src={r.image} alt="" loading="lazy" style={{ width: 28, height: 28, borderRadius: 7 }} /> : <Avatar name={r.symbol} size={28} />}
              <span className="launch-names">
                <b>${r.symbol}</b>
                <span className="muted">{r.name}</span>
              </span>
            </span>
            <span className="launch-anchor" title={r.anchorAddress}>
              {r.anchor}
            </span>
            <span title={r.volume24h !== undefined ? `24h volume ${money(r.volume24h)}` : undefined}>{r.marketCap !== undefined ? money(r.marketCap) : '—'}</span>
            <span className="muted">{r.createdAt ? timeAgo(r.createdAt, now) : '—'}</span>
            <span className="launch-links" onClick={(e) => e.stopPropagation()}>
              {r.cove && (
                <a href={r.cove} target="_blank" rel="noreferrer" title="buy panel on Cove">
                  Cove
                </a>
              )}
            </span>
            {r.stage === 'auction' && r.progress !== undefined && r.progress > 0 && (
              <span className="launch-progress" style={{ width: `${r.progress}%` }} title={`${r.progress.toFixed(0)}% of the auction sold`} />
            )}
          </div>
        </VirtualItem>
      ))}
      {at && <div className="hint launch-foot">updated {timeAgo(at, now)} · app.long.xyz</div>}
    </>
  );
}
