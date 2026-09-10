import { useEffect, useState } from 'react';
import { api } from '../api';

const fmt = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString()}` : n >= 100 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);

/** BTC / ETH / SOL / HYPE in the top bar, refreshed every minute. */
export function Tickers() {
  const [rows, setRows] = useState<{ sym: string; usd: number; change24h: number }[]>([]);
  useEffect(() => {
    const load = () => api.tickers().then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => {});
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (rows.length === 0) return null;
  return (
    <div className="tickers">
      {rows.map((r) => (
        <span key={r.sym} className="ticker" title={`${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(2)}% 24h`}>
          {r.sym}
          <b>{fmt(r.usd)}</b>
          <i className={r.change24h >= 0 ? 'up' : 'down'}>{r.change24h >= 0 ? '▲' : '▼'}</i>
        </span>
      ))}
    </div>
  );
}
