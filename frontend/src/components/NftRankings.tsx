import { useState } from 'react';
import type { NftRanking } from '../types';
import { Icon } from './Icon';

const smallFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : smallFmt.format(n));
const usd = (n: number) => `$${fmt(n)}`;
const native = (p?: { unit: number; symbol: string }) => (p ? `${fmt(p.unit)} ${p.symbol}` : '—');
type Currency = 'native' | 'usd';
/** a price in the column's currency; a floor OpenSea gave no dollar figure for falls back to its coin */
const amount = (p: { unit: number; symbol: string; usd?: number } | undefined, cur: Currency) => (cur === 'usd' && p?.usd !== undefined ? usd(p.usd) : native(p));

/** One collection row: opens the collection, shows a Mint pill while a mint is live. */
function Row({ r, currency, onMint }: { r: NftRanking; currency: Currency; onMint: (r: NftRanking) => void }) {
  const [imgBroken, setImgBroken] = useState(false);
  const url = `https://opensea.io/collection/${r.slug}`;
  return (
    <div
      className="nftv-row"
      title={`${r.name} · ${r.chain}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
        window.open(url, '_blank', 'noopener');
      }}
    >
      <span className="nftv-rank muted">{r.rank}</span>
      <span className="nftv-name">
        <a className="nftv-link" href={url} target="_blank" rel="noreferrer">
          {r.image && !imgBroken ? <img src={r.image} alt="" loading="lazy" onError={() => setImgBroken(true)} /> : <span className="nftv-noimg" />}
          <b>{r.name}</b>
          {r.verified && (
            <span className="nftv-verified" title="verified">
              ✓
            </span>
          )}
        </a>
        {r.minting && (
          <button
            className="nftv-mint"
            onClick={(e) => {
              e.preventDefault();
              onMint(r);
            }}
            title={`${r.minting.stageType} open`}
          >
            <Icon name="mint" size={10} /> Mint
          </button>
        )}
      </span>
      <span className="nftv-num">{amount(r.floor, currency)}</span>
      <span className="nftv-num">
        <b>{amount(r.volume, currency)}</b>
        <small className="muted">{currency === 'usd' ? native(r.volume) : usd(r.volume.usd)}</small>
      </span>
      <span className="nftv-num">{fmt(r.sales)}</span>
      <span className={`nftv-num ${r.floorChange === undefined ? 'muted' : r.floorChange >= 0 ? 'up' : 'down'}`}>
        {r.floorChange === undefined ? '—' : `${r.floorChange >= 0 ? '+' : ''}${(r.floorChange * 100).toFixed(1)}%`}
      </span>
    </div>
  );
}

/** OpenSea's ranking table for one (list, window) pair. Rows open the collection; minting rows get a Mint pill. */
export function NftRankings({
  rows,
  at,
  now,
  timeframe,
  currency = 'native',
  onMint,
}: {
  rows?: NftRanking[];
  at?: number;
  now: number;
  timeframe: '1h' | '1d';
  currency?: Currency;
  onMint: (r: NftRanking) => void;
}) {
  if (!rows) return <div className="empty">Loading OpenSea rankings…</div>;
  if (rows.length === 0) return <div className="empty">OpenSea returned no collections for this window.</div>;
  const secs = at !== undefined ? Math.max(0, Math.round((now - at) / 1000)) : 0;
  const stale = at !== undefined && now - at > 5 * 60_000;
  const ago = secs < 120 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  return (
    <div className="nftv">
      <div className="nftv-head muted">
        <span>#</span>
        <span>collection</span>
        <span>floor</span>
        <span>vol {timeframe.toUpperCase()}</span>
        <span>sales</span>
        <span>Δ floor</span>
      </div>
      {rows.map((r) => (
        <Row key={r.slug} r={r} currency={currency} onMint={onMint} />
      ))}
      {at !== undefined &&
        (stale ? (
          <div className="nftv-foot err">stale · last update {Math.round(secs / 60)}m ago</div>
        ) : (
          <div className="nftv-foot muted">updated {ago} · opensea.io</div>
        ))}
    </div>
  );
}
