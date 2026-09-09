import { useState } from 'react';
import type { TokenInfo } from '../types';
import { copyText, money, netLabel, price, shortAddr, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { api } from '../api';

export function CallCard({ t, now }: { t: TokenInfo; now: number }) {
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const hasPrice = t.priceUsd !== undefined;
  const label = netLabel(t.network, t.chain);
  const copy = async () => {
    await copyText(t.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const c = t.firstCaller;

  return (
    <div className={`call call-${t.chain}${showChart ? ' call-open' : ''}`}>
      <div className="call-row">
        {t.imageUrl ? (
          <img className="call-img" src={t.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="call-img call-img-fallback">{label}</div>
        )}
        <div className="call-body">
          <div className="call-head">
            <button className="call-sym" onClick={copy} title={`${t.address}\nclick to copy`}>
              {copied ? 'copied' : (t.symbol ?? shortAddr(t.address))}
            </button>
            {t.name && t.name !== t.symbol && <span className="call-name">{t.name}</span>}
            <span className={`net net-${t.network ?? t.chain}`}>{label}</span>
            <span className="call-seen" title={t.calledIn.length ? `called in:\n${t.calledIn.join('\n')}` : undefined}>
              {t.seen}×
            </span>
          </div>
          <div className="call-sub">
            <span className="muted">{timeAgo(t.firstSeenTs, now)}</span>
            <span className="call-addr" onClick={copy} title="click to copy">
              {shortAddr(t.address)} <Icon name="copy" size={10} />
            </span>
            {c && (
              <span className="call-by">
                <Avatar src={c.avatar} name={c.author} size={16} />
                <span className="call-author">{c.author}</span>
                <Logo source={c.source} size={11} />
                <span className="muted">{c.chatName}</span>
                <button
                  className="block"
                  title={`blacklist ${c.author} (never counts as a caller)`}
                  onClick={() => void api.blacklistAdd(c.author).catch(() => {})}
                >
                  🚫
                </button>
              </span>
            )}
          </div>
          <div className="call-stats">
            {hasPrice ? (
              <>
                {price(t.priceUsd) && <span>{price(t.priceUsd)}</span>}
                {money(t.marketCap) && (
                  <span>
                    MC <b>{money(t.marketCap)}</b>
                  </span>
                )}
                {money(t.liquidity) && <span>Liq {money(t.liquidity)}</span>}
                {t.change24h !== undefined && (
                  <span className={t.change24h >= 0 ? 'up' : 'down'}>
                    {t.change24h >= 0 ? '+' : ''}
                    {t.change24h.toFixed(1)}%
                  </span>
                )}
              </>
            ) : (
              <span className="pending">no pair yet · retrying</span>
            )}
          </div>
          <div className="call-actions">
            <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} />
            <BuyRow buy={t.buy} />
          </div>
        </div>
      </div>
      {showChart && t.embedUrl && (
        <iframe className="token-chart" src={t.embedUrl} title={`${t.symbol ?? 'token'} chart`} loading="lazy" allow="clipboard-write" />
      )}
    </div>
  );
}
