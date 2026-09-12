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
  /** feed id of the message being replied to (discord:<id> | telegram:<chat>:<id>), when known */
  id?: string;
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
  /** embed timestamp (ms), shown after the footer like Discord does */
  timestamp?: number;
}

export interface FeedMessage {
  id: string;
  source: Source;
  chatId: string;
  chatName: string;
  author: string;
  avatar?: string;
  /** the author is a bot user (raw fact from the platform) */
  isBot: boolean;
  /** set by the hub: blacklisted, or a bot the bot policy does not allow. Hidden posts never count as calls. */
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
  /** this message pinged you: a direct mention or reply, @everyone/@here, or one of your roles */
  mention?: 'user' | 'everyone' | 'role';
  reactions?: Reaction[];
  chatAvatar?: string;
  media?: MediaItem[];
  previews?: LinkPreview[];
}

/** Someone pinged you: the message plus a little context either side, gathered as it arrives. */
export interface Mention {
  /** the pinged message's id */
  id: string;
  msg: FeedMessage;
  /** up to 4 messages in the same chat right before */
  before: FeedMessage[];
  /** up to 4 messages in the same chat after, filled in live */
  after: FeedMessage[];
  read: boolean;
}

/** Someone you could favorite: seen posting in the feed, or found in a chat's member list. */
export interface PersonSeen {
  name: string;
  avatar?: string;
  source: Source;
  /** messages of theirs still in the buffer */
  messages: number;
  /** counted calls across every token we know */
  calls: number;
  /** 0 when they have not posted in a watched chat (found via the member list) */
  lastTs: number;
  chats: string[];
  bot: boolean;
  /** found in a member list rather than the feed */
  member?: boolean;
}

