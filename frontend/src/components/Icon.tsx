export type IconName = 'chart' | 'live' | 'globe' | 'x' | 'telegram' | 'explorer' | 'copy';

// Small inline glyphs. X and Telegram from Simple Icons (CC0); the rest hand-drawn.
const PATHS: Record<IconName, string> = {
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  telegram:
    'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  // candlesticks
  chart:
    'M6 3h2v3h2v9H8v3H6v-3H4V6h2V3zm10 2h2v4h2v8h-2v4h-2v-4h-2V9h2V5zM6 8v5h2V8H6zm10 3v4h2v-4h-2z',
  // play triangle in a rounded frame = live/embedded chart
  live: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h14V6H5zm5 2.5 5 3.5-5 3.5v-7z',
  // globe
  globe:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3.4a15 15 0 0 0-1.3-5.4A8 8 0 0 1 19.9 11zM12 4.1c.9 1.1 1.9 3.3 2.4 6.9H9.6c.5-3.6 1.5-5.8 2.4-6.9zM8.8 5.6A15 15 0 0 0 7.5 11H4.1a8 8 0 0 1 4.7-5.4zM4.1 13h3.4c.1 2 .6 3.9 1.3 5.4A8 8 0 0 1 4.1 13zM12 19.9c-.9-1.1-1.9-3.3-2.4-6.9h4.8c-.5 3.6-1.5 5.8-2.4 6.9zm3.2-1.5a15 15 0 0 0 1.3-5.4h3.4a8 8 0 0 1-4.7 5.4z',
  // magnifier over a block = explorer
  explorer:
    'M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm-3 4h6v2H7V8zm0 3h6v2H7v-2z',
  copy: 'M8 2h10a2 2 0 0 1 2 2v10h-2V4H8V2zM4 6h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 2v12h10V8H4z',
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className={`icon icon-${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}
