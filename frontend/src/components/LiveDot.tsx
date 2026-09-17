import type { TokenInfo } from '../types';

/** A green dot next to a price that is being read straight from the pool (Uniswap v2/v3/v4, pump.fun). */
export function LiveDot({ t }: { t: Pick<TokenInfo, 'priceSource' | 'dex'> | undefined }) {
  if (t?.priceSource !== 'chain') return null;
  return <span className="live-dot" title={`live from the pool${t.dex ? ` (${t.dex})` : ''}`} aria-label="live price" />;
}
