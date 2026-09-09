import { useState } from 'react';
import type { Contract, TokenInfo } from '../types';
import { copyText, money, shortAddr } from '../format';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';

/** Compact token strip shown under a chat message. */
export function TokenChip({ c, t, onSelect }: { c: Contract; t?: TokenInfo; onSelect?: (address: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const copy = async () => {
    await copyText(c.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const hasPrice = t?.priceUsd !== undefined;
  return (
    <div className={`chip chip-${c.chain}${showChart ? ' chip-open' : ''}`}>
      <div className="chip-row">
        {t?.imageUrl && <img className="chip-img" src={t.imageUrl} alt="" loading="lazy" />}
        <button className="chip-sym" onClick={() => onSelect?.(c.address)} title={`${c.address}\nclick to show in Calls`}>
          {t?.symbol ?? shortAddr(c.address)}
        </button>
        <span className="chip-addr" onClick={copy} title="click to copy">
          {copied ? 'copied' : shortAddr(c.address)}
        </span>
        <ChainBadge network={t?.network} chain={c.chain} size={11} />
        {t?.launchpad && <LaunchpadBadge launchpad={t.launchpad} url={t.launchpadUrl} size={11} />}
        {hasPrice && money(t?.marketCap) && <span className="muted">MC {money(t?.marketCap)}</span>}
        {hasPrice && t?.change24h !== undefined && (
          <span className={t.change24h >= 0 ? 'up' : 'down'}>
            {t.change24h >= 0 ? '+' : ''}
            {t.change24h.toFixed(1)}%
          </span>
        )}
        {t && !hasPrice && <span className="pending">no pair yet</span>}
        <span className="chip-seen">{t?.seen ?? 1}×</span>
        <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} />
        <BuyRow buy={t?.buy} compact />
      </div>
      {showChart && t?.embedUrl && (
        <iframe className="token-chart" src={t.embedUrl} title="chart" loading="lazy" allow="clipboard-write" />
      )}
    </div>
  );
}
