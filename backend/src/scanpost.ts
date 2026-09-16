import type { FeedMessage } from './types.js';
import { detectContracts } from './contracts.js';

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


/** a post shaped like a scanner card (Rick, Phanes, TokenScan…): a header market cap or an FDV/MC line */
export function looksLikeScan(text: string): boolean {
  const f = parseScanFigures(text);
  return f.marketCap !== undefined || f.firstAt !== undefined;
}

const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const START_RE = /[?&]start(?:app)?=(?:[a-z]{1,3}_)?(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/g;

/**
 * The token a scanner card is about. Rick's card also links the pair on Dexscreener, the top
 * holders on the explorer and a dozen bot deep links, and every one of those addresses would
 * count as a separate token. The subject is the address the card prints bare (outside any link);
 * failing that, the one its trade-bot links carry in `start=`. Empty when nothing settles it.
 */
export function scanSubjects(text: string): string[] {
  const bare = detectContracts(text.replace(URL_RE, ' ')).map((c) => c.address);
  if (bare.length) return [...new Set(bare)];
  const out = new Set<string>();
  for (const m of text.matchAll(START_RE)) {
    const a = m[1];
    for (const c of detectContracts(a)) out.add(c.address);
  }
  return [...out];
}

/** Contracts a message counts: every one it mentions, or for a scanner card only its subject. */
export function contractsOf(text: string, isBot: boolean): FeedMessage['contracts'] {
  const all = detectContracts(text);
  if (all.length <= 1 || !(isBot || looksLikeScan(text))) return all;
  const subject = new Set(scanSubjects(text));
  const kept = all.filter((c) => subject.has(c.address));
  return kept.length ? kept : all;
}
