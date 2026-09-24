import type { RoomStatus } from './rooms/manager.js';

export type Source = 'discord' | 'telegram' | 'plugin' | 'vampy';
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
  /** you reacted with this (Telegram: chosen; Discord: a delta from your own user id) */
  mine?: boolean;
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
  /** the chat is this bot's own conversation (a Telegram bot the user added to the feed on purpose): never hidden by the bot policy */
  botChat?: boolean;
  /** the author's standing in the chat: owner, admin, or the custom admin title the group gave them (Telegram groups) */
  authorTag?: string;
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
  /** a Discord forward: the text, embeds and media are the forwarded message's; link opens the original when known */
  forwarded?: { link?: string };
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
  /** a favorite caller's first call rather than a mention: the token they called */
  call?: { address: string; symbol?: string };
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
  /** set once the backfill ran: 'candle' = read from the 1-minute candle of the call's minute (exact), 'cached' = no candle for that minute, the registration number stays; 'vampy' = the market cap Vampy recorded at the call */
  mcSource?: 'candle' | 'cached' | 'scan' | 'chain' | 'vampy';
  /** posted by a bot (an alert bot that called first); a friend's copy uses it to drop bot echoes */
  bot?: true;
  /** TrenchTogether: the friend this call arrived from (absent for calls from this machine's own chats) */
  via?: string;
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
  /** launchpad that deployed it: pumpfun | letsbonk | bankr | stonks | pons | genius | o1 | long | … */
  launchpad?: string;
  launchpadUrl?: string;
  /** one line the launchpad adds to the badge (Long: "anchored to NVDA") */
  launchpadNote?: string;
  /** when the sources last answered for this token; an opened token older than that is asked again */
  enrichedAt?: number;
  /** TrenchTogether: the friend whose machine this call came from (absent for your own calls) */
  via?: string;
  imageUrl?: string;
  /** dexscreener-style chain id: ethereum | base | bsc | solana | robinhood | … */
  network?: string;
  pairAddress?: string;
  /** the other side of the main pool (WETH, USDC, SOL, …): what the token is paired with */
  quoteSymbol?: string;
  /** that asset's contract (0x0 for the chain's native coin in a v4 pool); needed to read v4 pools */
  quoteAddress?: string;
  /** where the current price came from: read from the pool on-chain, or an API (Dexscreener / GeckoTerminal / launchpad) */
  priceSource?: 'chain' | 'api';
  /** when that price was read (ms) */
  priceAt?: number;
  /** the venue of that pool (uniswap, raydium, pumpswap, …), or the launchpad's bonding curve */
  dex?: string;
  chartUrl?: string;
  /** iframe-able live chart (Dexscreener or GeckoTerminal embed) */
  embedUrl?: string;
  explorerUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type DiscordState = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
export type VampyState = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
/** The Vampy subscription behind the key, from GET /me. */
export interface VampyPlan {
  name: string;
  expiresAt?: number;
  daysRemaining?: number;
  /** feeds the key holder built on vampy.app */
  feeds: number;
  /** their ids, so a same-count swap still reads as a change */
  feedIds: string[];
}
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

export type MintJobState = 'quoting' | 'waiting' | 'ready' | 'sending' | 'pending' | 'confirmed' | 'failed';

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
  /** the nonce the transaction was signed with; a later nonce on chain means ours was replaced or dropped */
  nonce?: number;
  /** wall-clock deadline for watching a pending transaction, kept across restarts */
  watchUntil?: number;
  blockNumber?: number;
  tokenIds?: string[];
  error?: string;
  /** waiting: the coming stage the job is queued for; it is quoted again the moment that stage starts */
  waitFor?: { type: string; index: number; startTime: string; retries?: number };
  /** the user armed an automatic send once the stage opens, within these ceilings (wei) */
  armed?: { maxUnitWei: string; maxGasCostWei: string; at: number };
  /** a remark on a job that has not failed (why an armed send was held back, say) */
  note?: string;
  /** the drop as OpenSea shows it: supply, floor, the whole schedule with this wallet's eligibility */
  drop?: MintDropInfo;
}
export interface MintDropInfo {
  minted?: number;
  max?: number;
  floor?: { unit: number; symbol: string; usd?: number };
  disabledReason?: string;
  activeIndex?: number;
  stages: {
    label: string;
    type: string;
    index: number;
    startTime?: string;
    endTime?: string;
    maxPerWallet?: number;
    priceUnit?: number;
    priceUsd?: number;
    priceSymbol?: string;
    allowlistCount?: number;
    /** this wallet can mint in it (undefined: OpenSea did not say) */
    eligible?: boolean;
  }[];
}

export interface Status {
  discord: DiscordState;
  telegram: TelegramState;
  loginStep: LoginStep;
  error: { discord?: string; telegram?: string; j7?: string; mintgo?: string; vampy?: string };
  /** J7Tracker stream */
  j7?: 'disconnected' | 'connecting' | 'connected' | 'auth_error';
  /** MintGo realtime socket */
  mintgo?: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** Vampy feeds (vampy.app API key) */
  vampy?: VampyState;
  /** the plan behind the Vampy key, once GET /me answered */
  vampyPlan?: VampyPlan;
  /** favorite callers (crown + pings) */
  favorites: string[];
  /** who the Discord plugin is signed in as */
  discordUser?: string;
  /** the Telegram account's @handle, lower-case, when it has one (your own scans on both platforms fold into one row) */
  telegramUser?: string;
  /** how Discord is connected: the Vencord bridge (read + write) or a legacy token (read only) */
  discordMode?: 'bridge' | 'token' | 'none';
  /** TrenchTogether: sharing on this machine, and the friends this machine follows */
  together?: {
    sharing: boolean;
    port: number;
    clients: number;
    peers: { name: string; url: string; state: 'connecting' | 'connected' | 'disconnected' | 'unauthorized'; error?: string }[];
    /** machines sharing on this network right now */
    nearby: { id: string; name: string; host: string; port: number; version: string }[];
    /** friends asking to follow this machine, waiting for Allow */
    requests: { id: string; name: string; from: string; code: string; ts: number }[];
    /** this machine's own asks, and where they stand */
    outgoing: { id: string; name: string; host: string; port: number; code: string; state: 'pending' | 'approved' | 'denied' | 'failed'; error?: string }[];
    /** relay rooms this install is in, in config order */
    rooms: RoomStatus[];
  };
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
  | { type: 'mintJob'; job: MintJob }
  | { type: 'mintJobGone'; id: string }
  | { type: 'plugins'; plugins: PluginInfo[] };

/** A plugin as the app lists it: manifest plus install state. */
export interface PluginInfo {
  id: string;
  file: string;
  hash: string;
  manifest?: { id: string; name: string; version: string; api: number; sites: string[]; permissions: string[]; ui: boolean; description: string };
  /** manifest could not be read: the message */
  error?: string;
  enabled: boolean;
  /** the file changed (or was never approved): needs the approval dialog before it can run */
  needsApproval: boolean;
  /** chats this plugin has posted, id → name */
  chats: Record<string, string>;
  /** sites with a shell session right now */
  signedIn: string[];
}

