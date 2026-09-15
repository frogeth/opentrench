import type { FeedMessage } from './types.js';

/**
 * Scanner bots (Rick, Phanes, TokenScan…) answer a contract in the chat within seconds with the
 * market cap at that moment. That is the best "market cap at the call" we can get — the same
 * chat, the same minute, no API — so a bot post that names a contract feeds the call it
 * answers. Rick also says "You are first @ 21.3K": the entry as the chat saw it.
 */
export interface ScanFigures {
  /** market cap / fdv in USD, the first one the post states */
  marketCap?: number;
  /** Rick's "You are first @ X" */
  firstAt?: number;
}

const NUM = String.raw`\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KkMmBb])?`;
const mul: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
function usd(n: string, suffix?: string): number | undefined {
  const v = Number(n.replace(/,/g, ''));
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return v * (suffix ? mul[suffix.toLowerCase()] : 1);
}

export function parseScanFigures(text: string): ScanFigures {
  const out: ScanFigures = {};
  const t = text.replace(/[*_`]/g, '');
  // Rick's header: "HUH CAT [35.1K/-13%] $HUHCAT"
  let m = new RegExp(String.raw`\[\s*` + NUM + String.raw`\s*/\s*[-+]?[0-9.]+%\s*\]`).exec(t);
  if (m) out.marketCap = usd(m[1], m[2]);
  // "FDV: $35.1K", "MC: $45.6K", "Mcap $45.6K", "Market Cap: $1.2M" (the first one wins; "⇨ 54.3K" after it is the ATH)
  if (out.marketCap === undefined) {
    m = new RegExp(String.raw`(?:FDV|MC|MCAP|Mcap|Market ?Cap)\s*[:：]?\s*` + NUM, 'i').exec(t);
    if (m) out.marketCap = usd(m[1], m[2]);
  }
  m = new RegExp(String.raw`You are first\s*@\s*` + NUM, 'i').exec(t);
  if (m) out.firstAt = usd(m[1], m[2]);
  return out;
}

/** A bot post about a contract, with figures worth applying. */
export function isScanPost(msg: Pick<FeedMessage, 'isBot' | 'contracts' | 'text'>): ScanFigures | undefined {
  if (!msg.isBot || msg.contracts.length === 0) return undefined;
  const f = parseScanFigures(msg.text);
  return f.marketCap !== undefined || f.firstAt !== undefined ? f : undefined;
}
