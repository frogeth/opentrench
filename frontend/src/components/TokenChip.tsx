import { CaMenuContext } from './RichText';
import { useContext, useState } from 'react';
import type { Contract, TokenInfo } from '../types';
import { chartEmbedUrl, copyText, money, shortAddr, type ChartProvider } from '../format';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';
import { useVisible } from '../useVisible';

/** Compact token strip under a chat message: image with badges, ticker, the numbers that matter, links, buys. */
export function TokenChip({
  c,
  t,
  onSelect,
  autoChart = false,
  chartProvider = 'basedbot',
  repeat = false,
}: {
  c: Contract;
  t?: TokenInfo;
  onSelect?: (address: string) => void;
  /** open the live chart without a click (only loads while on screen) */
  autoChart?: boolean;
  chartProvider?: ChartProvider;
  /** this chat already had this contract: badge it instead of dimming the message */
  repeat?: boolean;
}) {
  const embed = chartEmbedUrl(t, chartProvider);
  const caMenu = useContext(CaMenuContext);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<boolean | null>(null);
  const showChart = manual ?? autoChart;
  const setShowChart = (f: (s: boolean) => boolean) => setManual(f(showChart));
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [imgBroken, setImgBroken] = useState(false);
  const copy = async () => {
    await copyText(c.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const hasPrice = t?.priceUsd !== undefined || t?.marketCap !== undefined;
  const hot = (t?.seen ?? 1) >= 2;
  return (
    <div ref={ref} className={`chip${showChart ? ' chip-open' : ''}${hot ? ' chip-hot' : ''}`}>
      <div className="chip-row">
        <div className="chip-imgwrap" onClick={() => onSelect?.(c.address)} title="show in Calls">
          {t?.imageUrl && !imgBroken ? (
            <img className="chip-img" src={t.imageUrl} alt="" loading="lazy" onError={() => setImgBroken(true)} />
          ) : (
            <div className="chip-img chip-img-fallback">
              <ChainBadge network={t?.network} chain={c.chain} size={14} className="net-plain" />
            </div>
          )}
          <ChainBadge network={t?.network} chain={c.chain} size={9} className="chip-net" />
          {t?.launchpad && (
            <span className="chip-lp">
              <LaunchpadBadge launchpad={t.launchpad} url={t.launchpadUrl} size={10} />
            </span>
          )}
        </div>
        <div className="chip-body">
          <div className="chip-line">
            <button className="chip-sym" onClick={() => onSelect?.(c.address)} title={`${c.address}\nclick to show in Calls`}>
              {t?.symbol ?? shortAddr(c.address)}
            </button>
            {t?.name && t.name !== t.symbol && <span className="chip-name">{t.name}</span>}
            {repeat && (
              <span className="chip-repeat" title="already posted in this chat">
                🔁 repeat
              </span>
            )}
            <span
              className="chip-addr"
              onClick={copy}
              title="click to copy · right-click for buy / research"
              onContextMenu={(e) => {
                if (!caMenu) return;
                e.preventDefault();
                caMenu(c.address, e.clientX, e.clientY);
              }}
            >
              {copied ? 'copied' : shortAddr(c.address)}
            </span>
            {showChart && (
              <span className={`chip-seen${hot ? ' hot' : ''}`}>
                {hot ? '🔥 ' : ''}
                {t?.seen ?? 1}×
              </span>
            )}
          </div>
          {!showChart && (
          <div className="chip-line chip-stats">
            {hasPrice ? (
              <>
                {money(t?.marketCap) && (
                  <span>
                    MC <b>{money(t?.marketCap)}</b>
                  </span>
                )}
                {t?.change24h !== undefined && (
                  <span className={t.change24h >= 0 ? 'up' : 'down'}>
                    {t.change24h >= 0 ? '+' : ''}
                    {t.change24h.toFixed(1)}%
                  </span>
                )}
                {money(t?.liquidity) && <span>Liq {money(t?.liquidity)}</span>}
              </>
            ) : (
              <span className="pending">no pair yet</span>
            )}
            <span className={`chip-seen${hot ? ' hot' : ''}`}>
              {hot ? '🔥 ' : ''}
              {t?.seen ?? 1}×
            </span>
          </div>
          )}
        </div>
        <div className="chip-actions">
          <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} canChart={!!embed} />
          <BuyRow buy={t?.buy} compact />
        </div>
      </div>
      {embed && (
        <button className="chip-expand" onClick={() => setShowChart((s) => !s)} title={showChart ? 'collapse the chart' : 'open the live chart'}>
          {showChart ? '▴ hide chart' : '▾ chart'}
        </button>
      )}
      {showChart && embed && (
        <div className="chip-chart">
          {visible ? (
            <iframe className="token-chart" src={embed} title="chart" allow="clipboard-write" allowFullScreen />
          ) : (
            <div className="token-chart token-chart-idle" />
          )}
        </div>
      )}
    </div>
  );
}
