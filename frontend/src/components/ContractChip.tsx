import { useState } from 'react';
import type { Contract } from '../types';

export function ContractChip({ c }: { c: Contract }) {
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
  return (
    <button className={`chip chip-${c.chain}`} onClick={copy} title={c.address}>
      <span className="chip-chain">{c.chain.toUpperCase()}</span>
      <span className="chip-addr">{copied ? 'copied' : short}</span>
    </button>
  );
}
