import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { MintJob } from '../types';
import { api } from '../api';
import { copyText } from '../format';
import { Icon } from './Icon';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', robinhood: 'https://robin.etherscan.io/tx/', ink: 'https://explorer.inkonchain.com/tx/', arc: 'https://www.arcexplorer.org/tx/' };
const ethFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const eth = (wei?: string, sym = 'ETH') => (wei === undefined ? '—' : `${ethFmt.format(Number(wei) / 1e18)} ${sym}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const stageLabel = (t: string) => t.toLowerCase().replace(/_/g, ' ').replace('sale', '').trim() || 'stage';
/** mm:ss under an hour, then the coarser form */
const countdown = (iso?: string, now = Date.now()) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  if (ms >= 3600e3) return until(iso, now);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const until = (iso?: string, now = Date.now()) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'ended';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${Math.floor((ms % 3600e3) / 60e3)}m` : `${Math.floor(ms / 60e3)}m`;
};

const unitFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });
const whenStage = (s: { startTime?: string; endTime?: string }, now: number): { text: string; live: boolean; over: boolean } => {
  const start = Date.parse(s.startTime ?? ''), end = Date.parse(s.endTime ?? '');
  if (Number.isFinite(end) && now >= end) return { text: 'ended', live: false, over: true };
  if (Number.isFinite(start) && now < start) return { text: `starts in ${countdown(s.startTime, now)}`, live: false, over: false };
  return { text: Number.isFinite(end) ? `live · ends in ${until(s.endTime, now)}` : 'live', live: true, over: false };
};

