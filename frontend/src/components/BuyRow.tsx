import { createContext, useContext } from 'react';
import type { BuyLinks } from '../types';

/** App-wide buy handler: routes any bot deep link into the in-app bot pane/drawer. Set once in App. */
export const BuyContext = createContext<((url: string) => void) | null>(null);

export const PROVIDER_LABEL = { cove: 'Cove', basedbot: 'BasedBot' } as const;
/** opentrench's own BasedBot referral; rides on every BasedBot deep link (fixed, mirrors the backend) */
export const BASEDBOT_REFERRAL = 'frog';

/** Quick buys for whichever bot is chosen. With `onBuy` they open that bot's column inside the app (the normal path); without it they fall back to plain Telegram deep links. */
export function BuyRow({ buy, compact = false, onBuy: onBuyProp }: { buy?: BuyLinks; compact?: boolean; onBuy?: (url: string) => void }) {
  const onBuy = onBuyProp ?? useContext(BuyContext) ?? undefined;
  if (!buy) return null;
  const label = PROVIDER_LABEL[buy.provider] ?? 'Buy';
  const item = (url: string, text: string, title: string, cls = '') =>
    onBuy ? (
      <button key={url} className={`buy-btn ${cls}`} onClick={() => onBuy(url)} title={title}>
        {text}
      </button>
    ) : (
      <a key={url} className={`buy-btn ${cls}`} href={url} target="_blank" rel="noreferrer" title={title}>
        {text}
      </a>
    );
  return (
    <div className={`buy${compact ? ' buy-compact' : ''}`}>
      {buy.amounts.map((a) => item(a.url, `$${a.usd}`, `buy $${a.usd} on ${label}`))}
      {item(buy.panel, buy.amounts.length ? label : `Buy · ${label}`, `open in ${label}`, 'buy-panel')}
    </div>
  );
}
