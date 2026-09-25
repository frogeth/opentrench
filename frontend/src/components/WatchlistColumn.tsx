import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { TokenInfo, WatchAlerts, WatchEntry } from '../types';
import type { WatchSortKey } from '../api';
import { chartEmbedUrl, copyText, money, price, shortAddr, timeAgo, type ChartProvider } from '../format';
import { useVisibleToken } from '../visible';
import { DEFAULT_WATCH_SORT, TOKEN_DRAG_TYPE, lastCall, parseUsd, pct, sinceAdded, sortRows, usdInput, type WatchRow, type WatchSort } from '../watch';
import { BuyRow } from './BuyRow';
import { ChainBadge } from './ChainBadge';
import { LiveDot } from './LiveDot';
import { SecurityStrip } from './SecurityStrip';
import { TokenLinks } from './TokenLinks';

const HEADERS: { key: WatchSortKey; label: string; cls: string; title: string }[] = [
  { key: 'symbol', label: 'token', cls: 'wl-tok', title: 'ticker' },
  { key: 'price', label: 'price', cls: 'wl-price', title: 'price' },
  { key: 'marketCap', label: 'mcap', cls: 'wl-num', title: 'market cap' },
  { key: 'change1h', label: '1h', cls: 'wl-num', title: 'market cap change over the last hour' },
  { key: 'sinceAdded', label: 'added', cls: 'wl-num', title: 'market cap change since you added it' },
  { key: 'lastCall', label: 'last call', cls: 'wl-call', title: 'the latest call in your chats' },
];

/**
 * The watchlist: one compact row per token, sortable by any header, a chart + buys + alerts panel
 * under the row you click. Every watchlist column shows the same list; each keeps its own sort.
 */
