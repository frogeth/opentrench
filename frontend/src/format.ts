import { playSound } from './sounds';
export function money(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function price(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const NETWORK_LABEL: Record<string, string> = {
  ethereum: 'ETH',
  base: 'BASE',
  bsc: 'BNB',
  arbitrum: 'ARB',
  polygon: 'POL',
  avalanche: 'AVAX',
  robinhood: 'RH',
  solana: 'SOL',
  megaeth: 'MEGA',
  monad: 'MON',
  hyperevm: 'HYPE',
  plasma: 'XPL',
  story: 'IP',
  tempo: 'TEMPO',
  ink: 'INK',
  stable: 'STBL',
};

export function netLabel(network: string | undefined, chain: 'sol' | 'evm'): string {
  if (!network) return chain.toUpperCase();
  return NETWORK_LABEL[network] ?? network.toUpperCase().slice(0, 5);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}

export function normName(n: string): string {
  return n.trim().replace(/^@/, '').toLowerCase();
}

export function isFavorite(favorites: string[], author: string): boolean {
  const n = normName(author);
  return favorites.some((f) => normName(f) === n);
}

export function telegramShareUrl(address: string, label: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(address)}&text=${encodeURIComponent(label)}`;
}

/** Short beep with the Web Audio API — no asset needed. */
export function beep(): void {
  playSound('chirp');
}

export type ChartProvider = 'basedbot' | 'dexscreener' | 'birdeye' | 'gmgn';
export const CHART_PROVIDERS: { id: ChartProvider; label: string }[] = [
  { id: 'basedbot', label: 'BasedBot' },
  { id: 'dexscreener', label: 'Dexscreener / GeckoTerminal' },
  { id: 'birdeye', label: 'Birdeye' },
  { id: 'gmgn', label: 'GMGN' },
];

/** Birdeye's embed host keys on the token address + a chain name (each verified to render in a frame). */
const BIRDEYE_CHAIN: Record<string, string> = {
  solana: 'solana',
  ethereum: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  robinhood: 'robinhood',
};

/** GMGN's kline embed keys on the token address + a chain slug (note: 'arbitrum', not 'arb'). */
const GMGN_SLUG: Record<string, string> = {
  solana: 'sol',
  ethereum: 'eth',
  base: 'base',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  robinhood: 'robinhood',
};

/** BasedBot's embed keys on the token address + a chain slug. */
const BASEDBOT_SLUG: Record<string, string> = {
  robinhood: 'robinhood',
  base: 'base',
  ethereum: 'ethereum',
  solana: 'solana',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
};

/** Candle size that fills the chart for a token of this age: fresh launches get 1m, older ones 15m. */
export function chartInterval(pairCreatedAt: number | undefined, now = Date.now()): number {
  if (!pairCreatedAt) return 15;
  const ageMin = (now - pairCreatedAt) / 60_000;
  if (ageMin < 90) return 1;
  if (ageMin < 12 * 60) return 5;
  return 15;
}

export function chartEmbedUrl(
  t: { network?: string; address: string; embedUrl?: string; pairCreatedAt?: number } | undefined,
  provider: ChartProvider,
  now = Date.now(),
): string | undefined {
  if (!t) return undefined;
  const interval = chartInterval(t.pairCreatedAt, now);
  if (provider === 'basedbot') {
    const slug = t.network ? BASEDBOT_SLUG[t.network] : undefined;
    if (slug) return `https://basedbot.app/embed/token/${slug}/${t.address}?interval=${interval}`;
  }
  if (provider === 'birdeye') {
    const chain = t.network ? BIRDEYE_CHAIN[t.network] : undefined;
    if (chain) return `https://embed.birdeye.so/tv-widget/${t.address}?chain=${chain}&viewMode=pair&chartInterval=${interval}&chartType=CANDLE&chartTimezone=UTC&chartLeftToolbar=show&theme=dark`;
  }
  if (provider === 'gmgn') {
    const slug = t.network ? GMGN_SLUG[t.network] : undefined;
    if (slug) return `https://www.gmgn.cc/kline/${slug}/${t.address}?theme=dark&interval=${interval}`;
  }
  // a chain the chosen provider doesn't cover (or not known yet): Dexscreener's embed
  return t.embedUrl;
}
