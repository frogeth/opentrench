import { useState } from 'react';
import type { TokenInfo } from '../types';
import { copyText, isFavorite, money, price, shortAddr, telegramShareUrl, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { AuthorMenu } from './AuthorMenu';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';

export function CallCard({
  t,
  now,
  selected = false,
  favorites,
}: {
  t: TokenInfo;
  now: number;
  selected?: boolean;
  favorites: string[];
}) {
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const hasPrice = t.priceUsd !== undefined;
  const copy = async () => {
    await copyText(t.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const c = t.firstCaller;
  const buys = t.buys24h ?? 0;
  const sells = t.sells24h ?? 0;
  const txTotal = buys + sells;
  const buyPct = txTotal ? Math.round((buys / txTotal) * 100) : 50;
  const shareLabel = `${t.symbol ? `$${t.symbol}` : ''}${t.name && t.name !== t.symbol ? ` ${t.name}` : ''}${
    c ? ` · called by ${c.author} in ${c.chatName}` : ''
  }`.trim();

  return (
    <div
      id={`call-${t.address}`}
      className={`call call-${t.chain}${showChart ? ' call-open' : ''}${selected ? ' call-selected' : ''}${
        t.seen >= 3 ? ' call-hot-3' : t.seen === 2 ? ' call-hot-2' : ''
      }`}
    >
      {t.seen >= 2 && <span key={t.lastCallTs} className="call-pulse" />}

      {/* caller line */}
      <div className="call-top">
        {c && (
          <>
            <Avatar src={c.avatar} name={c.author} size={20} crown={isFavorite(favorites, c.author)} />
            <span className="call-author">{c.author}</span>
            <AuthorMenu author={c.author} link={c.link} favorite={isFavorite(favorites, c.author)} />
            <Logo source={c.source} size={11} />
            <span className="muted call-chat">{c.chatName}</span>
          </>
        )}
        <span className="muted">{timeAgo(t.lastCallTs ?? t.firstSeenTs, now)}</span>
        <span
          className={`call-seen${t.seen >= 2 ? ' call-seen-hot' : ''}`}
          title={t.calledIn.length ? `called in:\n${t.calledIn.join('\n')}` : undefined}
        >
          {t.seen >= 2 ? '🔥 ' : ''}
          {t.seen}×
        </span>
        {hasPrice && money(t.marketCap) && (
          <span className="call-mc-now">
            MC: <b>{money(t.marketCap)}</b>
          </span>
        )}
      </div>

      {/* token block */}
      <div className="call-mid">
        <div className="call-imgwrap">
          {t.imageUrl && !imgBroken ? (
            <img className="call-img" src={t.imageUrl} alt="" loading="lazy" onError={() => setImgBroken(true)} />
          ) : (
            <div className="call-img call-img-fallback">
              <ChainBadge network={t.network} chain={t.chain} size={28} className="net-plain" />
            </div>
          )}
          <ChainBadge network={t.network} chain={t.chain} size={12} className="net-badge" />
          {t.launchpad && (
            <span className="lp-badge">
              <LaunchpadBadge launchpad={t.launchpad} url={t.launchpadUrl} size={14} />
            </span>
          )}
        </div>
        <div className="call-info">
          <div className="call-head">
            <button className="call-sym" onClick={copy} title={`${t.address}\nclick to copy`}>
              {copied ? 'copied' : (t.symbol ?? shortAddr(t.address))}
            </button>
            {t.name && t.name !== t.symbol && <span className="call-name">{t.name}</span>}
          </div>
          <div className="call-sub">
            {t.pairCreatedAt && <span title="token age">{timeAgo(t.pairCreatedAt, now)}</span>}
            <span className="call-addr" onClick={copy} title="click to copy">
              {shortAddr(t.address)} <Icon name="copy" size={10} />
            </span>
            {hasPrice && price(t.priceUsd) && <span>{price(t.priceUsd)}</span>}
          </div>
          <div className="call-tx">
            {txTotal > 0 ? (
              <>
                <span className="muted">TX {txTotal}</span>
                <span className="txbar" title={`${buys} buys / ${sells} sells (24h)`}>
                  <span className="txbar-buy" style={{ width: `${buyPct}%` }} />
                </span>
              </>
            ) : (
              !hasPrice && <span className="pending">no pair yet · retrying</span>
            )}
            <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} />
          </div>
        </div>
        <div className="call-right">
          {hasPrice ? (
            <>
              {money(t.volume24h) && (
                <span className="call-kv">
                  V <b>{money(t.volume24h)}</b>
                </span>
              )}
              {money(t.marketCap) && (
                <span className="call-kv call-mc">
                  MC <b>{money(t.marketCap)}</b>
                </span>
              )}
              {money(t.athMarketCap) && (
                <span className="call-kv call-ath">
                  ATH: <b>{money(t.athMarketCap)}</b>
                </span>
              )}
              {money(t.liquidity) && (
                <span className="call-kv">
                  Liq <b>{money(t.liquidity)}</b>
                </span>
              )}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </div>
      </div>

      {/* bottom: cove + share */}
      <div className="call-bottom">
        <BuyRow buy={t.buy} />
        <a
          className="share"
          href={telegramShareUrl(t.address, shareLabel)}
          target="_blank"
          rel="noreferrer"
          title="share CA on Telegram"
        >
          <Icon name="telegram" size={13} /> share
        </a>
      </div>

      {showChart && t.embedUrl && (
        <iframe
          className="token-chart"
          src={t.embedUrl}
          title={`${t.symbol ?? 'token'} chart`}
          loading="lazy"
          allow="clipboard-write"
        />
      )}
    </div>
  );
}
