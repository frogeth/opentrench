import bs58 from 'bs58';
import type { Contract } from './types.js';

const EVM_RE = /(?<![a-zA-Z0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
const SOL_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

function isSolanaPubkey(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function detectContracts(text: string): Contract[] {
  if (!text) return [];
  const found: { index: number; c: Contract }[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(EVM_RE)) {
    const key = 'evm:' + m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ index: m.index ?? 0, c: { chain: 'evm', address: m[0].toLowerCase() } });
  }
  for (const m of text.matchAll(SOL_RE)) {
    if (!isSolanaPubkey(m[0])) continue;
    const key = 'sol:' + m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ index: m.index ?? 0, c: { chain: 'sol', address: m[0] } });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.c);
}
