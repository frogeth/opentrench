import type { BuyLinks } from '../types';

export function BuyRow({ buy, compact = false }: { buy?: BuyLinks; compact?: boolean }) {
  if (!buy) return null;
  return (
    <div className={`buy${compact ? ' buy-compact' : ''}`}>
      {buy.amounts.map((a) => (
        <a key={a.usd} className="buy-btn" href={a.url} target="_blank" rel="noreferrer" title={`buy $${a.usd} on Cove`}>
          ${a.usd}
        </a>
      ))}
      <a className="buy-btn buy-panel" href={buy.panel} target="_blank" rel="noreferrer" title="open in Cove">
        Cove
      </a>
    </div>
  );
}
