import { useState } from 'react';
import type { TokenInfo } from '../types';
import { chartEmbedUrl, copyText, isFavorite, money, price, shortAddr, telegramShareUrl, timeAgo, type ChartProvider } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { AuthorMenu } from './AuthorMenu';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';
import { HoverCard, Tip } from './HoverCard';
import { SecurityStrip } from './SecurityStrip';

/**
 * One call. Strict grid so every card has the same shape: caller line,
 * image | identity | numbers, then buys | share. Nothing wraps; long text ellipsizes.
 */
/** Every counted call, newest first: who, where, MC at the time, when. */
function CallsList({ t, now }: { t: TokenInfo; now: number }) {
  const calls = [...t.calls].reverse();
  return (
    <div className="hc-calls">
      <div className="hc-calls-head">
        {t.seen} call{t.seen === 1 ? '' : 's'} for {t.symbol ? `$${t.symbol}` : shortAddr(t.address)}
      </div>
      <div className="hc-calls-list">
        {calls.length === 0 && <div className="hint">no calls recorded</div>}
        {calls.map((c) => (
          <a key={c.msgId} className="hc-call" href={c.link} target="_blank" rel="noreferrer">
            <Avatar src={c.avatar} name={c.author} size={22} />
            <span className="hc-call-who">
              <b>{c.author}</b>
              <span>
                <Logo source={c.source} size={9} /> {c.chatName.replace(/\s*\([^)]*\)\s*$/, '')}
              </span>
            </span>
            <span className="hc-call-mc">{money(c.marketCap) ?? '—'}</span>
            <span className="hc-call-ago">{timeAgo(c.ts, now)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function CallCard({
  t,
  now,
  selected = false,
  favorites,
  chartProvider = 'basedbot',
}: {
  t: TokenInfo;
  now: number;
  selected?: boolean;
  favorites: string[];
  chartProvider?: ChartProvider;
}) {
  const embed = chartEmbedUrl(t, chartProvider);
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const hasPrice = t.priceUsd !== undefined || t.marketCap !== undefined;
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
  const hot = t.seen >= 3 ? ' call-hot-3' : t.seen === 2 ? ' call-hot-2' : '';
  const mult = t.marketCap && t.firstCallMarketCap ? t.marketCap / t.firstCallMarketCap : undefined;

  return (
    <div id={`call-${t.address}`} className={`call${showChart ? ' call-open' : ''}${selected ? ' call-selected' : ''}${hot}`}>
      {t.seen >= 2 && <span key={t.lastCallTs} className="call-pulse" />}

      {/* 1 · caller line */}
      <div className="call-top">
        {c ? (
          <>
            <Avatar src={c.avatar} name={c.author} size={18} crown={isFavorite(favorites, c.author)} />
            <span className="call-who">
              <span className="call-author">{c.author}</span>
              <AuthorMenu author={c.author} link={c.link} favorite={isFavorite(favorites, c.author)} />
              <Logo source={c.source} size={10} />
              <span className="call-chat">{c.chatName.replace(/\s*\([^)]*\)\s*$/, '')}</span>
            </span>
          </>
        ) : (
          <>
            <span />
            <span className="call-who" />
          </>
        )}
        <span className="call-age">{timeAgo(t.lastCallTs ?? t.firstSeenTs, now)}</span>
        <HoverCard width={300} card={<CallsList t={t} now={now} />}>
          <span className={`call-seen${t.seen >= 2 ? ' call-seen-hot' : ''}`}>
            {t.seen >= 2 ? '🔥' : ''}
            {t.seen}×
          </span>
        </HoverCard>
        <span className="call-mc-now">
          {mult !== undefined && (
            <Tip text={`${money(t.firstCallMarketCap)} at first call → ${money(t.marketCap)} now`}>
              <span className={`call-mult${mult >= 1 ? ' up' : ' down'}`}>{mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}×</span>
            </Tip>
          )}
          {hasPrice && money(t.marketCap) ? (
            <>
              MC <b>{money(t.marketCap)}</b>
            </>
          ) : (
            ''
          )}
        </span>
      </div>

      {/* 2 · image | identity | numbers */}
      <div className="call-mid">
        <div className="call-imgwrap">
          {t.imageUrl && !imgBroken ? (
            <img className="call-img" src={t.imageUrl} alt="" loading="lazy" onError={() => setImgBroken(true)} />
          ) : (
            <div className="call-img call-img-fallback">
              <ChainBadge network={t.network} chain={t.chain} size={26} className="net-plain" />
            </div>
          )}
          <ChainBadge network={t.network} chain={t.chain} size={11} className="net-badge" />
          {t.launchpad && (
            <span className="lp-badge">
              <LaunchpadBadge launchpad={t.launchpad} url={t.launchpadUrl} size={13} />
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
            {hasPrice && price(t.priceUsd) && <span className="call-price">{price(t.priceUsd)}</span>}
          </div>
          <div className="call-tx">
            {txTotal > 0 ? (
              <Tip text={`24h: ${buys} buys · ${sells} sells`}>
                <span className="call-txn">
                  TX {txTotal >= 1000 ? `${(txTotal / 1000).toFixed(1)}K` : txTotal}
                  <span className="txbar">
                    <span className="txbar-buy" style={{ width: `${buyPct}%` }} />
                  </span>
                </span>
              </Tip>
            ) : (
              <span className={hasPrice ? 'muted' : 'pending'}>
                {t.priceUsd === undefined && t.marketCap !== undefined ? 'bonding · no pair yet' : hasPrice ? 'no trades yet' : 'no pair yet · retrying'}
              </span>
            )}
          </div>
          <div className="call-links">
            <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} canChart={!!embed} />
          </div>
        </div>
        <div className="call-right">
          <span className="call-kv">
            {hasPrice && money(t.volume24h) ? (
              <>
                V <b>{money(t.volume24h)}</b>
              </>
            ) : (
              ' '
            )}
          </span>
          <span className="call-kv call-mc">
            {hasPrice && money(t.marketCap) ? (
              <>
                MC <b>{money(t.marketCap)}</b>
              </>
            ) : (
              <b className="muted">—</b>
            )}
          </span>
          <span className="call-kv call-ath">
            {hasPrice && money(t.athMarketCap) ? (
              <>
                ATH <b>{money(t.athMarketCap)}</b>
              </>
            ) : (
              ' '
            )}
          </span>
          <span className="call-kv">
            {hasPrice && money(t.liquidity) ? (
              <>
                Liq <b>{money(t.liquidity)}</b>
              </>
            ) : (
              ' '
            )}
          </span>
        </div>
      </div>

      {/* 3 · holder security (only once we have it) */}
      {t.security && <SecurityStrip s={t.security} />}

      {/* 4 · buys | share */}
      <div className="call-bottom">
        <BuyRow buy={t.buy} />
        <a className="share" href={telegramShareUrl(t.address, shareLabel)} target="_blank" rel="noreferrer" title="share CA on Telegram">
          <Icon name="telegram" size={13} /> share
        </a>
      </div>

      {showChart && embed && (
        <iframe className="token-chart" src={embed} title={`${t.symbol ?? 'token'} chart`} loading="lazy" allow="clipboard-write" allowFullScreen />
      )}
    </div>
  );
}
