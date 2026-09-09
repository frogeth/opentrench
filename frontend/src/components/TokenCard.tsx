import { useState } from 'react';
import type { Contract, TokenInfo } from '../types';

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

export function TokenCard({ c, t }: { c: Contract; t?: TokenInfo }) {
  const [copied, setCopied] = useState(false);
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
  const change = t?.change24h;
  const links: [string, string | undefined][] = [
    ['chart', t?.chartUrl],
    ['web', t?.website],
    ['𝕏', t?.twitter],
    ['tg', t?.telegram],
  ];

  return (
    <div className={`token token-${c.chain}`}>
      {t?.imageUrl ? (
        <img className="token-img" src={t.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className="token-img token-img-fallback">{c.chain.toUpperCase()}</div>
      )}
      <div className="token-body">
        <div className="token-head">
          <button className="token-sym" onClick={copy} title={`${c.address}\nclick to copy`}>
            {copied ? 'copied' : (t?.symbol ?? short)}
          </button>
          {t?.name && t.name !== t.symbol && <span className="token-name">{t.name}</span>}
          <span className="token-seen">called {t?.seen ?? 1}×</span>
        </div>
        <div className="token-stats">
          <span className="token-addr" onClick={copy}>
            {short}
          </span>
          {price(t?.priceUsd) && <span>{price(t?.priceUsd)}</span>}
          {money(t?.marketCap) && <span>MC {money(t?.marketCap)}</span>}
          {money(t?.liquidity) && <span>Liq {money(t?.liquidity)}</span>}
          {change !== undefined && (
            <span className={change >= 0 ? 'up' : 'down'}>
              {change >= 0 ? '+' : ''}
              {change.toFixed(1)}%
            </span>
          )}
        </div>
        <div className="token-links">
          {links.map(([label, url]) =>
            url ? (
              <a key={label} href={url} target="_blank" rel="noreferrer">
                {label}
              </a>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
