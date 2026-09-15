import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { MintJob } from '../types';
import { api } from '../api';
import { copyText } from '../format';
import { Icon } from './Icon';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', robinhood: 'https://robin.etherscan.io/tx/', ink: 'https://explorer.inkonchain.com/tx/' };
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
function DropInfo({ j, now }: { j: MintJob; now: number }) {
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
          {d.floor && (
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

/** The drop being looked at: everything OpenSea's mint page shows, and the one action that fits its state. */
function DropPanel({ j, now, onSend, sending, onDismiss, onRequote, onArm }: { j: MintJob; now: number; onSend: (id: string) => void; sending: boolean; onDismiss: (id: string) => void; onRequote: (j: MintJob) => void; onArm: (id: string, on: boolean) => void }) {
  const sym = j.price?.symbol ?? 'ETH';
  const mint = useConfirm([j.state, j.id]);
  const arm = useConfirm([j.state, j.id, j.armed?.at]);
  const expired = isExpired(j, now);
  const tx = txUrl(j);
  const badge =
    j.state === 'waiting' ? `⏱ ${j.armed ? 'Armed' : 'Waiting'} · ${stageLabel(j.waitFor?.type ?? 'stage')} opens in ${countdown(j.waitFor?.startTime, now)}` : j.state === 'ready' ? (expired ? 'Quote expired' : '◎ Ready to mint') : j.state === 'confirmed' ? '✓ Minted' : j.state === 'failed' ? '✗ ' + (j.txHash ? 'Mint failed' : 'Not mintable') : STATE_LABEL[j.state];
  return (
    <div className={`osm-panel osj-${j.state}${expired ? ' osj-expired' : ''}`}>
      <div className="osm-panel-head">
        {j.collection.image && <img src={j.collection.image} alt="" />}
        <div className="osm-panel-title">
          <b>{j.collection.name}</b>
          <span className="muted">
            {j.collection.chain}
            {j.stage ? ` · ${stageLabel(j.stage.type)} stage${j.stage.maxPerWallet !== undefined ? ` · ${j.stage.alreadyMinted ?? 0}/${j.stage.maxPerWallet} per wallet` : ''}` : ''}
          </span>
        </div>
        <span className={`osm-badge osm-badge-${j.state}`}>{badge}</span>
      </div>
      <DropInfo j={j} now={now} />
      {j.price && (
        <div className="osj-lines">
          <span>Pays from</span><b>{short(j.wallet)}</b>
          <span>Quantity</span><b>{j.quantity}</b>
          <span>Price</span><b>{eth(j.price.totalWei, sym)}{j.price.usd !== undefined ? <small className="muted"> ≈ ${j.price.usd.toFixed(2)}</small> : null}</b>
          {j.gas && <><span>Gas (max)</span><b>{eth(j.gas.estimateWei, sym)}</b></>}
          {j.balanceWei && <><span>Wallet</span><b>{eth(j.balanceWei, sym)}</b></>}
        </div>
      )}
      {(j.state === 'sending' || j.state === 'pending') && <div className="osj-spin muted">…</div>}
      {j.state === 'confirmed' && <div className="osj-ok">{j.tokenIds?.length ? `#${j.tokenIds.join(', #')}` : 'minted'}{j.blockNumber ? ` · block ${j.blockNumber}` : ''}</div>}
      {(j.state === 'pending' || j.state === 'sending') && j.error && <div className="osj-note">{j.error}</div>}
      {(j.state === 'waiting' || j.state === 'ready') && j.note && <div className="osj-note">{j.note}</div>}
      {j.state === 'waiting' && !j.note && <div className="osj-note muted">{j.armed ? `Sends by itself the moment the stage opens, at up to ${eth(j.price?.totalWei, sym)} plus gas under the ${j.collection.chain} ceiling. No click needed.` : 'Quotes itself again the moment the stage opens and pings you. Arm it to mint without a click.'}</div>}
      {j.state === 'failed' && j.error && <div className="osj-err">{j.error}</div>}
      <div className="osm-actions">
        {j.state === 'ready' && !expired && (
          <button className={`bkey ${mint.confirming ? 'osj-confirm' : 'osj-mint'}`} disabled={sending} onClick={(e) => mint.click(e, () => onSend(j.id))}>
            {mint.confirming ? `Confirm: send ${eth(j.price?.totalWei, sym)} from ${short(j.wallet)}?` : `Mint ${j.quantity} for ${eth(j.price?.totalWei, sym)}`}
          </button>
        )}
        {j.state === 'waiting' && !j.armed && (
          <button className={`bkey ${arm.confirming ? 'osj-confirm' : 'osj-mint'}`} disabled={!j.price} title={j.price ? 'send this mint automatically when the stage opens' : 'OpenSea has not shown a price for that stage yet'} onClick={(e) => arm.click(e, () => onArm(j.id, true))}>
            {arm.confirming ? `Confirm: auto-mint ${j.quantity} for ${eth(j.price?.totalWei, sym)} from ${short(j.wallet)} when it opens?` : 'Mint when it opens'}
          </button>
        )}
        {j.state === 'waiting' && j.armed && (
          <button className="bkey" onClick={() => onArm(j.id, false)} title="do not send automatically">Disarm</button>
        )}
        {(j.state === 'failed' || expired) && j.collection.slug && (
          <button className="bkey" onClick={() => onRequote(j)} title="quote this collection again">Quote again</button>
        )}
        {tx && <a className="bkey bkey-url" href={tx} target="_blank" rel="noreferrer">tx <Icon name="explorer" size={10} /></a>}
        {j.collection.slug && <a className="bkey bkey-url" href={`https://opensea.io/collection/${j.collection.slug}`} target="_blank" rel="noreferrer">OpenSea <Icon name="explorer" size={10} /></a>}
        {(j.state === 'failed' || j.state === 'confirmed' || j.state === 'waiting' || expired) && (
          <button className="bkey osj-dismiss" onClick={() => onDismiss(j.id)} title="remove">Dismiss</button>
        )}
      </div>
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
 * The OpenSea mint window: a lookup bar, the drop being looked at as one panel (supply, floor,
 * schedule, quote, the action for its state), the queue of mints waiting for their stage, and a
 * history of what was sent.
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
  const [qty, setQty] = useState(1);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** a row the user clicked to look at; otherwise the newest job that is not in the queue or the log */
  const [focusId, setFocusId] = useState<string | null>(null);
  const lastPrefill = useRef<typeof prefill>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const flash = (t: string) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };
  const copyWallet = async () => {
    if (!wallet) return;
    const ok = await copyText(wallet);
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const sorted = [...jobs].sort((a, b) => b.ts - a.ts);
  const focused = focusId ? sorted.find((j) => j.id === focusId) : undefined;
  // the panel: what was asked for last, unless the user clicked a row
  const current = focused ?? sorted.find((j) => j.state === 'quoting' || j.state === 'ready' || j.state === 'sending' || j.state === 'waiting' || (j.state === 'failed' && !j.txHash)) ?? sorted[0];
  const queue = sorted.filter((j) => j !== current && (j.state === 'waiting' || j.state === 'pending'));
  const history = sorted.filter((j) => j !== current && !queue.includes(j) && j.state !== 'quoting' && j.state !== 'sending');

  const quote = async (l = locator, c = chain, q = qty) => {
    if (!l.trim()) return;
    setQuoteBusy(true);
    setFocusId(null);
    try {
      const j = await api.osQuote(l.trim(), q, c);
      // one drop, one panel: an older quote of the same collection that went nowhere is cleared
      for (const old of jobs) {
        if (old.id !== j.id && old.collection.slug && old.collection.slug === j.collection.slug && old.state === 'failed' && !old.txHash) api.osDismiss(old.id).catch(() => {});
      }
    } catch (e: any) {
      flash(e?.message ?? 'quote failed');
    } finally {
      setQuoteBusy(false);
    }
  };
  useEffect(() => {
    // guard by identity so a re-mount (or an unrelated re-render) never re-fires the same prefill twice
    if (!prefill || lastPrefill.current === prefill) return;
    lastPrefill.current = prefill;
    setLocator(prefill.locator);
    setChain(prefill.chain);
    onPrefilled();
    void quote(prefill.locator, prefill.chain, qty);
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
  const arm = async (id: string, on: boolean) => {
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
  return (
    <div className="cove osm">
      <div className="osm-lookup">
        <input
          value={locator}
          onChange={(e) => {
            setLocator(e.target.value);
            setChain(undefined);
          }}
          placeholder="collection slug, opensea.io link or 0x address"
          spellCheck={false}
          disabled={!wallet}
          onKeyDown={(e) => e.key === 'Enter' && void quote()}
        />
        <input className="osm-qty" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} title="quantity" disabled={!wallet} />
        <button className="composer-send osm-quote" disabled={quoteBusy || !locator.trim() || !wallet} onClick={() => void quote()} title="quote (Enter)">
          {quoteBusy ? '…' : 'Quote'}
        </button>
        {wallet ? (
          <button className="osm-wallet-chip" onClick={() => void copyWallet()} title={wallet}>
            <Icon name="copy" size={10} /> {copied ? 'copied' : short(wallet)}
          </button>
        ) : (
          <span className="muted osm-hint">no wallet</span>
        )}
      </div>
      <div className="osm-body">
        {!wallet && <div className="empty">Add a wallet in ⚙ → Trading to quote a drop.</div>}
        {wallet && !current && <div className="empty">Paste a collection above, or press Mint on a MintGo card or a minting row in OpenSea Volume.</div>}
        {current && <DropPanel j={current} now={now} onSend={send} sending={sendingId === current.id} onDismiss={dismiss} onArm={arm} onRequote={(job) => void quote(job.collection.slug, job.collection.chain, job.quantity)} />}
        {queue.length > 0 && (
          <div className="osm-section">
            <div className="osm-section-head">
              <b>Queue</b> <span className="muted">{queue.length}</span>
            </div>
            {queue.map((j) => (
              <JobRow key={j.id} j={j} now={now} focused={false} onFocus={setFocusId} onDismiss={dismiss} onArm={arm} />
            ))}
          </div>
        )}
        {history.length > 0 && (
          <div className="osm-section">
            <button className="osm-section-head osm-section-toggle" onClick={() => setHistoryOpen((o) => !o)}>
              <b>History</b> <span className="muted">{history.length}</span>
              <span className="osm-section-chev">{historyOpen ? '▾' : '▸'}</span>
            </button>
            {historyOpen && history.map((j) => <JobRow key={j.id} j={j} now={now} focused={false} onFocus={setFocusId} onDismiss={dismiss} onArm={arm} />)}
          </div>
        )}
      </div>
      {toast && <div className="cove-toast">{toast}</div>}
    </div>
  );
}
