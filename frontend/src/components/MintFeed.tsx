import { useState } from 'react';
import type { MintEvent } from '../types';
import type { ColumnFilters } from '../api';
import { timeAgo } from '../format';
import { Icon } from './Icon';
import { VirtualItem } from './Virtual';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', robinhood: 'https://robinhoodchain.blockscout.com/tx/', ink: 'https://explorer.inkonchain.com/tx/' };
const CHAIN_LABEL: Record<string, string> = { ethereum: 'ETH', robinhood: 'RH', ink: 'INK', stable: 'STB', arc: 'ARC' };
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const eth = (n?: number) => (n === undefined ? '' : n === 0 ? 'free' : `Ξ${n < 0.001 ? n.toPrecision(2) : n.toFixed(n < 0.1 ? 4 : 3)}`);

export function mintPasses(e: MintEvent, f?: ColumnFilters): boolean {
  if (f?.chains?.length && !f.chains.includes(e.chain)) return false;
  if (f?.minQty && e.quantity < f.minQty) return false;
  return true;
}

function MintCard({ e, now, open, onToggle, onMint }: { e: MintEvent; now: number; open: boolean; onToggle: () => void; onMint?: (e: MintEvent) => void }) {
  const c = e.contract;
  const copy = (t: string) => void navigator.clipboard?.writeText(t);
  return (
    <div className={`mint${open ? ' mint-open' : ''}${e.preview ? ' mint-preview' : ''}`} onClick={onToggle}>
      <div className="mint-row">
        {c.image ? <img className="mint-img" src={c.image} alt="" loading="lazy" /> : <span className="mint-img mint-noimg" />}
        <div className="mint-main">
          <div className="mint-name">
            <b>{c.name}</b>
            <span className={`mint-chain mint-chain-${e.chain}`}>{CHAIN_LABEL[e.chain] ?? e.chain}</span>
            {e.preview && <span className="mint-tag">preview</span>}
            {e.airdrop && <span className="mint-tag">airdrop</span>}
            {e.thirdParty && <span className="mint-tag">3rd party</span>}
            {e.surge && <span className="mint-tag mint-surge">🔥 {e.surge.mints} in a burst</span>}
          </div>
          <div className="mint-meta muted">
            ×{e.quantity} · {eth(e.unitPriceEth ?? (e.quantity ? (e.valueEth ?? 0) / e.quantity : undefined))}
            {e.valueEth ? ` (${eth(e.valueEth)} total)` : ''} · {short(e.minter)} · {timeAgo(e.ts, now)}
            {e.maxSupply ? ` · ${e.mintedSupply ?? '?'}/${e.maxSupply}` : ''}
          </div>
        </div>
      </div>
      {open && (
        <div className="mint-links" onClick={(ev) => ev.stopPropagation()}>
          {c.twitterUrl && <a href={c.twitterUrl} target="_blank" rel="noreferrer" title="X"><Icon name="x" size={12} /> X</a>}
          {c.openSeaUrl && <a href={c.openSeaUrl} target="_blank" rel="noreferrer" title="OpenSea"><Icon name="sea" size={12} /> OpenSea</a>}
          {c.projectUrl && <a href={c.projectUrl} target="_blank" rel="noreferrer" title="website"><Icon name="globe" size={12} /> site</a>}
          {e.txHash && EXPLORER[e.chain] && <a href={`${EXPLORER[e.chain]}${e.txHash}`} target="_blank" rel="noreferrer" title="transaction"><Icon name="explorer" size={12} /> tx</a>}
          <button className="mint-copy" onClick={() => copy(c.address)} title="copy contract"><Icon name="copy" size={12} /> {short(c.address)}</button>
          {c.deployer && <span className="muted">deployer {short(c.deployer.address)}{c.deployer.createdAgo ? ` · ${c.deployer.createdAgo}` : ''}{c.deployer.projects ? ` · ${c.deployer.projects} projects` : ''}</span>}
          {onMint && c.slug && <button className="mint-go" onClick={() => onMint(e)}>Mint</button>}
        </div>
      )}
    </div>
  );
}

/** The MintGo column body: one card per mint, newest first; click a card for its links and a Mint button. */
export function MintFeed({ mints, now, state, error, filters, onMint }: { mints: MintEvent[]; now: number; state?: string; error?: string; filters?: ColumnFilters; onMint?: (e: MintEvent) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = mints.filter((e) => mintPasses(e, filters));
  return (
    <>
      {state === 'error' && <div className="empty err">MintGo unavailable: {error ?? 'connection lost'} — retrying.</div>}
      {state !== 'error' && list.length === 0 && <div className="empty">{state === 'connected' ? 'Waiting for the first mint…' : 'Connecting to MintGo…'}</div>}
      {list.map((e) => (
        <VirtualItem key={e.id} id={`mint:${e.id}`} estimate={open === e.id ? 110 : 58}>
          <MintCard e={e} now={now} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} onMint={onMint} />
        </VirtualItem>
      ))}
    </>
  );
}
