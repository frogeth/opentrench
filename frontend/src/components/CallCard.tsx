import { useContext, useState } from 'react';
import type { CallRecord, TokenInfo } from '../types';
import { chartEmbedUrl, copyText, isFavorite, money, price, shortAddr, telegramShareUrl, timeAgo, type ChartProvider } from '../format';
import { Avatar } from './Avatar';
import { CaMenuContext } from './RichText';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { AuthorMenu } from './AuthorMenu';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';
import { HoverCard, Tip } from './HoverCard';
import { SecurityStrip } from './SecurityStrip';

const chatOf = (c: CallRecord) => c.chatName.replace(/\s*\([^)]*\)\s*$/, '');
const fmtX = (x: number) => `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x`;

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
                <Logo source={c.source} size={9} /> {chatOf(c)}
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

/**
 * One call, three lines in ~150px: caller · channel · age | MC at call · x,
 * then image | symbol / age · CA / links · holders · TX, then risk chips | buys.
 */
export function CallCard({
  t,
  now,
  selected = false,
  favorites,
  chartProvider = 'basedbot',
  onOpen,
  onShare,
  onBuy,
  seen = true,
  onSeen,
}: {
  t: TokenInfo;
  now: number;
  selected?: boolean;
  favorites: string[];
  chartProvider?: ChartProvider;
  /** open the drill-down for this token */
  onOpen?: (address: string) => void;
  /** open the share-to-chats dialog */
  onShare?: (address: string, symbol?: string) => void;
  /** Cove buttons open the in-app Cove tab */
  onBuy?: (url: string) => void;
  /** inbox-style: false = not looked at yet (card tinted), toggled by the check button */
  seen?: boolean;
  onSeen?: (on: boolean) => void;
}) {
  const caMenu = useContext(CaMenuContext);
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
  // the call this card represents: the latest one (repeat callers move a token back to the top)
  const c: CallRecord | undefined = t.calls[t.calls.length - 1] ?? (t.firstCaller ? { ...t.firstCaller } : undefined);
  const isFirst = t.calls.length <= 1;
  const buys = t.buys24h ?? 0;
  const sells = t.sells24h ?? 0;
  const txTotal = buys + sells;
  const buyPct = txTotal ? Math.round((buys / txTotal) * 100) : 50;
  const shareLabel = `${t.symbol ? `$${t.symbol}` : ''}${t.name && t.name !== t.symbol ? ` ${t.name}` : ''}${
    c ? ` · called by ${c.author} in ${c.chatName}` : ''
  }`.trim();
  const hot = t.seen >= 3 ? ' call-hot-3' : t.seen === 2 ? ' call-hot-2' : '';
  const isNew = now - t.firstSeenTs < 8000;
  const mcAt = c?.marketCap ?? t.firstCallMarketCap;
  const mult = t.marketCap && mcAt ? t.marketCap / mcAt : undefined;
  const nearAth = t.marketCap && t.athMarketCap ? t.marketCap >= t.athMarketCap * 0.95 : false;

  return (
    <div id={`call-${t.address}`} className={`call${showChart ? ' call-open' : ''}${selected ? ' call-selected' : ''}${isNew ? ' call-new' : ''}${onSeen && !seen ? ' call-unseen' : ''}${hot}`}>
      {t.seen >= 2 && <span key={t.lastCallTs} className="call-pulse" />}

      {/* 1 · caller meta */}
      <div className="call-top">
        {c ? (
          <>
            <span className="call-who">
              <Avatar src={c.avatar} name={c.author} size={16} crown={isFavorite(favorites, c.author)} />
              <span className="call-author">{c.author}</span>
              <AuthorMenu author={c.author} link={c.link} favorite={isFavorite(favorites, c.author)} />
            </span>
            <span className="call-dot">·</span>
            <span className="call-chat" title={c.chatName}>
              <Logo source={c.source} size={10} />
              {chatOf(c)}
            </span>
            <span className="call-dot">·</span>
          </>
        ) : null}
        <span className="call-age">{timeAgo(t.lastCallTs ?? t.firstSeenTs, now)}</span>
        {isFirst ? (
          <span className="first-badge">1st</span>
        ) : (
          <HoverCard width={300} card={<CallsList t={t} now={now} />}>
            <span className={`call-seen${t.seen >= 2 ? ' call-seen-hot' : ''}`}>🔥{t.seen}×</span>
          </HoverCard>
        )}
        <span className="call-top-right">
          {c?.link && (
            <a className="call-jump" href={c.link} target="_blank" rel="noreferrer" title="jump to message">
              <Icon name="chat" size={13} />
            </a>
          )}
          {money(mcAt) && <span className="call-mcat">MC: {money(mcAt)}</span>}
          {mult !== undefined && (
            <Tip text={`${money(mcAt)} at call → ${money(t.marketCap)} now`}>
              <span className={`call-mult${mult >= 1 ? ' up' : ' down'}`}>{fmtX(mult)}</span>
            </Tip>
          )}
          {onSeen && (
            <Tip text={seen ? 'seen · click to mark unseen' : 'mark as seen'}>
              <button className={`call-check${seen ? ' on' : ''}`} onClick={() => onSeen(!seen)} aria-label={seen ? 'mark unseen' : 'mark seen'}>
                {seen ? '✓' : ''}
              </button>
            </Tip>
          )}
        </span>
      </div>

      {/* 2 · image | info */}
      <div className="call-mid">
        <div className="call-imgwrap call-imgwrap-open" onClick={() => onOpen?.(t.address)} title="open details">
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
          <div className="call-line">
            <button className="call-sym" onClick={copy} title={`${t.address}\nclick to copy`}>
              {copied ? 'copied' : (t.symbol ?? shortAddr(t.address))}
            </button>
            {t.name && t.name !== t.symbol && <span className="call-name">{t.name}</span>}
            <span className="call-line-r">
              {hasPrice && money(t.volume24h) && (
                <span className="call-kv call-vol">
                  V <b>{money(t.volume24h)}</b>
                </span>
              )}
              <span className="call-kv call-mc">
                MC <b>{money(t.marketCap) ?? '—'}</b>
              </span>
            </span>
          </div>
          <div className="call-line call-sub">
            {t.pairCreatedAt && <span className="call-age-tok" title="token age">{timeAgo(t.pairCreatedAt, now)}</span>}
            {t.pairCreatedAt && <span className="call-dot">|</span>}
            <span
              className="call-addr"
              onClick={copy}
              title="click to copy · right-click for buy / research"
              onContextMenu={(e) => {
                if (!caMenu) return;
                e.preventDefault();
                caMenu(t.address, e.clientX, e.clientY);
              }}
            >
              {shortAddr(t.address)} <Icon name="copy" size={10} />
            </span>
            {hasPrice && price(t.priceUsd) && <span className="call-price">{price(t.priceUsd)}</span>}
            <span className="call-line-r">
              {money(t.athMarketCap) && <span className={`call-ath${nearAth ? ' near' : ''}`}>ATH: {money(t.athMarketCap)}</span>}
            </span>
          </div>
          <div className="call-line call-links">
            <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} canChart={!!embed} />
            <span className="call-line-r">
              {t.security?.holders !== undefined && (
                <Tip text={`${t.security.holders.toLocaleString()} holders`}>
                  <span className="call-holders">
                    <Icon name="people" size={11} />
                    {t.security.holders >= 1e6 ? `${(t.security.holders / 1e6).toFixed(1)}M` : t.security.holders >= 1000 ? `${(t.security.holders / 1000).toFixed(1)}K` : t.security.holders}
                  </span>
                </Tip>
              )}
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
                <span className={hasPrice ? 'call-pending' : 'call-pending'}>
                  {t.priceUsd === undefined && t.marketCap !== undefined ? 'bonding' : hasPrice ? 'no trades' : 'no pair yet'}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* 3 · risk chips | buys */}
      <div className="call-bottom">
        {t.security ? <SecurityStrip s={t.security} compact /> : <span className="call-pending">holder data pending…</span>}
        <BuyRow buy={t.buy} onBuy={onBuy} />
        {onShare ? (
          <button className="share" onClick={() => onShare(t.address, t.symbol)} title="share the CA to chats in your feed">
            <Icon name="send" size={12} />
          </button>
        ) : (
          <a className="share" href={telegramShareUrl(t.address, shareLabel)} target="_blank" rel="noreferrer" title="share CA on Telegram">
            <Icon name="telegram" size={12} />
          </a>
        )}
      </div>

      {showChart && embed && (
        <iframe className="token-chart" src={embed} title={`${t.symbol ?? 'token'} chart`} loading="lazy" allow="clipboard-write" allowFullScreen />
      )}
    </div>
  );
}
