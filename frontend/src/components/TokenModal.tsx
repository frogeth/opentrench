import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { CallRecord, TokenInfo } from '../types';
import { api } from '../api';
import { copyText, isFavorite, money, price, shortAddr, telegramShareUrl, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { BuyRow } from './BuyRow';
import { TokenLinks } from './TokenLinks';
import { ChainBadge } from './ChainBadge';
import { LaunchpadBadge } from './LaunchpadBadge';
import { SecurityStrip } from './SecurityStrip';
import { Tip } from './HoverCard';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type Interval = (typeof INTERVALS)[number];
type Tab = 'recent' | 'top' | 'earliest';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const chatOf = (c: CallRecord) => c.chatName.replace(/\s*\([^)]*\)\s*$/, '');
const serverOf = (c: CallRecord) => {
  const m = /\(([^)]*)\)\s*$/.exec(c.chatName);
  return m ? m[1] : chatOf(c);
};

/**
 * Token drill-down: header like the call card, server chips, a candlestick
 * chart (market cap axis) with every call pinned on it, and the callers list.
 */
export function TokenModal({ t, now, favorites, onClose, onShare, onBuy }: { t: TokenInfo; now: number; favorites: string[]; onClose: () => void; onShare?: (address: string, symbol?: string) => void; onBuy?: (url: string) => void }) {
  const [interval, setInterval_] = useState<Interval>('5m');
  const [server, setServer] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('recent');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [mcPerPrice, setMcPerPrice] = useState<number | undefined>(undefined);
  const [chartState, setChartState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [copied, setCopied] = useState(false);
  const [showChart, setShowChart] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // candles (refetched when the interval changes, refreshed every 30s)
  useEffect(() => {
    let dead = false;
    const load = () =>
      api
        .ohlcv(t.address, interval)
        .then((r) => {
          if (dead) return;
          setCandles(r.candles);
          setMcPerPrice(r.mcPerPrice);
          setChartState(r.candles.length ? 'ready' : 'none');
        })
        .catch(() => !dead && setChartState('none'));
    setChartState('loading');
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [t.address, interval]);

  const servers = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of t.calls) m.set(serverOf(c), (m.get(serverOf(c)) ?? 0) + 1);
    return [...m.entries()];
  }, [t.calls]);
  const calls = useMemo(() => (server ? t.calls.filter((c) => serverOf(c) === server) : t.calls), [t.calls, server]);
  const listed = useMemo(() => {
    const withX = calls.map((c) => ({ c, x: c.marketCap && t.marketCap ? t.marketCap / c.marketCap : undefined }));
    if (tab === 'earliest') return withX;
    if (tab === 'top') return [...withX].sort((a, b) => (b.x ?? -1) - (a.x ?? -1));
    return [...withX].reverse();
  }, [calls, tab, t.marketCap]);
  const firstId = t.calls[0]?.msgId;

  const copy = async () => {
    await copyText(t.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const buys = t.buys24h ?? 0;
  const sells = t.sells24h ?? 0;
  const txTotal = buys + sells;
  const buyPct = txTotal ? Math.round((buys / txTotal) * 100) : 50;
  const mult = t.marketCap && t.firstCallMarketCap ? t.marketCap / t.firstCallMarketCap : undefined;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tmodal">
        {/* header */}
        <div className="tmodal-head">
          <div className="call-imgwrap">
            {t.imageUrl ? (
              <img className="call-img" src={t.imageUrl} alt="" />
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
          <div className="tmodal-id">
            <div className="tmodal-title">
              <button className="call-sym" onClick={copy} title={`${t.address}\nclick to copy`}>
                {copied ? 'copied' : (t.symbol ?? shortAddr(t.address))}
              </button>
              {t.name && t.name !== t.symbol && <span className="call-name">{t.name}</span>}
              {mult !== undefined && <span className={`call-mult${mult >= 1 ? ' up' : ' down'}`}>{mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}×</span>}
            </div>
            <div className="call-sub">
              {t.pairCreatedAt && <span title="token age">{timeAgo(t.pairCreatedAt, now)}</span>}
              <span className="call-addr" onClick={copy} title="click to copy">
                {shortAddr(t.address)} <Icon name="copy" size={10} />
              </span>
              {price(t.priceUsd) && <span className="call-price">{price(t.priceUsd)}</span>}
            </div>
            <div className="tmodal-links">
              <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} canChart={false} />
              {txTotal > 0 && (
                <Tip text={`24h: ${buys} buys · ${sells} sells`}>
                  <span className="call-txn">
                    TX {txTotal >= 1000 ? `${(txTotal / 1000).toFixed(1)}K` : txTotal}
                    <span className="txbar">
                      <span className="txbar-buy" style={{ width: `${buyPct}%` }} />
                    </span>
                  </span>
                </Tip>
              )}
            </div>
          </div>
          <div className="call-right tmodal-nums">
            <span className="call-kv">{money(t.volume24h) ? <>V <b>{money(t.volume24h)}</b></> : ' '}</span>
            <span className="call-kv call-mc">{money(t.marketCap) ? <>MC <b>{money(t.marketCap)}</b></> : <b className="muted">—</b>}</span>
            <span className="call-kv call-ath">{money(t.athMarketCap) ? <>ATH <b>{money(t.athMarketCap)}</b></> : ' '}</span>
            <span className="call-kv">{money(t.liquidity) ? <>Liq <b>{money(t.liquidity)}</b></> : ' '}</span>
          </div>
          <button className="close tmodal-close" onClick={onClose} title="close (Esc)">
            ✕
          </button>
        </div>
        <div className="tmodal-row2">
          {t.security ? <SecurityStrip s={t.security} /> : <span className="hint">holder data pending…</span>}
          <div className="tmodal-buy">
            <BuyRow buy={t.buy} compact onBuy={onBuy} />
            {onShare ? (
              <button className="share" onClick={() => onShare(t.address, t.symbol)} title="share the CA to chats in your feed">
                <Icon name="send" size={13} /> share
              </button>
            ) : (
              <a className="share" href={telegramShareUrl(t.address, t.symbol ? `$${t.symbol}` : t.address)} target="_blank" rel="noreferrer">
                <Icon name="telegram" size={13} /> share
              </a>
            )}
          </div>
        </div>

        {/* body */}
        <div className="tmodal-body">
          <div className="tmodal-chart-col">
            <div className="tmodal-chips">
              <button className={`srv-chip${server === null ? ' active' : ''}`} onClick={() => setServer(null)}>
                All servers <b>{t.calls.length}</b>
              </button>
              {servers.map(([name, n]) => (
                <button key={name} className={`srv-chip${server === name ? ' active' : ''}`} onClick={() => setServer(server === name ? null : name)}>
                  {name} <b>{n}</b>
                </button>
              ))}
            </div>
            <div className="tmodal-intervals">
              {INTERVALS.map((i) => (
                <button key={i} className={interval === i ? 'active' : ''} onClick={() => setInterval_(i)}>
                  {i}
                </button>
              ))}
              <span className="tmodal-onchart">
                {chartState === 'ready' && (
                  <>
                    <span className="dot" /> {calls.length} of {t.calls.length} calls on chart
                  </>
                )}
              </span>
            </div>
            <CandleChart candles={candles} mcPerPrice={mcPerPrice} calls={calls} state={chartState} now={now} />
          </div>
          <div className="tmodal-calls">
            <div className="tmodal-tabs">
              <button className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')}>
                Recent
              </button>
              <button className={tab === 'top' ? 'active' : ''} onClick={() => setTab('top')}>
                Top X
              </button>
              <button className={tab === 'earliest' ? 'active' : ''} onClick={() => setTab('earliest')}>
                Earliest
              </button>
              <span className="tmodal-count">{listed.length}</span>
            </div>
            <div className="tmodal-list">
              {listed.length === 0 && <div className="hint">no calls yet</div>}
              {listed.map(({ c, x }) => (
                <a key={c.msgId} className="tcall" href={c.link} target="_blank" rel="noreferrer">
                  <Avatar src={c.avatar} name={c.author} size={28} crown={isFavorite(favorites, c.author)} />
                  <span className="tcall-main">
                    <span className="tcall-who">
                      <b>{c.author}</b>
                      {c.msgId === firstId && <span className="first-badge">1st</span>}
                    </span>
                    <span className="tcall-where">
                      <Logo source={c.source} size={9} /> {serverOf(c)}
                      {chatOf(c) !== serverOf(c) && <> / {chatOf(c)}</>} · {timeAgo(c.ts, now)}
                    </span>
                  </span>
                  <span className="tcall-nums">
                    <span className="tcall-mc">{money(c.marketCap) ?? '—'}</span>
                    {x !== undefined && <span className={`tcall-x${x >= 1 ? ' up' : ' down'}`}>{x >= 10 ? x.toFixed(0) : x.toFixed(1)}x</span>}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Candlesticks on a market-cap axis with each call's avatar pinned where it happened. */
function CandleChart({ candles, mcPerPrice, calls, state, now }: { candles: Candle[]; mcPerPrice?: number; calls: CallRecord[]; state: 'loading' | 'ready' | 'none'; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [pins, setPins] = useState<{ c: CallRecord; x: number; y: number; more: number }[]>([]);
  const k = mcPerPrice ?? 1;

  useEffect(() => {
    if (!box.current) return;
    const ch = createChart(box.current, {
      layout: { background: { color: '#0a0c0f' }, textColor: '#7d8597', fontSize: 11 },
      grid: { vertLines: { color: '#151923' }, horzLines: { color: '#151923' } },
      rightPriceScale: { borderColor: '#1e2430' },
      timeScale: { borderColor: '#1e2430', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => money(v) ?? String(v) },
      autoSize: true,
    });
    const s = ch.addCandlestickSeries({
      upColor: '#3ddc84',
      downColor: '#ff5c5c',
      wickUpColor: '#3ddc84',
      wickDownColor: '#ff5c5c',
      borderVisible: false,
      priceFormat: { type: 'custom', formatter: (v: number) => money(v) ?? String(v), minMove: 0.000001 },
    });
    chart.current = ch;
    series.current = s;
    return () => {
      ch.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // data
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o * k, high: c.h * k, low: c.l * k, close: c.c * k })));
    chart.current?.timeScale().fitContent();
  }, [candles, k]);

  // pins follow the visible range
  useEffect(() => {
    const ch = chart.current;
    const s = series.current;
    if (!ch || !s) return;
    const place = () => {
      if (candles.length === 0) {
        setPins([]);
        return;
      }
      const first = candles[0].t;
      const last = candles[candles.length - 1].t;
      const step = candles.length > 1 ? candles[1].t - candles[0].t : 60;
      const raw: { c: CallRecord; x: number; y: number }[] = [];
      for (const c of calls) {
        const ts = Math.min(Math.max(Math.floor(c.ts / 1000), first), last);
        const bucket = first + Math.floor((ts - first) / step) * step;
        const candle = candles.find((cd) => cd.t === bucket) ?? candles[candles.length - 1];
        const y0 = c.marketCap !== undefined && mcPerPrice ? c.marketCap : candle.c * k;
        const x = ch.timeScale().timeToCoordinate(bucket as UTCTimestamp);
        const y = s.priceToCoordinate(y0);
        if (x === null || y === null) continue;
        raw.push({ c, x, y });
      }
      // cluster pins that would overlap
      raw.sort((a, b) => a.x - b.x);
      const out: { c: CallRecord; x: number; y: number; more: number }[] = [];
      for (const p of raw) {
        const prev = out[out.length - 1];
        if (prev && Math.abs(prev.x - p.x) < 16 && Math.abs(prev.y - p.y) < 16) prev.more++;
        else out.push({ ...p, more: 0 });
      }
      setPins(out);
    };
    place();
    const ts = ch.timeScale();
    ts.subscribeVisibleLogicalRangeChange(place);
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(place);
      ro.disconnect();
    };
  }, [candles, calls, k, mcPerPrice]);

  return (
    <div className="tmodal-chart">
      <div ref={box} className="tmodal-canvas" />
      {pins.map((p) => (
        <Tip key={p.c.msgId} text={`${p.c.author} · ${serverOf(p.c)} · ${money(p.c.marketCap) ?? ''} · ${timeAgo(p.c.ts, now)}`}>
          <span className="pin" style={{ left: p.x, top: p.y }}>
            <Avatar src={p.c.avatar} name={p.c.author} size={22} />
            {p.more > 0 && <span className="pin-more">+{p.more}</span>}
          </span>
        </Tip>
      ))}
      {state === 'loading' && <div className="tmodal-chart-msg">loading chart…</div>}
      {state === 'none' && <div className="tmodal-chart-msg">no chart data for this pool yet</div>}
    </div>
  );
}
