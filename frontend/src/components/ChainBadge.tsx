import { netLabel } from '../format';

// Chain marks. Ethereum / Solana / BNB from Simple Icons (CC0); Base and Robinhood drawn by hand;
// Ink is the mark from its own logo (docs.inkonchain.com), scaled to 24. Arc is the arch from
// Circle's own logo file (arc.io, logo-ondark.svg, first subpath), scaled from its 50 box to 24.
const MARKS: Record<string, string> = {
  ethereum: 'M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z',
  solana:
    'M23.876 18.031l-3.962 4.14a.92.92 0 0 1-.306.213.94.94 0 0 1-.367.075H.462a.47.47 0 0 1-.252-.073.44.44 0 0 1-.17-.196.42.42 0 0 1-.032-.253.44.44 0 0 1 .118-.23l3.966-4.14a.92.92 0 0 1 .305-.212.94.94 0 0 1 .366-.075h18.78a.47.47 0 0 1 .252.073.44.44 0 0 1 .17.196.42.42 0 0 1 .031.253.44.44 0 0 1-.118.23zm-3.962-8.336a.92.92 0 0 0-.306-.213.94.94 0 0 0-.367-.075H.462a.47.47 0 0 0-.252.073.44.44 0 0 0-.17.196.42.42 0 0 0-.032.253.44.44 0 0 0 .118.23l3.966 4.14a.92.92 0 0 0 .305.212.94.94 0 0 0 .366.075h18.78a.47.47 0 0 0 .252-.073.44.44 0 0 0 .17-.196.42.42 0 0 0 .031-.253.44.44 0 0 0-.118-.23zM.462 6.583h18.78a.94.94 0 0 0 .367-.075.92.92 0 0 0 .306-.213l3.962-4.14a.44.44 0 0 0 .118-.23.42.42 0 0 0-.031-.253.44.44 0 0 0-.17-.196.47.47 0 0 0-.252-.073H4.763a.94.94 0 0 0-.366.075.92.92 0 0 0-.305.212L.128 5.83a.44.44 0 0 0-.118.23.42.42 0 0 0 .032.253.44.44 0 0 0 .17.196.47.47 0 0 0 .252.073z',
  bsc: 'M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001l2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2723-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z',
  arc: 'M11.45 0 C14.89 0 17.94 2.97 20.05 8.38 C21.14 11.19 21.95 14.52 22.43 18.16 C22.47 18.48 22.51 18.81 22.55 19.14 C22.56 19.16 22.57 19.18 22.56 19.19 C22.56 19.19 22.84 20.95 22.9 24 H22.87 C22.46 23.66 17.54 19.79 9.39 20.91 C9.51 19.53 9.68 18.19 9.9 16.91 C9.91 16.84 9.92 16.78 9.94 16.71 C13.13 16.62 15.93 16.99 18.08 17.47 C18.07 17.42 18.06 17.37 18.05 17.32 C17.61 14.57 16.96 12.06 16.12 9.91 C14.75 6.4 12.96 4.21 11.45 4.21 C9.94 4.21 8.15 6.4 6.78 9.91 C6.45 10.76 6.15 11.67 5.88 12.62 C5.5 13.96 5.17 15.4 4.92 16.91 C4.54 19.13 4.3 21.52 4.22 24 H0 C0.19 18.12 1.19 12.64 2.86 8.38 C4.96 2.98 8.02 0 11.45 0 Z',
  // Base: solid disc with the slot cut from its left edge.
  base: 'M12 1a11 11 0 1 1 0 22A11 11 0 0 1 12 1zm-1.6 9.6H1.05a11 11 0 0 0 0 2.8h9.35v-2.8z',
  // Robinhood: a feather.
  robinhood:
    'M19.6 2.2c-.4-.3-1-.2-1.6 0-4.4 1.4-8.4 4.9-10.6 9.6-.9 1.9-1.4 3.9-1.6 5.8l-2.6 4.2c-.3.5-.1 1.1.4 1.4.5.3 1.1.1 1.4-.4l2.5-4.1c1.8-.2 3.7-.8 5.5-1.9 4.3-2.7 7.1-7.4 7.4-12.5 0-.8-.3-1.6-.8-2.1zm-3.9 6.4-5.8 7.2c.1-1.3.5-2.7 1.2-4.1 1.5-3.2 4-5.9 6.9-7.4-.5 1.5-1.2 3-2.3 4.3z',
  ink: 'M 12 0 C 18.63 0 24 5.37 24 12 C 24 18.63 18.63 24 12 24 C 5.37 24 0 18.63 0 12 C 0 5.37 5.37 0 12 0Z M 12.1 22.48 C 13.04 22.46 13.71 21.8 13.71 20.98 C 13.71 20.15 13.06 19.54 12.23 19.54 C 11.81 19.54 11.62 19.54 11.43 19.54 C 11.27 19.53 11.12 19.52 10.84 19.5 L 10.83 19.49 L 10.65 19.48 C 9.83 19.42 9.14 18.81 9.14 17.99 C 9.14 17.16 9.81 16.49 10.65 16.49 H 12.2 C 13.04 16.49 13.71 15.82 13.71 15 C 13.71 14.17 13.04 13.5 12.2 13.5 H 7.09 C 6.25 13.5 5.58 12.83 5.58 12 C 5.58 11.17 6.25 10.5 7.09 10.5 H 17.23 C 18.07 10.5 18.74 9.83 18.74 9.01 C 18.74 8.18 18.07 7.51 17.23 7.51 H 10.65 C 9.81 7.51 9.14 6.84 9.14 6.01 C 9.14 5.19 9.9 4.58 10.65 4.52 C 11.39 4.46 11.43 4.46 12.2 4.46 C 12.98 4.46 13.71 3.85 13.71 3.02 C 13.71 2.2 13.16 1.54 12.09 1.52 C 12.06 1.52 12.03 1.52 12 1.52 C 6.21 1.52 1.52 6.21 1.52 12 C 1.52 17.78 6.2 22.47 11.98 22.48 H 12.02 C 12.04 22.48 12.07 22.48 12.1 22.48Z',
};

/** Marks whose glyph is a hole cut out of a disc (the source path relies on even-odd filling). */
const EVEN_ODD = new Set(['ink']);

export function ChainBadge({
  network,
  chain,
  size = 12,
  className = '',
}: {
  network?: string;
  chain: 'sol' | 'evm';
  size?: number;
  className?: string;
}) {
  const key = network ?? (chain === 'sol' ? 'solana' : '');
  const path = MARKS[key];
  const label = netLabel(network, chain);
  return (
    <span className={`net net-${key || chain} ${path ? 'net-mark' : ''} ${className}`} title={label}>
      {path ? (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-label={label} role="img">
          <path d={path} fill="currentColor" fillRule={EVEN_ODD.has(key) ? 'evenodd' : undefined} />
        </svg>
      ) : (
        label
      )}
    </span>
  );
}

/** What the token trades against (WETH, USDC, SOL, …) and where; nothing until a pool is known. */
export function PairChip({ t, className = '' }: { t: { quoteSymbol?: string; dex?: string } | undefined; className?: string }) {
  if (!t?.quoteSymbol) return null;
  const venue = t.dex ? t.dex.replace(/[_-]/g, ' ') : undefined;
  return (
    <span className={`pair-chip ${className}`} title={venue ? `paired with ${t.quoteSymbol} on ${venue}` : `paired with ${t.quoteSymbol}`}>
      <span className="pair-chip-sep">/</span>
      {t.quoteSymbol}
    </span>
  );
}