export function WatchlistColumn({
  entries,
  pending,
  tokens,
  now,
  sort = DEFAULT_WATCH_SORT,
  chartProvider = 'basedbot',
  telegramConnected,
  onSort,
  onAdd,
  onRemove,
  onOpen,
  onBuy,
  onAlerts,
}: {
  entries: WatchEntry[];
  /** addresses being added (lookup in flight): shown as placeholders */
  pending: string[];
  tokens: Record<string, TokenInfo>;
  now: number;
  sort?: WatchSort;
  chartProvider?: ChartProvider;
  telegramConnected: boolean;
  onSort: (s: WatchSort) => void;
  /** any text: every contract in it gets added */
  onAdd: (text: string) => void;
  onRemove: (address: string) => void;
  onOpen: (address: string) => void;
  onBuy?: (url: string) => void;
  onAlerts: (address: string, alerts: Omit<WatchAlerts, 'fired'>) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [paste, setPaste] = useState('');
  const rows = useMemo(() => sortRows(entries.map((e) => ({ e, t: tokens[e.address] })), sort), [entries, tokens, sort]);
  // the order holds still under the pointer or while a row is open: numbers keep moving, rows don't jump
  const frozen = useRef<string[] | null>(null);
  const hold = hover || open !== null;
  if (!hold) frozen.current = null;
  else if (!frozen.current) frozen.current = rows.map((r) => r.e.address);
  const shown: WatchRow[] = useMemo(() => {
    if (!frozen.current) return rows;
    const by = new Map(rows.map((r) => [r.e.address, r]));
    const kept = frozen.current.filter((a) => by.has(a)).map((a) => by.get(a)!);
    const fresh = rows.filter((r) => !frozen.current!.includes(r.e.address));
    return [...fresh, ...kept];
  }, [rows, hold]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = pending.filter((a) => !entries.some((e) => e.address === a));

  const clickHeader = (key: WatchSortKey) => onSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' });
  const submitPaste = () => {
    if (!paste.trim()) return;
    onAdd(paste);
    setPaste('');
  };
  const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes(TOKEN_DRAG_TYPE);

  return (
    <div
      className={`wl${dropping ? ' wl-drop' : ''}`}
      onDragOver={(e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const addr = e.dataTransfer.getData(TOKEN_DRAG_TYPE);
        if (addr) onAdd(addr);
      }}
    >
      <div className="wl-add">
        <input
          className="wl-paste"
          value={paste}
          placeholder="paste contract addresses to watch"
          spellCheck={false}
          onChange={(e) => setPaste(e.target.value)}
          onPaste={(e) => {
            // a paste adds right away; typing waits for Enter
            const text = e.clipboardData.getData('text');
            if (!text.trim()) return;
            e.preventDefault();
            onAdd(text);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submitPaste()}
        />
      </div>
      {entries.length === 0 && waiting.length === 0 ? (
        <div className="empty wl-empty">
          Nothing watched yet. Add a token with ☆ on a call card, a chat's token strip or the token window, right-click any contract → Add to watchlist, paste addresses above, or drag a call card here.
        </div>
      ) : (
        <div className="wl-table" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <div className="wl-head muted">
            {HEADERS.map((h) => (
              <button key={h.key} className={`${h.cls}${sort.key === h.key ? ' on' : ''}`} title={`sort by ${h.title}`} onClick={() => clickHeader(h.key)}>
                {h.label}
                {sort.key === h.key && <span className="wl-dir">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </button>
            ))}
            <span className="wl-act" />
          </div>
          {waiting.map((a) => (
            <div key={a} className="wl-row wl-skel">
              <span className="wl-tok muted">{shortAddr(a)}</span>
              <span className="wl-price" />
              <span className="wl-num muted">…</span>
              <span className="wl-num" />
              <span className="wl-num" />
              <span className="wl-call muted">looking up</span>
              <span className="wl-act" />
            </div>
          ))}
          {shown.map((r) => (
            <Row
              key={r.e.address}
              r={r}
              now={now}
              open={open === r.e.address}
              chartProvider={chartProvider}
              telegramConnected={telegramConnected}
              onToggle={() => setOpen((o) => (o === r.e.address ? null : r.e.address))}
              onRemove={() => {
                if (open === r.e.address) setOpen(null);
                onRemove(r.e.address);
              }}
              onOpen={() => onOpen(r.e.address)}
              onBuy={onBuy}
              onAlerts={(a) => onAlerts(r.e.address, a)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 'up' / 'down' for a moment after a number changes. */
function useFlash(v: number | undefined): string {
  const prev = useRef(v);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    const p = prev.current;
    prev.current = v;
    if (p === undefined || v === undefined || p === v) return;
    setFlash(v > p ? ' flash-up' : ' flash-down');
    const id = window.setTimeout(() => setFlash(''), 700);
    return () => window.clearTimeout(id);
  }, [v]);
  return flash;
}

function Row({
  r,
  now,
  open,
  chartProvider,
  telegramConnected,
  onToggle,
  onRemove,
  onOpen,
  onBuy,
  onAlerts,
}: {
  r: WatchRow;
  now: number;
  open: boolean;
  chartProvider: ChartProvider;
  telegramConnected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onOpen: () => void;
  onBuy?: (url: string) => void;
  onAlerts: (a: Omit<WatchAlerts, 'fired'>) => void;
}) {
  const { e, t } = r;
  const ref = useVisibleToken<HTMLDivElement>(e.address);
  const [menu, setMenu] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const mcFlash = useFlash(t?.marketCap);
  const call = lastCall(t);
  // a new call on a watched token: the row pulses for a few seconds (not on first render)
  const [pulse, setPulse] = useState(false);
  const seenCall = useRef(call?.ts);
  useEffect(() => {
    if (call?.ts === undefined || call.ts === seenCall.current) return;
    seenCall.current = call.ts;
    // token data that shows up late brings its old calls along: only a call from the last minute is news
    if (Date.now() - call.ts > 60_000) return;
    setPulse(true);
    const id = window.setTimeout(() => setPulse(false), 4000);
    return () => window.clearTimeout(id);
  }, [call?.ts]); // eslint-disable-line react-hooks/exhaustive-deps
  const net = t?.network ?? e.network ?? (e.chain === 'sol' ? 'solana' : e.chain);
  const ch1 = t?.change1h;
  const since = sinceAdded(e, t);
  const hasAlerts = !!e.alerts && (e.alerts.above !== undefined || e.alerts.below !== undefined || e.alerts.movePct !== undefined);
  const embed = chartEmbedUrl(t ?? { address: e.address, network: e.network }, chartProvider);
  const callers = t ? [...new Set(t.calls.map((c) => c.chatName))].join(', ') : '';

  return (
    <div ref={ref} className={`wl-item call-net-${net}${open ? ' open' : ''}${pulse ? ' wl-pulse' : ''}`}>
      <div className="wl-row" onClick={(ev) => !(ev.target as HTMLElement).closest('button, a') && onToggle()}>
        <span className="wl-tok">
          {t?.imageUrl && !imgBroken ? <img src={t.imageUrl} alt="" loading="lazy" onError={() => setImgBroken(true)} /> : <ChainBadge network={net} chain={e.chain} size={14} className="net-plain wl-noimg" />}
          <b title={`${e.address} · ${net}`}>{t?.symbol ?? shortAddr(e.address)}</b>
          {t?.security?.honeypot && (
            <span className="wl-warn" title="security check failed: honeypot">
              ⚠
            </span>
          )}
        </span>
        <span className="wl-price">{price(t?.priceUsd) ?? '—'}</span>
        <span className={`wl-num wl-mc${mcFlash}`}>
          {money(t?.marketCap) ?? <span className="muted">{t ? 'no data yet' : '—'}</span>}
          <LiveDot t={t} />
        </span>
        <span className={`wl-num${ch1 === undefined ? ' muted' : ch1 >= 0 ? ' up' : ' down'}`}>{pct(ch1) ?? '—'}</span>
        <span className={`wl-num${since === undefined ? ' muted' : since >= 0 ? ' up' : ' down'}`} title={e.addedMarketCap ? `added at ${money(e.addedMarketCap)}` : undefined}>
          {pct(since) ?? '—'}
        </span>
        <span className="wl-call" title={callers ? `called in ${callers}` : 'nobody has called it in your chats'}>
          {call ? (
            <>
              <span className="wl-who">{call.author}</span>
              <span className="muted">
                <span className="wl-sep"> · </span>
                {timeAgo(call.ts, now)}
                {t!.calls.length > 1 ? ` · ×${t!.calls.length}` : ''}
              </span>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <span className="wl-act">
          {hasAlerts && (
            <span className="wl-bell" title="alerts set">
              🔔
            </span>
          )}
          <button className="wl-x" onClick={onRemove} title="remove from watchlist" aria-label="remove from watchlist">
            ✕
          </button>
          <button className="wl-more" onClick={() => setMenu((m) => !m)} title="more" aria-label="more">
            ⋯
          </button>
          {menu && (
            <span className="wl-menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); onOpen(); }}>Open token</button>
              <button onClick={() => { setMenu(false); void copyText(e.address); }}>Copy address</button>
              <button onClick={() => { setMenu(false); if (!open) onToggle(); }}>Set alerts…</button>
              <button onClick={() => { setMenu(false); onRemove(); }}>Remove</button>
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="wl-panel">
          {showChart && embed && <iframe className="wl-chart" src={embed} title="chart" loading="lazy" />}
          <div className="wl-panel-row">
            <TokenLinks t={t} showChart={showChart} onToggleChart={() => setShowChart((s) => !s)} canChart={!!embed} />
            <BuyRow buy={t?.buy} compact onBuy={onBuy} />
          </div>
          {t?.security && <SecurityStrip s={t.security} compact />}
          <div className="wl-added muted">
            added {timeAgo(e.addedAt, now)} ago{e.addedMarketCap ? ` at ${money(e.addedMarketCap)}` : ''}
            {t?.athMarketCap ? ` · ATH ${money(t.athMarketCap)}` : ''}
          </div>
          <AlertsEditor key={`${e.alerts?.above}|${e.alerts?.below}|${e.alerts?.movePct}|${!!e.alerts?.telegram}`} e={e} marketCap={t?.marketCap} telegramConnected={telegramConnected} onSave={onAlerts} />
        </div>
      )}
    </div>
  );
}

/** Above / below a market cap, a ±% move within an hour, and Telegram; saved when a field is left. */
function AlertsEditor({ e, marketCap, telegramConnected, onSave }: { e: WatchEntry; marketCap?: number; telegramConnected: boolean; onSave: (a: Omit<WatchAlerts, 'fired'>) => void }) {
  const a = e.alerts ?? {};
  const [above, setAbove] = useState(usdInput(a.above));
  const [below, setBelow] = useState(usdInput(a.below));
  const [move, setMove] = useState(a.movePct !== undefined ? String(a.movePct) : '');
  const [telegram, setTelegram] = useState(!!a.telegram);
  const ab = parseUsd(above);
  const be = parseUsd(below);
  const mv = move.trim() === '' ? undefined : Number(move.replace('%', '')) > 0 ? Number(move.replace('%', '')) : null;
  const valid = ab !== null && be !== null && mv !== null;
  const save = (tg = telegram) => {
    if (!valid) return;
    const next: Omit<WatchAlerts, 'fired'> = {
      ...(ab !== undefined ? { above: ab } : {}),
      ...(be !== undefined ? { below: be } : {}),
      ...(mv !== undefined ? { movePct: mv } : {}),
      ...(tg ? { telegram: true } : {}),
    };
    if (next.above === a.above && next.below === a.below && next.movePct === a.movePct && !!next.telegram === !!a.telegram) return;
    onSave(next);
  };
  const state = (kind: 'above' | 'below' | 'move', threshold?: number) => {
    if (threshold === undefined) return null;
    if (!a.fired?.[kind]) return <span className="wl-armed">armed</span>;
    if (kind === 'move') return <span className="wl-fired">fired · re-arms under {Math.round((threshold / 2) * 10) / 10}%</span>;
    const back = kind === 'above' ? threshold * 0.97 : threshold * 1.03;
    return (
      <span className="wl-fired">
        {marketCap !== undefined && (kind === 'above' ? marketCap >= threshold : marketCap <= threshold) ? `already ${kind}` : 'fired'} · re-arms {kind === 'above' ? 'under' : 'over'} {money(back)}
      </span>
    );
  };
  return (
    <div className="wl-alerts">
      <div className="wl-alerts-title">Alerts</div>
      <label>
        <span>MC above</span>
        <input className={ab === null ? 'bad' : ''} value={above} placeholder="e.g. 1.5m" onChange={(ev) => setAbove(ev.target.value)} onBlur={() => save()} onKeyDown={(ev) => ev.key === 'Enter' && save()} />
        {state('above', a.above)}
      </label>
      <label>
        <span>MC below</span>
        <input className={be === null ? 'bad' : ''} value={below} placeholder="e.g. 300k" onChange={(ev) => setBelow(ev.target.value)} onBlur={() => save()} onKeyDown={(ev) => ev.key === 'Enter' && save()} />
        {state('below', a.below)}
      </label>
      <label>
        <span>±% in 1h</span>
        <input className={mv === null ? 'bad' : ''} value={move} placeholder="e.g. 30" onChange={(ev) => setMove(ev.target.value)} onBlur={() => save()} onKeyDown={(ev) => ev.key === 'Enter' && save()} />
        {state('move', a.movePct)}
      </label>
      <label className={`wl-tg${telegramConnected ? '' : ' muted'}`} title={telegramConnected ? undefined : 'connect Telegram in ⚙ → Accounts to get these as a DM'}>
        <input
          type="checkbox"
          checked={telegram}
          disabled={!telegramConnected && !telegram}
          onChange={(ev) => {
            setTelegram(ev.target.checked);
            save(ev.target.checked);
          }}
        />
        <span>also DM me on Telegram{telegramConnected ? '' : ' (Telegram not connected)'}</span>
      </label>
      <div className="wl-alerts-note muted">Each alert fires once, then re-arms after the market cap crosses back. Sound + Pings; checked by the app while it runs.</div>
    </div>
  );
}
