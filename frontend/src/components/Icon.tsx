export type IconName = 'chart' | 'live' | 'globe' | 'x' | 'telegram' | 'explorer' | 'copy' | 'search' | 'people' | 'top' | 'dev' | 'insider' | 'sniper' | 'bundle' | 'lock' | 'chat' | 'grip' | 'calls' | 'pencil' | 'close' | 'bell' | 'play' | 'filter' | 'send' | 'reply' | 'trash' | 'split';

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
  // plain magnifier = search on X
  search: 'M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  // two heads = holders
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.7-7 4v3h14v-3c0-2.3-3.7-4-7-4zm7-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-.6 0-1.2.1-1.8.2 1.7 1 2.8 2.4 2.8 3.8v3h6v-3c0-2.3-3.7-4-7-4z',
  // podium = top 10
  top: 'M9 4h6v16H9V4zm-7 8h6v8H2v-8zm14 4h6v4h-6v-4z',
  // wrench = dev
  dev: 'M21.7 6.3a6 6 0 0 1-7.6 7.6L6.4 21.6a2 2 0 0 1-2.8-2.8l7.7-7.7a6 6 0 0 1 7.6-7.6l-3.4 3.4 1.4 2.8 2.8 1.4 2-2z',
  // eye = insiders
  insider: 'M12 5C6.5 5 2.3 8.6 1 12c1.3 3.4 5.5 7 11 7s9.7-3.6 11-7c-1.3-3.4-5.5-7-11-7zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  // crosshair = snipers
  sniper: 'M11 2h2v3.1a7 7 0 0 1 5.9 5.9H22v2h-3.1a7 7 0 0 1-5.9 5.9V22h-2v-3.1A7 7 0 0 1 5.1 13H2v-2h3.1A7 7 0 0 1 11 5.1V2zm1 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  // stacked boxes = bundlers
  bundle: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.4 3.2L12 10.6 5.6 7.4 12 4.2zM5 9.1l6 3v7.3l-6-3V9.1zm8 10.3v-7.3l6-3v7.3l-6 3z',
  // speech bubble = jump to the message
  chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v11h2v2.3L8.4 16H20V5H4z',
  // two panes stacked = split a column
  split: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v6h14V5H5zm0 8v6h14v-6H5z',
  // six dots = drag grip
  grip: 'M9 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  // square with a slash = calls column
  calls: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5H5zm9.3 2.6 1.4 1.4-7 7-1.4-1.4 7-7z',
  // pencil = edit
  pencil: 'M17 3l4 4-11.5 11.5L5 20l1.5-4.5L17 3zm0 2.8L8.1 14.7l-.6 1.8 1.8-.6L18.2 7 17 5.8z',
  // × = close / remove
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4L12 10.6l6.3-6.3 1.4 1.4z',
  // bell = alerts
  bell: 'M12 2a6 6 0 0 0-6 6v3.6L4.3 15A1 1 0 0 0 5 16.7h14a1 1 0 0 0 .7-1.7L18 11.6V8a6 6 0 0 0-6-6zm0 2a4 4 0 0 1 4 4v4.4l1.1 1.3H6.9L8 12.4V8a4 4 0 0 1 4-4zm-2 14a2 2 0 0 0 4 0h-4z',
  play: 'M8 5v14l11-7z',
  // paper plane = send
  send: 'M2.5 3.5 21.5 12 2.5 20.5l2.4-7.2L15 12 4.9 10.7 2.5 3.5z',
  // curved arrow = reply
  reply: 'M10 7V4L3 10l7 6v-3.2c4.5 0 7.7 1.4 10 4.7-.9-4.6-3.6-9.3-10-10.5z',
  // funnel = filters
  filter: 'M3 4h18v2.6L14 14.2V20l-4 2v-7.8L3 6.6V4zm2.5 2 5.5 6.3V18.7l1-.5v-5.9L17.5 6h-12z',
  // padlock = lp locked
  lock: 'M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3zm0 10a1.5 1.5 0 0 0-.5 2.9V19h1v-2.1A1.5 1.5 0 0 0 12 14z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7',
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className={`icon icon-${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}
