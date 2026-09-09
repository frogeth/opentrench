export type Source = 'discord' | 'telegram';
export type Chain = 'sol' | 'evm';

export interface Contract {
  chain: Chain;
  address: string;
}

export interface Reaction {
  /** stable id: the emoji itself, or custom:<id> */
  key: string;
  name: string;
  count: number;
  imageUrl?: string;
}

export interface ReplyContext {
  author: string;
  text: string;
}

export interface MediaItem {
  kind: 'image' | 'gif' | 'video' | 'sticker';
  url: string;
  poster?: string;
  /** content type when known, so the client picks <img> vs <video> */
  mime?: string;
}

export interface LinkPreview {
  url: string;
  site: 'x' | 'web';
  title?: string;
  author?: string;
  handle?: string;
  text?: string;
  image?: string;
  avatar?: string;
}

/** A Discord rich embed (bot/webhook cards), kept structured so the UI can render it like Discord does. */
export interface EmbedInfo {
  title?: string;
  url?: string;
  description?: string;
  /** css color, e.g. #5865f2 */
  color?: string;
  author?: { name: string; url?: string; icon?: string };
  fields: { name: string; value: string; inline: boolean }[];
  thumbnail?: string;
  image?: string;
  footer?: string;
}

export interface FeedMessage {
  id: string;
  source: Source;
  chatId: string;
  chatName: string;
  author: string;
  avatar?: string;
  isBot: boolean;
  /** blacklisted, or a bot the bot policy does not allow; never counts as a call */
  hidden?: boolean;
  /** everything, flattened (embeds included): what contract detection and search look at */
  text: string;
  /** the message body alone, present when embeds are attached (the UI shows body + embeds instead of text) */
  body?: string;
  embeds?: EmbedInfo[];
  ts: number;
  contracts: Contract[];
  /** true when every contract in this message had already been posted in this chat */
  repeat: boolean;
  link?: string;
  hasAttachment: boolean;
  replyTo?: ReplyContext;
  reactions?: Reaction[];
  chatAvatar?: string;
  media?: MediaItem[];
  previews?: LinkPreview[];
}

export interface BuyLinks {
  amounts: { usd: number; url: string }[];
  panel: string;
}

export interface FirstCaller {
  author: string;
  avatar?: string;
  chatName: string;
  source: Source;
  msgId: string;
  link?: string;
  ts: number;
}

export interface TokenInfo {
  chain: Chain;
  address: string;
  firstCaller?: FirstCaller;
  buy?: BuyLinks;
  /** number of distinct chats that have posted this contract */
  seen: number;
  /** names of those chats, in order of first post */
  calledIn: string[];
  firstSeenTs: number;
  /** when the most recent chat called it (drives Calls ordering) */
  lastCallTs: number;
  name?: string;
  symbol?: string;
  priceUsd?: number;
  marketCap?: number;
  /** highest market cap seen since the first call */
  athMarketCap?: number;
  liquidity?: number;
  change24h?: number;
  volume24h?: number;
  buys24h?: number;
  sells24h?: number;
  /** pair creation time (ms) — the token's age */
  pairCreatedAt?: number;
  /** launchpad that deployed it: pumpfun | letsbonk | bankr | stonks | pons | o1 */
  launchpad?: string;
  launchpadUrl?: string;
  imageUrl?: string;
  /** dexscreener-style chain id: ethereum | base | bsc | solana | robinhood | … */
  network?: string;
  pairAddress?: string;
  chartUrl?: string;
  /** iframe-able live chart (Dexscreener or GeckoTerminal embed) */
  embedUrl?: string;
  explorerUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type DiscordState = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
export type TelegramState = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'auth_error';
export type LoginStep = 'idle' | 'code' | 'password' | 'done';

export interface Status {
  discord: DiscordState;
  telegram: TelegramState;
  loginStep: LoginStep;
  error: { discord?: string; telegram?: string };
  /** favorite callers (crown + pings) */
  favorites: string[];
}

export type ServerEvent =
  | { type: 'hello'; status: Status; messages: FeedMessage[]; tokens: TokenInfo[]; boot: string }
  | { type: 'message'; msg: FeedMessage }
  | { type: 'token'; token: TokenInfo }
  | { type: 'reactions'; msgId: string; reactions: Reaction[] }
  | { type: 'tokens'; tokens: TokenInfo[] }
  | { type: 'msg'; msgId: string; patch: Partial<FeedMessage> }
  | { type: 'ping'; token: TokenInfo; msg: FeedMessage }
  | { type: 'status'; status: Status };
