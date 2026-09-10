import type { BuyLinks } from '../types';

/** Cove quick buys. With `onBuy` they open the Cove tab inside the app; without it they are plain Telegram deep links. */
export function BuyRow({ buy, compact = false, onBuy }: { buy?: BuyLinks; compact?: boolean; onBuy?: (url: string) => void }) {
  if (!buy) return null;
  const item = (url: string, label: string, title: string, cls = '') =>
    onBuy ? (
      <button key={url} className={`buy-btn ${cls}`} onClick={() => onBuy(url)} title={title}>
        {label}
      </button>
    ) : (
      <a key={url} className={`buy-btn ${cls}`} href={url} target="_blank" rel="noreferrer" title={title}>
        {label}
      </a>
    );
  return (
    <div className={`buy${compact ? ' buy-compact' : ''}`}>
      {buy.amounts.map((a) => item(a.url, `$${a.usd}`, `buy $${a.usd} on Cove`))}
      {item(buy.panel, 'Cove', 'open in Cove', 'buy-panel')}
    </div>
  );
}
