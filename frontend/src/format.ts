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
