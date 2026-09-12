import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MintJob } from '../types';
import { api } from '../api';
import { copyText } from '../format';
import { Icon } from './Icon';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', robinhood: 'https://robinhoodchain.blockscout.com/tx/', ink: 'https://explorer.inkonchain.com/tx/' };
const ethFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const eth = (wei?: string, sym = 'ETH') => (wei === undefined ? '—' : `${ethFmt.format(Number(wei) / 1e18)} ${sym}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const stageLabel = (t: string) => t.toLowerCase().replace(/_/g, ' ').replace('sale', '').trim() || 'stage';
const until = (iso?: string, now = Date.now()) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'ended';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${Math.floor((ms % 3600e3) / 60e3)}m` : `${Math.floor(ms / 60e3)}m`;
};

function JobCard({ j, now, onSend, sending }: { j: MintJob; now: number; onSend: (id: string) => void; sending: boolean }) {
  const sym = j.price?.symbol ?? 'ETH';
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);
  // a fresh quote/state transition retracts a stale confirmation prompt
  useEffect(() => setConfirming(false), [j.state, j.id]);
  const head = j.state === 'quoting' ? '… Quoting' : j.state === 'ready' ? '◎ Ready to mint' : j.state === 'sending' ? '⏳ Sending' : j.state === 'pending' ? '🔵 Pending' : j.state === 'confirmed' ? '✓ Mint confirmed' : '✗ Mint failed';
  const tx = j.txHash && EXPLORER[j.collection.chain] ? `${EXPLORER[j.collection.chain]}${j.txHash}` : undefined;
  const clickMint = () => {
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 5000);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    onSend(j.id);
  };
  return (
    <div className={`bmsg osj osj-${j.state}`}>
      <div className="osj-head"><b>{head}</b><span className="muted">{new Date(j.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
      <div className="osj-col">
        {j.collection.image && <img src={j.collection.image} alt="" />}
        <div>
          <b>{j.collection.name}</b> <span className="muted">· {j.collection.chain}</span>
          {j.stage && <div className="muted">{stageLabel(j.stage.type)} stage{j.stage.endTime ? ` · ends in ${until(j.stage.endTime, now)}` : ''}{j.stage.maxPerWallet !== undefined ? ` · ${j.stage.alreadyMinted ?? 0}/${j.stage.maxPerWallet} per wallet` : ''}</div>}
        </div>
      </div>
      {j.price && (
        <div className="osj-lines">
          <span>Quantity</span><b>{j.quantity}</b>
          <span>Price</span><b>{eth(j.price.totalWei, sym)}{j.price.usd !== undefined ? <small className="muted"> ≈ ${j.price.usd.toFixed(2)}</small> : null}</b>
          {j.gas && <><span>Gas (max)</span><b>{eth(j.gas.estimateWei, sym)}</b></>}
          {j.balanceWei && <><span>Wallet</span><b>{eth(j.balanceWei, sym)}</b></>}
        </div>
      )}
      {(j.state === 'sending' || j.state === 'pending') && <div className="osj-spin muted">…</div>}
      {j.state === 'confirmed' && <div className="osj-ok">{j.tokenIds?.length ? `#${j.tokenIds.join(', #')}` : 'minted'}{j.blockNumber ? ` · block ${j.blockNumber}` : ''}</div>}
      {j.state === 'failed' && j.error && <div className="osj-err">{j.error}</div>}
      <div className="bkeys"><div className="bkey-row">
        {j.state === 'ready' && (
          <button className={`bkey ${confirming ? 'osj-confirm' : 'osj-mint'}`} disabled={sending} onClick={clickMint}>
            {confirming ? `Confirm: send ${eth(j.price?.totalWei, sym)}?` : `Mint ${j.quantity} for ${eth(j.price?.totalWei, sym)}`}
          </button>
        )}
        {tx && <a className="bkey bkey-url" href={tx} target="_blank" rel="noreferrer">tx <Icon name="explorer" size={10} /></a>}
        {j.collection.slug && <a className="bkey bkey-url" href={`https://opensea.io/collection/${j.collection.slug}`} target="_blank" rel="noreferrer">OpenSea <Icon name="explorer" size={10} /></a>}
      </div></div>
    </div>
  );
}

/** The OpenSea mint window: quote a drop, press Mint, watch the card go pending → confirmed. */
export function OsMintView({ jobs, now, wallet, prefill, onPrefilled }: { jobs: MintJob[]; now: number; wallet?: string; prefill?: { locator: string; chain?: string } | null; onPrefilled: () => void }) {
  const [locator, setLocator] = useState('');
  const [chain, setChain] = useState<string | undefined>();
  const [qty, setQty] = useState(1);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);
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
  const quote = async (l = locator, c = chain, q = qty) => {
    if (!l.trim()) return;
    setQuoteBusy(true);
    try {
      await api.osQuote(l.trim(), q, c);
    } catch (e: any) {
      flash(e?.message ?? 'quote failed');
    } finally {
      setQuoteBusy(false);
    }
  };
  useEffect(() => {
    if (!prefill) return;
    setLocator(prefill.locator);
    setChain(prefill.chain);
    onPrefilled();
    void quote(prefill.locator, prefill.chain, qty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [jobs]);
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
      <div className="osm-bar muted">
        <Icon name="wallet" size={12} />
        {wallet ? (
          <button className="osm-wallet-chip" onClick={() => void copyWallet()} title={wallet}>
            <Icon name="copy" size={10} /> {copied ? 'copied' : short(wallet)}
          </button>
        ) : (
          'no wallet — add one in ⚙ → Trading'
        )}
      </div>
      <div className="cove-body" ref={body}>
        {jobs.length === 0 && <div className="empty">Paste a collection below, or press Mint on a MintGo card or a minting row in OpenSea Volume.</div>}
        {jobs.map((j) => (
          <JobCard key={j.id} j={j} now={now} onSend={send} sending={sendingId === j.id} />
        ))}
      </div>
      {toast && <div className="cove-toast">{toast}</div>}
      <div className="composer cove-composer osm-composer">
        {!wallet && <div className="muted osm-hint">Add a wallet in ⚙ → Trading to quote a drop.</div>}
        <div className="composer-row">
          <input
            value={locator}
            onChange={(e) => {
              setLocator(e.target.value);
              setChain(undefined);
            }}
            placeholder="collection slug, opensea.io link or 0x address"
            spellCheck={false}
            onKeyDown={(e) => e.key === 'Enter' && void quote()}
          />
          <input className="osm-qty" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} title="quantity" />
          <button className="composer-send" disabled={quoteBusy || !locator.trim()} onClick={() => void quote()} title="quote (Enter)">
            Quote
          </button>
        </div>
      </div>
    </div>
  );
}
