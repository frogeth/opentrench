import type { TokenSecurity } from '../types';
import { Icon, type IconName } from './Icon';
import { Tip } from './HoverCard';

const pct = (n?: number) => (n === undefined ? undefined : `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}%`);
const num = (n?: number) => (n === undefined ? undefined : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** Danger colouring for a percentage held by one group. */
/** green when low, gold when elevated, gray when high, red when dangerous */
const tone = (n: number | undefined, warn: number, high: number, bad = Infinity) =>
  n === undefined ? '' : n >= bad ? ' bad' : n >= high ? ' high' : n >= warn ? ' warn' : ' ok';

/**
 * Holder security strip under a call: holders, top 10, dev (with DH/DS badge),
 * insiders, snipers, bundlers, LP lock, taxes. Hover any item for the words.
 */
export function SecurityStrip({ s, compact = false }: { s: TokenSecurity; compact?: boolean }) {
  type Item = { icon: IconName; text?: string; tip: string; cls?: string };
  const all: Item[] = [
    { icon: 'people', text: num(s.holders), tip: `${s.holders?.toLocaleString() ?? '?'} holders` },
    { icon: 'top', text: pct(s.top10Pct), tip: `Top 10 holders hold ${pct(s.top10Pct) ?? '?'}`, cls: tone(s.top10Pct, 20, 35, 60) },
    { icon: 'dev', text: pct(s.devPct), tip: s.devSold ? 'Dev sold all' : `Dev holds ${pct(s.devPct) ?? '?'}`, cls: tone(s.devPct, 3, 10, 25) },
    { icon: 'insider', text: pct(s.insidersPct), tip: `Insiders hold ${pct(s.insidersPct) ?? '?'}`, cls: tone(s.insidersPct, 5, 15, 30) },
    { icon: 'sniper', text: pct(s.snipersPct), tip: `Snipers hold ${pct(s.snipersPct) ?? '?'}`, cls: tone(s.snipersPct, 1, 15, 30) },
    { icon: 'bundle', text: pct(s.bundlersPct), tip: `Bundlers hold ${pct(s.bundlersPct) ?? '?'}`, cls: tone(s.bundlersPct, 1, 15, 30) },
    { icon: 'lock', text: pct(s.lpLockedPct), tip: `${pct(s.lpLockedPct) ?? '?'} of liquidity locked or burned`, cls: s.lpLockedPct === undefined ? '' : s.lpLockedPct >= 90 ? ' ok' : ' warn' },
  ];
  const items = all.filter((i) => i.text !== undefined && !(compact && i.icon === 'people'));
  const taxHigh = (s.buyTax ?? 0) > 5 || (s.sellTax ?? 0) > 5;
  const tax = (s.buyTax !== undefined || s.sellTax !== undefined) && (!compact || taxHigh) ? `${pct(s.buyTax) ?? '?'}/${pct(s.sellTax) ?? '?'}` : undefined;
  return (
    <div className="sec">
      {items.map((i) => (
        <Tip key={i.icon} text={i.tip}>
          <span className={`sec-item${i.cls ?? ''}`}>
            <Icon name={i.icon} size={11} />
            {i.text}
          </span>
        </Tip>
      ))}
      {tax && (
        <Tip text={`tax: ${pct(s.buyTax) ?? '?'} buy · ${pct(s.sellTax) ?? '?'} sell`}>
          <span className={`sec-item${(s.buyTax ?? 0) > 10 || (s.sellTax ?? 0) > 10 ? ' bad' : ''}`}>tax {tax}</span>
        </Tip>
      )}
      {s.honeypot && (
        <Tip text="flagged as a honeypot: you may not be able to sell">
          <span className="sec-item bad">honeypot</span>
        </Tip>
      )}
      {s.devSold !== undefined && (
        <Tip text={s.devSold ? 'Dev sold all' : 'Dev still holds'}>
          <span className={`sec-badge${s.devSold ? ' ds' : ' dh'}`}>{s.devSold ? 'DS' : 'DH'}</span>
        </Tip>
      )}
      {s.mintable && (
        <Tip text="mint authority still enabled: supply can be inflated">
          <span className="sec-item bad">mint</span>
        </Tip>
      )}
      {s.freezable && (
        <Tip text="freeze authority still enabled: wallets can be frozen">
          <span className="sec-item bad">freeze</span>
        </Tip>
      )}
    </div>
  );
}