/** Supply, floor and the whole schedule, the way OpenSea's mint page lays it out. */
function DropInfo({ j, now, floorInline = false }: { j: MintJob; now: number; /** the floor is already in the panel head */ floorInline?: boolean }) {
  const d = j.drop;
  if (!d) return null;
  const left = d.minted !== undefined && d.max !== undefined ? Math.max(0, d.max - d.minted) : undefined;
  const pct = d.minted !== undefined && d.max ? Math.min(100, (d.minted / d.max) * 100) : undefined;
  return (
    <div className="osj-drop">
      {(d.minted !== undefined || d.floor) && (
        <div className="osj-supply">
          {d.minted !== undefined && (
            <span>
              <b>{d.minted.toLocaleString()}</b>
              {d.max !== undefined && <span className="muted"> / {d.max.toLocaleString()} minted</span>}
              {left !== undefined && <span className={left === 0 ? 'err' : 'muted'}> · {left === 0 ? 'sold out' : `${left.toLocaleString()} left`}</span>}
            </span>
          )}
          {d.floor && !floorInline && (
            <span className="muted">
              floor {unitFmt.format(d.floor.unit)} {d.floor.symbol}
              {d.floor.usd !== undefined ? ` ≈ $${d.floor.usd.toFixed(2)}` : ''}
            </span>
          )}
        </div>
      )}
      {pct !== undefined && (
        <div className="osj-bar" title={`${pct.toFixed(1)}% minted`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {d.disabledReason && <div className="osj-err">{d.disabledReason}</div>}
      {d.stages.length > 0 && (
        <div className="osj-sched">
          {d.stages.map((s) => {
            const w = whenStage(s, now);
            const mine = j.stage && j.stage.type === s.type && j.stage.index === s.index;
            return (
              <div key={`${s.type}:${s.index}`} className={`osj-stage${w.live ? ' live' : ''}${w.over ? ' over' : ''}${mine ? ' mine' : ''}`}>
                <span className="osj-stage-dot" />
                <span className="osj-stage-main">
                  <b>{s.label}</b>
                  <span className="muted">
                    {' '}
                    · {w.text}
                    {s.startTime && !w.live && !w.over ? ` (${new Date(s.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}
                  </span>
                  <span className="osj-stage-sub muted">
                    {s.priceUnit !== undefined ? (s.priceUnit === 0 ? 'free' : `${unitFmt.format(s.priceUnit)} ${s.priceSymbol ?? ''}${s.priceUsd !== undefined ? ` ≈ $${s.priceUsd.toFixed(2)}` : ''}`) : ''}
                    {s.maxPerWallet !== undefined ? ` · limit ${s.maxPerWallet} per wallet` : ''}
                    {s.allowlistCount !== undefined ? ` · allowlist of ${s.allowlistCount.toLocaleString()}` : ''}
                  </span>
                </span>
                <span className={`osj-elig ${s.eligible === true ? 'up' : s.eligible === false ? 'err' : 'muted'}`}>{s.eligible === true ? 'eligible' : s.eligible === false ? 'not eligible' : ''}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<MintJob['state'], string> = { quoting: 'Quoting…', waiting: 'Waiting', ready: 'Ready to mint', sending: 'Sending', pending: 'In flight', confirmed: 'Minted', failed: 'Failed' };
const isExpired = (j: MintJob, now: number) => j.state === 'ready' && now - j.ts > 120_000;
const txUrl = (j: MintJob) => (j.txHash && EXPLORER[j.collection.chain] ? `${EXPLORER[j.collection.chain]}${j.txHash}` : undefined);
/** one line that says where a job stands, for the queue and history rows */
const statusLine = (j: MintJob, now: number): string => {
  switch (j.state) {
    case 'waiting':
      return `${j.armed ? 'armed · ' : ''}${stageLabel(j.waitFor?.type ?? 'stage')} opens in ${countdown(j.waitFor?.startTime, now)}`;
    case 'pending':
      return j.error ? 'in flight · still watching' : 'in flight';
    case 'confirmed':
      return `minted${j.tokenIds?.length ? ` #${j.tokenIds.join(', #')}` : ''}${j.price ? ` for ${eth(j.price.totalWei, j.price.symbol)}` : ''}`;
    case 'failed':
      return j.error ?? 'failed';
    case 'ready':
      return isExpired(j, now) ? 'quote expired' : 'quoted, ready to mint';
    default:
      return STATE_LABEL[j.state];
  }
};

/** A two-step button: the first click asks, the second (a real pointer click within five seconds) does it. */
function useConfirm(resetKeys: unknown[]) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // a fresh quote/state transition retracts a stale confirmation prompt
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setConfirming(false), resetKeys);
  const click = (e: MouseEvent, go: () => void) => {
    // the confirm step must be a real pointer click (detail > 0); a synthetic/keyboard-dispatched
    // click (e.g. a stray Enter bubbling to a focused button) has detail === 0 and is ignored here
    if (confirming && e.detail === 0) return;
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirming(false), 5000);
      return;
    }
    window.clearTimeout(timer.current);
    setConfirming(false);
    go();
  };
  return { confirming, click };
}

/** A face for a wallet: a 5×5 mirrored pattern in a colour drawn from the address, the same every time. */
export function WalletFace({ address, size = 28, dim = false, title }: { address: string; size?: number; dim?: boolean; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let h = 2166136261;
    const a = address.toLowerCase();
    for (let i = 0; i < a.length; i++) {
      h ^= a.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let x = h || 1;
    const rnd = () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 4294967296;
    };
    const pal = ['#41c892', '#f2c366', '#647eff', '#f26682', '#4ad1ff', '#9945ff', '#ff8a3d', '#c4cccc'];
    const fg = pal[Math.floor(rnd() * pal.length)];
    c.width = 50;
    c.height = 50;
    const g = c.getContext('2d');
    if (!g) return;
    g.fillStyle = dim ? '#1a2226' : '#0b1114';
    g.fillRect(0, 0, 50, 50);
    g.fillStyle = dim ? '#556065' : fg;
    for (let y = 0; y < 5; y++)
      for (let cx = 0; cx < 3; cx++)
        if (rnd() > 0.5) {
          g.fillRect(cx * 10, y * 10, 10, 10);
          g.fillRect((4 - cx) * 10, y * 10, 10, 10);
        }
  }, [address, dim]);
  return <canvas ref={ref} className="wface" style={{ width: size, height: size }} title={title ?? address} />;
}

/** which of Drop › Amount › Mint the job is at */
const stepOf = (j: MintJob | undefined): 0 | 1 | 2 | 3 => {
  if (!j || j.state === 'quoting') return 0;
  if (j.state === 'ready' || j.state === 'waiting' || (j.state === 'failed' && !j.txHash)) return 1;
  if (j.state === 'sending' || j.state === 'pending') return 2;
  return 3;
};

function Steps({ at }: { at: 0 | 1 | 2 | 3 }) {
  const names = ['Drop', 'Amount', 'Mint'];
  return (
    <div className="osm-steps">
      {names.map((n, i) => (
        <span key={n} className={i < at ? 'done' : i === at ? 'now' : ''}>
          {i > 0 && <i>›</i>}
          {i < at ? '✓ ' : ''}
          {n}
        </span>
      ))}
    </div>
  );
}

/** The drop, as the mint page shows it, with this wallet's standing under it. */
function DropPanel({ j, now, wallet }: { j: MintJob; now: number; wallet?: string }) {
  const d = j.drop;
  const live = d?.stages.some((s) => whenStage(s, now).live);
  const canMint = j.stage?.maxPerWallet !== undefined ? Math.max(0, j.stage.maxPerWallet - (j.stage.alreadyMinted ?? 0)) : undefined;
  const soldOut = d?.minted !== undefined && d?.max !== undefined && d.minted >= d.max;
  const badge =
    j.state === 'quoting' ? 'Looking up…' : soldOut ? 'Sold out' : j.state === 'waiting' ? `⏱ ${stageLabel(j.waitFor?.type ?? 'stage')} in ${countdown(j.waitFor?.startTime, now)}` : d?.disabledReason ? 'Paused' : live ? '● Minting now' : d?.stages.length ? 'Not open' : '';
  return (
    <div className={`osm-panel osm-drop osj-${j.state}`}>
      <div className="osm-panel-head">
        {j.collection.image ? <img src={j.collection.image} alt="" /> : <span className="osm-panel-noimg" />}
        <div className="osm-panel-title">
          <b>{j.collection.name}</b>
          <span className="muted">
            {j.collection.chain}
            {d?.floor ? ` · floor ${unitFmt.format(d.floor.unit)} ${d.floor.symbol}${d.floor.usd !== undefined ? ` ≈ $${d.floor.usd.toFixed(2)}` : ''}` : ''}
          </span>
        </div>
        {badge && <span className={`osm-badge${soldOut ? ' osm-badge-failed' : live && j.state !== 'waiting' ? ' osm-badge-ready' : j.state === 'waiting' ? ' osm-badge-waiting' : ''}`}>{badge}</span>}
      </div>
      <DropInfo j={j} now={now} floorInline />
      {wallet && (
        <div className="osm-wallets">
          <span className="osm-wallets-label">Wallet</span>
          <WalletFace address={wallet} size={26} dim={canMint === 0} />
          <span className="osm-wallet-name">
            <b>{short(wallet)}</b>
            <small className="muted">
              {j.balanceWei ? `${eth(j.balanceWei, j.price?.symbol ?? 'ETH')}` : ''}
              {canMint !== undefined ? `${j.balanceWei ? ' · ' : ''}${canMint === 0 ? `minted ${j.stage?.alreadyMinted ?? 0} of ${j.stage?.maxPerWallet}, used up` : `can mint ${canMint}`}` : ''}
            </small>
          </span>
        </div>
      )}
    </div>
  );
}

/** How many: a stepper capped at what the wallet can still mint, with the price for that amount. */
function AmountPanel({ j, qty, max, onQty, requoting }: { j: MintJob; qty: number; max: number; onQty: (n: number) => void; requoting: boolean }) {
  const sym = j.price?.symbol ?? 'ETH';
  return (
    <div className="osm-panel">
      <div className="osm-amount">
        <div>
          <b>How many?</b>
          <div className="muted osm-amount-sub">
            {max > 0 ? `This wallet can mint ${max}${j.stage?.alreadyMinted ? ` more (${j.stage.alreadyMinted} minted)` : ''}` : 'No allowance left in this stage'}
          </div>
        </div>
        <div className="osm-qty" role="group" aria-label="quantity">
          <button onClick={() => onQty(qty - 1)} disabled={qty <= 1} aria-label="fewer">−</button>
          <output className="num">{qty}</output>
          <button onClick={() => onQty(qty + 1)} disabled={qty >= max} aria-label="more">+</button>
        </div>
      </div>
      {j.price && (
        <div className={`osj-lines${requoting ? ' osm-dimmed' : ''}`}>
          <span>Price</span><b>{eth(j.price.totalWei, sym)}{j.price.usd !== undefined ? <small className="muted"> ≈ ${j.price.usd.toFixed(2)}</small> : null}</b>
          {j.gas && <><span>Gas, at most</span><b>{eth(j.gas.estimateWei, sym)}</b></>}
          {j.balanceWei && <><span>Wallet</span><b>{eth(j.balanceWei, sym)}</b></>}
        </div>
      )}
      {requoting && <div className="muted osm-amount-sub">quoting {qty}…</div>}
    </div>
  );
}

/** One line per job in the queue and the history; click to bring it into the panel. */
function JobRow({ j, now, focused, onFocus, onDismiss, onArm }: { j: MintJob; now: number; focused: boolean; onFocus: (id: string) => void; onDismiss: (id: string) => void; onArm: (id: string, on: boolean) => void }) {
  const tx = txUrl(j);
  const dismissable = j.state === 'failed' || j.state === 'confirmed' || j.state === 'waiting' || isExpired(j, now);
  return (
    <div className={`osm-row osm-row-${j.state}${focused ? ' focused' : ''}`} onClick={() => onFocus(j.id)} title="show in the panel">
      {j.collection.image ? <img src={j.collection.image} alt="" /> : <span className="osm-row-img" />}
      <span className="osm-row-main">
        <b>{j.collection.name}</b>
        <span className={`osm-row-status${j.state === 'failed' ? ' err' : j.state === 'confirmed' ? ' up' : ''}`}>{statusLine(j, now)}</span>
      </span>
      <span className="osm-row-time muted">{new Date(j.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      <span className="osm-row-actions" onClick={(e) => e.stopPropagation()}>
        {j.state === 'waiting' && j.armed && <button className="hdr-toggle" onClick={() => onArm(j.id, false)}>disarm</button>}
        {tx && <a className="hdr-toggle" href={tx} target="_blank" rel="noreferrer">tx</a>}
        {dismissable && <button className="hdr-toggle osm-row-x" onClick={() => onDismiss(j.id)} title="remove">✕</button>}
      </span>
    </div>
  );
}

/**
 * The OpenSea mint window, guided: the drop loads, the amount appears once the wallet's
 * allowance is known, then one button in the foot for the state the mint is in. Queue and
 * history fold into one line each. Built for one wallet with room for several: the wallet
 * row under the drop becomes the wallet list, the foot button the batch.
 */
export function OsMintView({ jobs, now: coarseNow, wallet, prefill, onPrefilled }: { jobs: MintJob[]; now: number; wallet?: string; prefill?: { locator: string; chain?: string } | null; onPrefilled: () => void }) {
  // the app clock ticks every fifteen seconds; a countdown to a stage wants every second
  const waiting = jobs.some((j) => j.state === 'waiting');
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [waiting]);
  const now = waiting ? Math.max(tick, coarseNow) : coarseNow;
  const [locator, setLocator] = useState('');
  const [chain, setChain] = useState<string | undefined>();
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** a row the user clicked to look at; otherwise the newest job that is not in the queue or the log */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** the amount chosen for the current drop; a change quotes again */
  const [qty, setQty] = useState(1);
  const requote = useRef<number | undefined>(undefined);
  const lastPrefill = useRef<typeof prefill>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(requote.current);
    },
    [],
  );
  const flash = (t: string) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  const sorted = [...jobs].sort((a, b) => b.ts - a.ts);
  const focused = focusId ? sorted.find((j) => j.id === focusId) : undefined;
  const current = focused ?? sorted.find((j) => j.state === 'quoting' || j.state === 'ready' || j.state === 'sending' || j.state === 'waiting' || (j.state === 'failed' && !j.txHash)) ?? sorted[0];
  const queue = sorted.filter((j) => j !== current && (j.state === 'waiting' || j.state === 'pending'));
  const history = sorted.filter((j) => j !== current && !queue.includes(j) && j.state !== 'quoting' && j.state !== 'sending');
  const at = stepOf(current);
  const maxQty = current?.stage?.maxPerWallet !== undefined ? Math.max(0, current.stage.maxPerWallet - (current.stage.alreadyMinted ?? 0)) : 99;
  const expired = !!current && isExpired(current, now);
  const mint = useConfirm([current?.state, current?.id]);
  const arm = useConfirm([current?.state, current?.id, current?.armed?.at]);
  // a new drop resets the amount to what it was quoted for
  useEffect(() => {
    if (current) setQty(current.quantity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const quote = async (l = locator, c = chain, q = 1, retry = 0) => {
    if (!l.trim()) return;
    setQuoteBusy(true);
    try {
      const j = await api.osQuote(l.trim(), q, c);
      setFocusId(null);
      // one drop, one panel: an older quote of the same collection that went nowhere is cleared
      for (const old of jobs) {
        if (old.id !== j.id && old.collection.slug && old.collection.slug === j.collection.slug && ((old.state === 'failed' && !old.txHash) || old.state === 'ready')) api.osDismiss(old.id).catch(() => {});
      }
    } catch (e: any) {
      const msg = String(e?.message ?? 'quote failed');
      // the backend takes one quote every 1.5 s; an amount change that lands inside that window waits its turn
      if (/slow down/i.test(msg) && retry < 3) {
        window.clearTimeout(requote.current);
        requote.current = window.setTimeout(() => void quote(l, c, q, retry + 1), 1600);
        return;
      }
      flash(msg);
    } finally {
      setQuoteBusy(false);
    }
  };
  const changeQty = (n: number) => {
    if (!current) return;
    const next = Math.max(1, Math.min(maxQty || 1, n));
    setQty(next);
    window.clearTimeout(requote.current);
    requote.current = window.setTimeout(() => void quote(current.collection.slug || current.collection.address, current.collection.chain, next), 600);
  };
  useEffect(() => {
    // guard by identity so a re-mount (or an unrelated re-render) never re-fires the same prefill twice
    if (!prefill || lastPrefill.current === prefill) return;
    lastPrefill.current = prefill;
    setLocator(prefill.locator);
    setChain(prefill.chain);
    onPrefilled();
    void quote(prefill.locator, prefill.chain, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  const dismiss = async (id: string) => {
    if (focusId === id) setFocusId(null);
    try {
      await api.osDismiss(id);
    } catch (e: any) {
      flash(e?.message ?? 'could not dismiss');
    }
  };
  const doArm = async (id: string, on: boolean) => {
    try {
      await api.osArm(id, on);
    } catch (e: any) {
      flash(e?.message ?? 'could not arm');
    }
  };
  const send = async (id: string) => {
    setSendingId(id);
    try {
      await api.osSend(id);
    } catch (e: any) {
      flash(e?.message ?? 'send failed');
    } finally {
      setSendingId(null);
    }
  };
  const sym = current?.price?.symbol ?? 'ETH';
  const requoting = quoteBusy && !!current && current.state !== 'quoting';
  const showAmount = !!current && (current.state === 'ready' || current.state === 'waiting') && !!current.stage;
  const tx = current ? txUrl(current) : undefined;

  return (
    <div className="cove osm">
      <div className="osm-body">
        {!wallet && <div className="empty">Add a wallet in ⚙ → Trading to quote a drop.</div>}
        {wallet && !current && (
          <div className="osm-start">
            <div className="row-inline osm-start-wallet">
              <WalletFace address={wallet} size={26} />
              <span>
                <b>{short(wallet)}</b>
                <span className="muted"> · your mint wallet</span>
              </span>
            </div>
            <div className="empty">Paste a collection below, or press Mint on a MintGo card or a minting row in NFT Volume.</div>
          </div>
        )}
        {current && (
          <>
            <Steps at={at} />
            <DropPanel j={current} now={now} wallet={wallet} />
            {showAmount && <AmountPanel j={current} qty={qty} max={maxQty} onQty={changeQty} requoting={requoting} />}
            {current.state === 'failed' && current.error && <div className="osm-panel osj-err osm-msg">{current.error}</div>}
            {(current.state === 'waiting' || current.state === 'ready') && current.note && <div className="osm-panel osj-note osm-msg">{current.note}</div>}
            {current.state === 'waiting' && !current.note && (
              <div className="osm-msg muted">{current.armed ? `Sends by itself the moment the stage opens, at up to ${eth(current.price?.totalWei, sym)} plus gas under the ${current.collection.chain} ceiling.` : 'Quotes itself again the moment the stage opens and pings you. Arm it to mint without a click.'}</div>
            )}
            {(current.state === 'sending' || current.state === 'pending') && (
              <div className="osm-panel osm-flight">
                <WalletFace address={current.wallet} size={26} />
                <span>
                  <b>{short(current.wallet)}</b>
                  <small className="muted">{current.state === 'sending' ? 'signing and sending…' : current.error ? 'in the mempool · still watching' : 'in the mempool'}</small>
                </span>
                {tx && <a className="hdr-toggle" href={tx} target="_blank" rel="noreferrer">tx</a>}
              </div>
            )}
            {current.state === 'confirmed' && (
              <div className="osm-panel osm-flight osj-confirmed">
                <WalletFace address={current.wallet} size={26} />
                <span>
                  <b>Minted{current.tokenIds?.length ? ` #${current.tokenIds.join(', #')}` : ''}</b>
                  <small className="muted">{current.price ? `${eth(current.price.totalWei, sym)} · ` : ''}{current.blockNumber ? `block ${current.blockNumber}` : 'confirmed'}</small>
                </span>
                {tx && <a className="hdr-toggle" href={tx} target="_blank" rel="noreferrer">tx</a>}
              </div>
            )}
            {current.state === 'failed' && current.txHash && tx && (
              <div className="osm-msg muted">
                <a href={tx} target="_blank" rel="noreferrer">see the transaction</a>
              </div>
            )}
          </>
        )}
        {(queue.length > 0 || history.length > 0) && (
          <div className="osm-notes">
            {queue.length > 0 && (
              <button className="osm-note" onClick={() => setQueueOpen((o) => !o)}>
                <b>Queue</b> · {queue.length} <span className="osm-note-chev">{queueOpen ? '▾' : '▸'}</span>
                {!queueOpen && <span className="muted osm-note-peek">{statusLine(queue[0], now)}</span>}
              </button>
            )}
            {queueOpen && queue.map((j) => <JobRow key={j.id} j={j} now={now} focused={false} onFocus={setFocusId} onDismiss={dismiss} onArm={doArm} />)}
            {history.length > 0 && (
              <button className="osm-note" onClick={() => setHistoryOpen((o) => !o)}>
                <b>History</b> · {history.length} <span className="osm-note-chev">{historyOpen ? '▾' : '▸'}</span>
              </button>
            )}
            {historyOpen && history.map((j) => <JobRow key={j.id} j={j} now={now} focused={false} onFocus={setFocusId} onDismiss={dismiss} onArm={doArm} />)}
          </div>
        )}
      </div>
      {toast && <div className="cove-toast">{toast}</div>}
      <div className="osm-foot">
        {current && (
          <div className="osm-actions">
            {current.state === 'ready' && !expired && (
              <button className={`bkey ${mint.confirming ? 'osj-confirm' : 'osj-mint'}`} disabled={sendingId === current.id || requoting} onClick={(e) => mint.click(e, () => send(current.id))}>
                {mint.confirming ? `Confirm: send ${eth(current.price?.totalWei, sym)} from ${short(current.wallet)}?` : `Mint ${current.quantity} for ${eth(current.price?.totalWei, sym)}`}
              </button>
            )}
            {current.state === 'waiting' && !current.armed && (
              <button className={`bkey ${arm.confirming ? 'osj-confirm' : 'osj-mint'}`} disabled={!current.price} title={current.price ? 'send this mint automatically when the stage opens' : 'OpenSea has not shown a price for that stage yet'} onClick={(e) => arm.click(e, () => doArm(current.id, true))}>
                {arm.confirming ? `Confirm: auto-mint ${current.quantity} for ${eth(current.price?.totalWei, sym)} when it opens?` : 'Mint when it opens'}
              </button>
            )}
            {current.state === 'waiting' && current.armed && (
              <button className="bkey" onClick={() => doArm(current.id, false)} title="do not send automatically">Disarm</button>
            )}
            {(current.state === 'failed' || expired) && current.collection.slug && (
              <button className="bkey" onClick={() => void quote(current.collection.slug, current.collection.chain, 1)} title="look this collection up again">Look up again</button>
            )}
            {current.collection.slug && <a className="bkey bkey-url osm-side" href={`https://opensea.io/collection/${current.collection.slug}`} target="_blank" rel="noreferrer">OpenSea <Icon name="explorer" size={10} /></a>}
            {(current.state === 'failed' || current.state === 'confirmed' || current.state === 'waiting' || expired) && (
              <button className="bkey osj-dismiss" onClick={() => dismiss(current.id)} title="clear">✕</button>
            )}
          </div>
        )}
        <div className="osm-lookup">
          <input
            value={locator}
            onChange={(e) => {
              setLocator(e.target.value);
              setChain(undefined);
            }}
            placeholder={current ? 'Paste another collection' : 'collection slug, opensea.io link or 0x address'}
            spellCheck={false}
            disabled={!wallet}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void quote(locator, chain, 1);
                setLocator('');
              }
            }}
          />
          <button className="bkey osm-side" disabled={quoteBusy || !locator.trim() || !wallet} onClick={() => { void quote(locator, chain, 1); setLocator(''); }} title="look the drop up (Enter)">
            Look up
          </button>
        </div>
      </div>
    </div>
  );
}