export interface BuyLinks {
  /** which bot these links open */
  provider: 'cove' | 'basedbot';
  amounts: { usd: number; url: string }[];
  panel: string;
  /** a browser fallback (BasedBot's web app) */
  web?: string;
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

/** One chat's first post of a contract: who, where, when, and the market cap at that moment. */
export interface CallRecord {
  author: string;
  avatar?: string;
  chatName: string;
  source: Source;
  msgId: string;
  link?: string;
  ts: number;
  /** market cap when the call was registered (first call: the first enrichment after it) */
  marketCap?: number;
}

/** Holder security from GoPlus (EVM) or RugCheck (Solana). Percentages are 0..100. */
export interface TokenSecurity {
  source: 'goplus' | 'rugcheck';
  fetchedAt: number;
  holders?: number;
  /** share of supply held by the ten largest non-pool wallets */
  top10Pct?: number;
  /** share of supply the deployer still holds */
  devPct?: number;
  devSold?: boolean;
  insidersPct?: number;
  snipersPct?: number;
  bundlersPct?: number;
  lpLockedPct?: number;
  buyTax?: number;
  sellTax?: number;
  honeypot?: boolean;
  mintable?: boolean;
  freezable?: boolean;
  /** RugCheck normalised risk score, 0 (clean) .. 100 */
  score?: number;
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
  /** every counted call, oldest first (bounded) */
  calls: CallRecord[];
  /** market cap at the first call, for the "3.2×" multiplier */
  firstCallMarketCap?: number;
  security?: TokenSecurity;
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

export interface BotPolicy {
  default: 'hide' | 'show';
  /** bot names (case-insensitive, leading @ ignored) shown and counted even when the default hides bots */
  allow: string[];
  /** when bots show by default: whose contract posts become calls. 'all' (default) or only the `allow` list. */
  calls?: 'all' | 'allow';
  /** which bots may ping you: none (default), every bot, or only `pingAllow` */
  pings?: 'none' | 'all' | 'allow';
  pingAllow?: string[];
}

/** A bot the hub has seen, for the bot manager in settings. */
export interface BotSeen {
  name: string;
  avatar?: string;
  source: Source;
  count: number;
  lastTs: number;
  chats: string[];
  hidden: boolean;
  /** its contract posts become calls */
  calls: boolean;
  /** its mentions of you land in Pings */
  pings: boolean;
}

/** One message in a conversation with a Telegram bot (Cove), with its inline keyboard. */
export interface BotMessage {
  id: number;
  ts: number;
  /** sent by us */
  out: boolean;
  text: string;
  /** rows of inline buttons: `data` is a callback (base64), `url` opens a link */
  buttons: { text: string; data?: string; url?: string }[][];
  edited?: boolean;
  hasMedia?: boolean;
}

/** A tweet from J7Tracker's stream, trimmed to what the column renders. */
export interface J7Tweet {
  id: string;
  url?: string;
  ts: number;
  author: { handle: string; name: string; avatar?: string; followers?: number };
  text: string;
  images: string[];
  quoted?: { handle: string; text: string };
  replyTo?: string;
  /** contract addresses found in the text (filled by the hub's detector) */
  contracts: { chain: 'sol' | 'evm'; address: string }[];
  /** $TICKERS mentioned, upper-case */
  tickers: string[];
  /** when J7 saw the tweet get deleted (ms); the entry stays, badged, like on J7 */
  deleted?: number;
  /** tokens launched off this tweet, paired live by the launch watcher */
  launches?: J7Deploy[];
}

/** A token launched with this tweet (or its author) in its metadata links. */
export interface J7Deploy {
  source: 'pump' | 'pons';
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  createdAt: number;
  marketCap?: number;
  twitter: string;
  url: string;
}

// ---- NFT columns ----
export type MintChain = 'ethereum' | 'robinhood' | 'ink' | 'stable' | 'arc';

/** One mint (one tx) seen by MintGo. `preview` rows are replaced by the confirmed row under the same id. */
export interface MintEvent {
  id: string;
  chain: MintChain;
  ts: number;
  txHash: string;
  blockNumber: number;
  contract: {
    address: string;
    name: string;
    symbol?: string;
    image?: string;
    slug?: string;
    openSeaUrl?: string;
    projectUrl?: string;
    twitterUrl?: string;
    standard?: string;
    deployer?: { address: string; createdAgo?: string; projects?: number };
  };
  quantity: number;
  tokenIds: string[];
  tokenIdsTotal?: number;
  minter: string;
  valueEth?: number;
  unitPriceEth?: number;
  priceConfirmed: boolean;
  preview: boolean;
  airdrop: boolean;
  thirdParty: boolean;
  functionName?: string;
  mintedSupply?: number;
  maxSupply?: number;
  surge?: { mints: number; events: number; minters: number; startedAt: number };
}

export type RankingSlug = 'TRENDING' | 'TOP';
export type RankingTimeframe = 'ONE_HOUR' | 'ONE_DAY';
export type RankingKey = `${RankingSlug}:${RankingTimeframe}`;

export interface NftRanking {
  rank: number;
  slug: string;
  name: string;
  image?: string;
  verified: boolean;
  chain: string;
  floor?: { usd: number; unit: number; symbol: string };
  topOffer?: { usd: number; unit: number; symbol: string };
  volume: { usd: number; unit: number; symbol: string };
  sales: number;
  floorChange?: number;
  owners?: number;
  supply?: number;
  listed?: number;
  minting?: { stageType: string; endTime?: string };
}

export type MintJobState = 'quoting' | 'ready' | 'sending' | 'pending' | 'confirmed' | 'failed';

export interface MintJob {
  id: string;
  ts: number;
  updatedAt: number;
  state: MintJobState;
  collection: { slug: string; name: string; image?: string; address: string; chain: string; networkId: number; dropKind: string };
  stage?: { type: string; index: number; startTime?: string; endTime?: string; maxPerWallet?: number; alreadyMinted?: number };
  quantity: number;
  wallet: string;
  price?: { unitWei: string; totalWei: string; symbol: string; usd?: number };
  gas?: { limit: number; maxFeeWei: string; maxPriorityWei: string; estimateWei: string };
  balanceWei?: string;
  txHash?: string;
  blockNumber?: number;
  tokenIds?: string[];
  error?: string;
}

export interface Status {
  discord: DiscordState;
  telegram: TelegramState;
  loginStep: LoginStep;
  error: { discord?: string; telegram?: string; j7?: string; mintgo?: string };
  /** J7Tracker stream */
  j7?: 'disconnected' | 'connecting' | 'connected' | 'auth_error';
  /** MintGo realtime socket */
  mintgo?: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** favorite callers (crown + pings) */
  favorites: string[];
  /** who the Discord plugin is signed in as */
  discordUser?: string;
  /** how Discord is connected: the Vencord bridge (read + write) or a legacy token (read only) */
  discordMode?: 'bridge' | 'token' | 'none';
}

export type ServerEvent =
  | {
      type: 'hello';
      status: Status;
      messages: FeedMessage[];
      tokens: TokenInfo[];
      mentions: Mention[];
      mints: MintEvent[];
      rankings: Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>>;
      mintJobs: MintJob[];
      /** changes on every server start: the page reloads to pick up new assets */
      boot: string;
    }
  | { type: 'message'; msg: FeedMessage }
  | { type: 'token'; token: TokenInfo }
  | { type: 'reactions'; msgId: string; reactions: Reaction[] }
  | { type: 'tokens'; tokens: TokenInfo[] }
  | { type: 'msg'; msgId: string; patch: Partial<FeedMessage> }
  | { type: 'ping'; token: TokenInfo; msg: FeedMessage }
  | { type: 'bot'; bot: string; msg: BotMessage }
  | { type: 'j7'; tweet: J7Tweet }
  | { type: 'mention'; mention: Mention }
  | { type: 'botDelete'; ids: number[] }
  | { type: 'status'; status: Status }
  | { type: 'mint'; mint: MintEvent }
  | { type: 'nftRankings'; key: RankingKey; rows: NftRanking[]; at: number }
  | { type: 'mintJob'; job: MintJob };
