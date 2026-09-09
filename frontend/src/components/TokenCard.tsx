import { useState } from 'react';
import type { Contract, TokenInfo } from '../types';
import { Icon, type IconName } from './Icon';

function money(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function price(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

const NETWORK_LABEL: Record<string, string> = {
  ethereum: 'ETH',
  base: 'BASE',
  bsc: 'BNB',
  arbitrum: 'ARB',
  polygon: 'POL',
  avalanche: 'AVAX',
  robinhood: 'RH',
  solana: 'SOL',
};

export function TokenCard({ c, t }: { c: Contract; t?: TokenInfo }) {
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const short = `${c.address.slice(0, 4)}…${c.address.slice(-4)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.address);
    } catch {
      /* ignore */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const hasPrice = t?.priceUsd !== undefined;
  const change = hasPrice ? t?.change24h : undefined;
  const net = t?.network;
  const netLabel = net ? (NETWORK_LABEL[net] ?? net.toUpperCase().slice(0, 5)) : c.chain.toUpperCase();
  const links: [IconName, string, string | undefined][] = [
    ['chart', 'open chart', t?.chartUrl],
    ['globe', 'website', t?.website],
    ['x', 'X / Twitter', t?.twitter],
    ['telegram', 'Telegram', t?.telegram],
    ['explorer', 'explorer', t?.explorerUrl],
  ];

  return (
    <div className={`token token-${c.chain}${showChart ? ' token-open' : ''}`}>
      <div className="token-row">
        {t?.imageUrl ? (
          <img className="token-img" src={t.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="token-img token-img-fallback">{netLabel}</div>
        )}
        <div className="token-body">
          <div className="token-head">
            <button className="token-sym" onClick={copy} title={`${c.address}\nclick to copy`}>
              {copied ? 'copied' : (t?.symbol ?? short)}
            </button>
            {t?.name && t.name !== t.symbol && <span className="token-name">{t.name}</span>}
            {net && <span className={`net net-${net}`}>{netLabel}</span>}
            <span
              className="token-seen"
              title={t?.calledIn?.length ? `called in:\n${t.calledIn.join('\n')}` : undefined}
            >
              called {t?.seen ?? 1}×
            </span>
          </div>
          <div className="token-stats">
            <span className="token-addr" onClick={copy} title="click to copy">
              {short} <Icon name="copy" size={11} />
            </span>
            {hasPrice && price(t?.priceUsd) && <span>{price(t?.priceUsd)}</span>}
            {hasPrice && money(t?.marketCap) && <span>MC {money(t?.marketCap)}</span>}
            {hasPrice && money(t?.liquidity) && <span>Liq {money(t?.liquidity)}</span>}
            {change !== undefined && (
              <span className={change >= 0 ? 'up' : 'down'}>
                {change >= 0 ? '+' : ''}
                {change.toFixed(1)}%
              </span>
            )}
            {t && t.priceUsd === undefined && <span className="token-pending">no pair yet · retrying</span>}
          </div>
          <div className="token-links">
            {t?.embedUrl && (
              <button
                className={`token-link${showChart ? ' active' : ''}`}
                onClick={() => setShowChart((s) => !s)}
                title={showChart ? 'hide live chart' : 'live chart'}
              >
                <Icon name="live" /> <span>{showChart ? 'hide' : 'live'}</span>
              </button>
            )}
            {links.map(([icon, label, url]) =>
              url ? (
                <a key={icon} className="token-link" href={url} target="_blank" rel="noreferrer" title={label}>
                  <Icon name={icon} />
                </a>
              ) : null,
            )}
          </div>
        </div>
      </div>
      {showChart && t?.embedUrl && (
        <iframe
          className="token-chart"
          src={t.embedUrl}
          title={`${t.symbol ?? short} chart`}
          loading="lazy"
          allow="clipboard-write"
        />
      )}
    </div>
  );
}
