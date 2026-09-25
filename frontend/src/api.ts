import type { PluginInfo, Source, WatchEntry } from './types';

/** what a plugin's log lines are tagged with (the backend keeps these three) */
export type PluginLogLevel = 'info' | 'warn' | 'error';

/**
 * Marks a request as the app's own. The backend refuses every write under /api/plugins and /api/shell
 * without it: a custom header forces a CORS preflight, so nothing running in a sandboxed frame or in
 * some other page can reach those routes, whatever it guesses about the port.
 */
const REQUESTED_WITH = { 'x-requested-with': 'opentrench' } as const;

/** A refusal the backend explained: its status and the rest of what it answered, for callers that act on it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { ...REQUESTED_WITH, 'content-type': 'application/json' } : { ...REQUESTED_WITH },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data);
  return data as T;
}

/** A route that answers with a file rather than JSON; a refusal is still JSON, so it is unwrapped here. */
async function text(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { headers: { ...REQUESTED_WITH } });
  const body = await res.text();
  if (!res.ok) {
    let error = res.statusText;
    try {
      error = JSON.parse(body).error ?? error;
    } catch {
      /* not JSON: keep the status */
    }
    throw new Error(error);
  }
  return body;
}

export interface BotPolicy {
  default: 'hide' | 'show';
  allow: string[];
  /** when bots show by default: whose contract posts become calls. 'all' (default) or only the `allow` list. */
  calls?: 'all' | 'allow';
  /** which bots may ping you: none (default), every bot, or only `pingAllow` */
  pings?: 'none' | 'all' | 'allow';
  pingAllow?: string[];
}
export interface BotSeen {
  name: string;
  avatar?: string;
  source: 'discord' | 'telegram';
  count: number;
  lastTs: number;
  chats: string[];
  hidden: boolean;
  calls: boolean;
  pings: boolean;
}
export interface SitePreview {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}
export interface XProfile {
  handle: string;
  name: string;
  url: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  followers?: number;
  following?: number;
  tweets?: number;
  joined?: number;
  location?: string;
  website?: string;
  verified?: boolean;
}
/** Per-column filters. Every field optional; absent = no constraint. Numbers are minimums/maximums in USD, %, minutes or counts. */
export interface ColumnFilters {
  // callers (both types)
  showOnly?: string[];
  muted?: string[];
  // chat columns
  search?: string;
  excludeBots?: boolean;
  contractsOnly?: boolean;
  /** contracts-only columns: also keep the caller's next N messages in that chat (their thesis), 0–3 */
  thesis?: number;
  /** …and the caller's previous N messages before the call, 0–3 */
  thesisBefore?: number;
  // calls columns
  chains?: string[];
  launchpads?: string[];
  must?: string[]; // website | twitter | telegram | social | image | devSold | lpLocked
  mcMin?: number; mcMax?: number;
  liqMin?: number; liqMax?: number;
  volMin?: number; volMax?: number;
  mcLiqMin?: number; mcLiqMax?: number;
  multMin?: number; multMax?: number;
  holdersMin?: number; holdersMax?: number;
  ageMin?: number; ageMax?: number; // minutes
  txMin?: number; txMax?: number;
  buysMin?: number; buysMax?: number;
  sellsMin?: number; sellsMax?: number;
  top10Min?: number; top10Max?: number;
  snipersMin?: number; snipersMax?: number;
  insidersMin?: number; insidersMax?: number;
  bundlersMin?: number; bundlersMax?: number;
  devMin?: number; devMax?: number;
  callsMin?: number; callsMax?: number;
  // mints column
  minQty?: number;
}
export const WATCH_SORT_KEYS = ['added', 'symbol', 'price', 'marketCap', 'change1h', 'sinceAdded', 'lastCall'] as const;
export type WatchSortKey = (typeof WATCH_SORT_KEYS)[number];

export interface ColumnDef {
  id: string;
  type: 'calls' | 'chat' | 'callers' | 'trending' | 'cove' | 'salpha' | 'j7' | 'web' | 'mints' | 'nftvol' | 'osmint' | 'tgbot' | 'plugin' | 'vampy' | 'watchlist';
  title: string;
  /** `<source>:<id>` keys of watched chats; empty = all */
  chats: string[];
  /** vampy columns: the Vampy feed this column mirrors (`chats` is then exactly `vampy:<feed>`) */
  feed?: string;
  /** web columns: the page to embed */
  url?: string;
  /** tgbot columns: the bot's username (no @) */
  bot?: string;
  /** plugin columns: the plugin id whose UI this column shows */
  plugin?: string;
  /** nftvol: which OpenSea list, and which rolling window */
  ranking?: 'trending' | 'top';
  timeframe?: '1h' | '1d';
  /** nftvol: lead floor and volume with the chain's coin (ETH…) or with dollars */
  currency?: 'native' | 'usd';
  /** a second column stacked under this one (one level only), sharing its width */
  split?: { bottom: ColumnDef; ratio?: number };
  /** fixed width in px (drag-resized); unset = share the space */
  width?: number;
  /** callers leaderboard window (24h/7d/30d) or trending window (5m/1h/6h/24h) */
  window?: '5m' | '1h' | '6h' | '24h' | '7d' | '30d';
  /** content scale for this column only (ctrl/⌘ + wheel), 0.5–1.5; unset = 1 */
  zoom?: number;
  /** play a sound when a new call lands in this column */
  alert?: { on: boolean; sound: string };
  filters?: ColumnFilters;
  /** watchlist columns: the header the rows are sorted by */
  watchSort?: { key: WatchSortKey; dir: 'asc' | 'desc' };
}
/** A saved arrangement of the column terminal (header → Layouts). */
export interface Layout {
  id: string;
  name: string;
  columns: ColumnDef[];
}
export interface MaskedConfig {
  discord: { hasToken: boolean; watch: string[]; canSend: boolean };
  telegram: { apiId: number | null; hasApiHash: boolean; hasSession: boolean; watch: string[]; canSend: boolean };
  cove: { amounts: number[] };
  buy: { provider: 'cove' | 'basedbot' };
  blacklist: string[];
  bots: BotPolicy;
  favorites: string[];
  pingTelegram: boolean;
  hasO1Key: boolean;
  j7: { hasToken: boolean; favorites: string[] };
  vampy: { hasKey: boolean };
  railOrder: string[];
  columns: ColumnDef[];
  layouts: Layout[];
  seenTokens: string[];
  hiddenTokens: string[];
  watchlist: WatchEntry[];
  together: {
    share: boolean;
    name: string;
    peers: { host: string; port: number; name: string }[];
    /** relay rooms, without their keys */
    rooms: { id: string; relay: string; name: string; joinedAt: number }[];
    memberId: string;
    relay: string;
  };
  opensea: { hasWallet: boolean; walletAddress?: string };
  plugins: Record<string, { enabled: boolean; approvedHash?: string }>;
  pluginWatch: string[];
  /** the one RPC table for everything on-chain, by network */
  rpc: Record<string, string>;
  marketData: { hasAlchemyKey: boolean };
}
/** Settings → Feed → Market data: what the live pricer is using per chain */
export interface MarketStatus {
  alchemy: { hasKey: boolean; chains: string[]; probedAt?: number; probing: boolean; error?: string };
  rpc: Record<string, string>;
  /** dollar prices of the quote assets read on-chain, by `${network}:${address}` */
  quotes: Record<string, number>;
  /** tokens some screen is showing right now (what the pricer reads) */
  visible: number;
  chains: {
    network: string;
    name: string;
    native: string;
    /** Alchemy serves this chain (with a key) */
    alchemy: boolean;
    defaultRpc: string;
    source: 'custom' | 'alchemy' | 'public';
    live?: number;
    skipped?: number;
    /** why tokens were skipped, counted by reason */
    reasons?: Record<string, number>;
    lastOkAt?: number;
    lastError?: string;
  }[];
}
/** A feed built on vampy.app, as the column editor lists it. */
export interface VampyFeedInfo {
  id: string;
  title: string;
  type: 'call' | 'message';
  channels: { name?: string; server?: string }[];
}
export interface WatchedChat {
  /** a plugin chat's id is its whole watch key, `plugin:<plugin>:<chat>`; a Vampy chat's is the feed id */
  id: string;
  name: string;
  source: Source;
  avatar?: string;
}
export interface DiscordChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  guildIcon?: string;
  category?: string;
  position: number;
  /** a DM or group DM (guildId 'dm') */
  dm?: boolean;
  avatar?: string;
}
/** A relay room this install is in, as the settings screen shows it: no key; the invite is what friends paste. */
export interface RoomInfo {
  id: string;
  name: string;
  relay: string;
  joinedAt: number;
  /** the relay wants an access code and one is set */
  hasAccess: boolean;
  invite: string;
}
export interface TogetherInfo {
  share: boolean;
  name: string;
  peers: { host: string; port: number; name: string }[];
  /** one per LAN address, only while sharing */
  pairings: string[];
  rooms: RoomInfo[];
  /** this install's id on relays; not a secret */
  memberId: string;
  /** the relay new rooms go on; '' = the app default */
  relay: string;
  status?: import('./types').Status['together'];
}
/** What the "check" on a relay URL found. Never a thrown error: a wrong URL is an answer. */
export type RelayProbe = { ok: true; v: number; rooms: number } | { ok: false; error: string };

export interface TelegramDialog {
  id: string;
  title: string;
  type: 'group' | 'channel' | 'dm' | 'bot';
  /** public @handle, when there is one */
  username?: string;
}

/** one row of a composer's "/" menu (backend SlashMenuItem) */
export interface SlashItem {
  name: string;
  description: string;
  app?: string;
  icon?: string;
  /** what goes into the box when picked */
  fill: string;
  id?: string;
  options?: SlashOption[];
}
export interface SlashOption {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  options?: SlashOption[];
}

export const api = {
  config: () => req<MaskedConfig>('GET', '/config'),
  discordChannels: () => req<DiscordChannel[]>('GET', '/discord/channels'),
  setDiscordWatch: (ids: string[]) => req('PUT', '/discord/watch', { ids }),
  setTelegramCreds: (apiId: number, apiHash: string) => req('PUT', '/telegram/credentials', { apiId, apiHash }),
  tgStart: (phone: string) => req<{ step: string }>('POST', '/telegram/login/start', { phone }),
  tgCode: (code: string) => req<{ step: string }>('POST', '/telegram/login/code', { code }),
  tgPassword: (password: string) => req<{ step: string }>('POST', '/telegram/login/password', { password }),
  tgLogout: () => req('POST', '/telegram/logout'),
  telegramDialogs: () => req<TelegramDialog[]>('GET', '/telegram/dialogs'),
  setTelegramWatch: (ids: string[]) => req('PUT', '/telegram/watch', { ids }),
  setCove: (amounts: number[]) => req('PUT', '/cove', { amounts }),
  setBuy: (provider: 'cove' | 'basedbot') => req<{ provider: 'cove' | 'basedbot' }>('PUT', '/buy', { provider }),
  setBlacklist: (names: string[]) => req('PUT', '/blacklist', { names }),
  blacklistAdd: (name: string) => req('POST', '/blacklist/add', { name }),
  bots: () => req<BotSeen[]>('GET', '/bots'),
  setBots: (policy: BotPolicy) => req('PUT', '/bots', policy),
  botShow: (name: string, show: boolean) => req('POST', '/bots/show', { name, show }),
  favoriteToggle: (name: string) => req<{ favorite: boolean }>('POST', '/favorites/toggle', { name }),
  setFavorites: (names: string[]) => req('PUT', '/favorites', { names }),
  setPings: (telegram: boolean) => req('PUT', '/pings', { telegram }),
  setO1Key: (apiKey: string) => req('PUT', '/o1', { apiKey }),
  setRailOrder: (ids: string[]) => req('PUT', '/rail-order', { ids }),
  setDiscordSend: (enabled: boolean, confirm = '') => req<{ canSend: boolean }>('PUT', '/discord/send', { enabled, confirm }),
  setTelegramSend: (enabled: boolean) => req<{ canSend: boolean }>('PUT', '/telegram/send', { enabled }),
  /** forward a Telegram message (chat id or bot username) into a chat in the feed */
  forward: (fromChat: string, msgId: number, source: 'discord' | 'telegram', chatId: string, note = '') => req<{ ok: true }>('POST', '/forward', { fromChat, msgId, source, chatId, note }),
  send: (source: 'discord' | 'telegram', chatId: string, text: string, replyTo?: string) => req<{ ok: true }>('POST', '/send', { source, chatId, text, replyTo }),
  setJ7Token: (token: string) => req<{ hasToken: boolean }>('PUT', '/j7/token', { token }),
  setVampyKey: (key: string) => req<{ hasKey: boolean }>('PUT', '/vampy/key', { key }),
  vampyFeeds: () => req<VampyFeedInfo[]>('GET', '/vampy/feeds'),
  lookupToken: (address: string) => req<import('./types').TokenInfo>('GET', `/token/${encodeURIComponent(address)}`),
  /** send one image (raw body) with an optional caption */
  sendFile: async (source: 'discord' | 'telegram', chatId: string, file: File, text = '', replyTo?: string) => {
    const q = new URLSearchParams({ source, chatId, text, name: file.name || 'image.png', ...(replyTo ? { replyTo } : {}) });
    const res = await fetch(`/api/send-file?${q}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
    return data as { ok: true };
  },
  /** legacy read-only token; empty string removes it */
  members: (source: 'discord' | 'telegram', chatId: string) => req<(import('./types').PersonSeen & { favorite: boolean })[]>('GET', `/members/${source}/${encodeURIComponent(chatId)}`),
  people: (q: string) => req<import('./types').PersonSeen[]>('GET', `/people?q=${encodeURIComponent(q)}`),
  mentions: () => req<import('./types').Mention[]>('GET', '/mentions'),
  markMentionsRead: (ids?: string[]) => req<{ marked: number }>('POST', '/mentions/read', ids ? { ids } : {}),
  j7Recent: () => req<import('./types').J7Tweet[]>('GET', '/j7/recent'),
  j7Favorite: (handle: string) => req<{ favorite: boolean; favorites: string[] }>('POST', '/j7/favorites/toggle', { handle }),
  j7Deploys: (id: string, handle: string, ts: number) =>
    req<{ deploys: import('./types').J7Deploy[]; scanned: { pump?: number; bonk?: number } }>('GET', `/j7/deploys?id=${encodeURIComponent(id)}&handle=${encodeURIComponent(handle)}&ts=${ts}`),
  botHistory: (bot: string) => req<import('./types').BotMessage[]>('GET', `/bot/${encodeURIComponent(bot)}/history`),
  botStart: (bot: string, payload: string) => req<{ ok: true }>('POST', `/bot/${encodeURIComponent(bot)}/start`, { payload }),
  botSend: (bot: string, text: string) => req<{ ok: true }>('POST', `/bot/${encodeURIComponent(bot)}/send`, { text }),
  /** the "/" menu for a chat in the feed: Discord slash commands or the bots' commands in a Telegram chat */
  commands: (source: 'discord' | 'telegram', chatId: string, q = '') => req<SlashItem[]>('GET', `/commands/${source}/${encodeURIComponent(chatId)}?q=${encodeURIComponent(q)}`),
  /** run a Discord slash command typed as text */
  runCommand: (chatId: string, name: string, args: string) => req<{ ok: true }>('POST', '/commands/run', { chatId, name, args }),
  /** the bot's published slash commands */
  botCommands: (bot: string) => req<{ command: string; description: string }[]>('GET', `/bot/${encodeURIComponent(bot)}/commands`),
  botPress: (bot: string, msgId: number, data: string) => req<{ message?: string; alert?: boolean; url?: string; gone?: boolean }>('POST', `/bot/${encodeURIComponent(bot)}/press`, { msgId, data }),
  react: (source: 'discord' | 'telegram', chatId: string, msgId: string, key: string, name: string, on: boolean) =>
    req<{ ok: true }>('POST', '/react', { source, chatId, msgId, key, name, on }),
  markSeen: (add: string[], remove: string[] = []) => req<{ count: number }>('POST', '/seen', { add, remove }),
  /** TrenchTogether: share calls with a friend on the same network */
  together: () => req<TogetherInfo>('GET', '/together'),
  setTogether: (patch: { share?: boolean; name?: string }) => req<TogetherInfo>('PUT', '/together', patch),
  rotateTogether: () => req<{ pairings: string[] }>('POST', '/together/rotate'),
  addPeer: (pairing: string) => req<TogetherInfo>('POST', '/together/peers', { pairing }),
  reconnectPeers: () => req<{ status: import('./types').Status['together'] }>('POST', '/together/reconnect'),
  removePeer: (host: string, port: number) => req<TogetherInfo>('DELETE', '/together/peers', { host, port }),
  followNearby: (id: string) => req<{ status: import('./types').Status['together'] }>('POST', `/together/nearby/${encodeURIComponent(id)}/follow`),
  forgetOutgoing: (id: string) => req<{ status: import('./types').Status['together'] }>('DELETE', `/together/outgoing/${encodeURIComponent(id)}`),
  answerRequest: (id: string, allow: boolean) => req<{ status: import('./types').Status['together'] }>('POST', `/together/requests/${encodeURIComponent(id)}/${allow ? 'allow' : 'deny'}`),
  /** rooms: a private channel over a relay; the invite is the whole secret */
  createRoom: (name: string, relay?: string) => req<{ room: RoomInfo; status: import('./types').Status['together'] }>('POST', '/together/rooms', { name, ...(relay ? { relay } : {}) }),
  joinRoom: (invite: string, name?: string, access?: string) =>
    req<{ room: RoomInfo; status: import('./types').Status['together'] }>('POST', '/together/rooms/join', { invite, ...(name ? { name } : {}), ...(access ? { access } : {}) }),
  leaveRoom: (id: string) => req<{ ok: true; status: import('./types').Status['together'] }>('DELETE', `/together/rooms/${encodeURIComponent(id)}`),
  rotateRoom: (id: string) => req<{ room: RoomInfo; status: import('./types').Status['together'] }>('POST', `/together/rooms/${encodeURIComponent(id)}/rotate`),
  setRoomAccess: (id: string, access: string) => req<{ ok: true }>('PUT', `/together/rooms/${encodeURIComponent(id)}/access`, { access }),
  /** the relay new rooms go on; '' returns to the default */
  setRelay: (relay: string) => req<{ relay: string }>('PUT', '/together/relay', { relay }),
  probeRelay: (url: string) => req<RelayProbe>('GET', `/together/relay/probe?url=${encodeURIComponent(url)}`),
  /** hide call cards from the calls columns (the token keeps being tracked) */
  markHidden: (add: string[], remove: string[] = []) => req<{ count: number }>('POST', '/hidden', { add, remove }),
  setColumns: (columns: ColumnDef[]) => req<ColumnDef[]>('PUT', '/columns', { columns }),
  saveLayout: (name: string) => req<{ layout: Layout; layouts: Layout[] }>('POST', '/layouts', { name }),
  loadLayout: (id: string) => req<{ columns: ColumnDef[] }>('POST', `/layouts/${encodeURIComponent(id)}/load`),
  deleteLayout: (id: string) => req<{ layouts: Layout[] }>('DELETE', `/layouts/${encodeURIComponent(id)}`),
  watched: () => req<WatchedChat[]>('GET', '/watched'),
  telegramResolve: (username: string) => req<{ id: string; name: string; bot: boolean }>('GET', `/telegram/resolve/${encodeURIComponent(username)}`),
  tickers: () => req<{ sym: string; usd: number; change24h: number }[]>('GET', '/tickers'),
  longAsset: (asset: unknown, symbols: Record<string, string>) => req<{ applied: boolean }>('POST', '/long/asset', { asset, symbols }),
  ohlcv: (address: string, interval: string) =>
    req<{ candles: { t: number; o: number; h: number; l: number; c: number; v: number }[]; mcPerPrice?: number; reason?: string }>(
      'GET',
      `/token/${encodeURIComponent(address)}/ohlcv?interval=${interval}`,
    ),
  sitePreview: (url: string) => req<SitePreview | null>('GET', `/site-preview?url=${encodeURIComponent(url)}`),
  xProfile: (handle: string) => req<XProfile | null>('GET', `/x-profile/${encodeURIComponent(handle)}`),
  preview: (source: 'discord' | 'telegram', id: string) =>
    req<import('./types').FeedMessage[]>('GET', `/preview/${source}/${encodeURIComponent(id)}`),
  opensea: () => req<MaskedConfig['opensea']>('GET', '/opensea'),
  setOpenSeaWallet: (key: string) => req<MaskedConfig['opensea']>('PUT', '/opensea/wallet', { key }),
  market: () => req<MarketStatus>('GET', '/market'),
  /** the tokens on this screen right now: the live pricer reads exactly these pools */
  setVisible: (client: string, addresses: string[]) => req<{ ok: true }>('PUT', '/market/visible', { client, addresses }),
  setAlchemyKey: (key: string) => req<MarketStatus>('PUT', '/market/alchemy', { key }),
  setMarketRpc: (chain: string, url: string) => req<MarketStatus>('PUT', '/market/rpc', { chain, url }),
  osQuote: (locator: string, quantity: number, chain?: string) => req<import('./types').MintJob>('POST', '/osmint/quote', { locator, quantity, chain }),
  osSend: (jobId: string) => req<{ ok: true }>('POST', '/osmint/send', { jobId }),
  osArm: (jobId: string, on: boolean) => req<import('./types').MintJob>('POST', '/osmint/arm', { jobId, on }),
  osDismiss: (jobId: string) => req<{ ok: true }>('DELETE', `/osmint/jobs/${encodeURIComponent(jobId)}`),
  // ---- plugins (routes in backend/src/plugins/api.ts)
  plugins: () => req<PluginInfo[]>('GET', '/plugins'),
  pluginsReload: () => req<PluginInfo[]>('POST', '/plugins/reload'),
  /** `replaced` says a plugin with that id was already in the folder and has just been overwritten */
  pluginAdd: (source: string) => req<PluginInfo & { replaced: boolean }>('POST', '/plugins/add', { source }),
  /**
   * 409 with `replaces` means a plugin of that id is already installed; ask, then call again passing
   * that id back as `replaces` — the backend refuses the second download if it no longer carries it.
   */
  pluginAddUrl: (url: string, replaces?: string) => req<PluginInfo & { replaced: boolean }>('POST', '/plugins/add-url', replaces ? { url, replace: true, replaces } : { url }),
  /** read a file's manifest without installing it, to say what is about to be added */
  pluginInspect: (source: string) => req<NonNullable<PluginInfo['manifest']>>('POST', '/plugins/inspect', { source }),
  /** the hash is the version the approval dialog showed: the backend refuses a file that changed since */
  pluginApprove: (id: string, hash?: string) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/approve`, hash ? { hash } : undefined),
  pluginEnable: (id: string) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/enable`),
  pluginDisable: (id: string) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/disable`),
  pluginRemove: (id: string) => req<{ ok: true }>('DELETE', `/plugins/${encodeURIComponent(id)}`),
  /** the module the sandbox imports: the exact approved bytes, and only while the plugin is enabled */
  pluginCode: (id: string) => text(`/plugins/${encodeURIComponent(id)}/code`),
  /** the same file for a person to read — any plugin the folder has, approved or not */
  pluginSource: (id: string) => text(`/plugins/${encodeURIComponent(id)}/source`),
  /** is the desktop shell connected? (what site sign-in needs) */
  pluginsShell: () => req<{ available: boolean }>('GET', '/plugins/shell'),
  pluginLogs: (id: string) => req<{ ts: number; level: PluginLogLevel; text: string }[]>('GET', `/plugins/${encodeURIComponent(id)}/logs`),
  pluginLog: (id: string, level: PluginLogLevel, text: string) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/log`, { level, text }),
  pluginPost: (id: string, post: unknown) => req<{ ok: true; id: string }>('POST', `/plugins/${encodeURIComponent(id)}/post`, post),
  pluginPatch: (id: string, msgId: string, patch: unknown) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/patch`, { ...(patch as object), id: msgId }),
  pluginStorage: (id: string) => req<Record<string, unknown>>('GET', `/plugins/${encodeURIComponent(id)}/storage`),
  pluginStorageSet: (id: string, key: string, value: unknown) => req<{ ok: true }>('PUT', `/plugins/${encodeURIComponent(id)}/storage/${encodeURIComponent(key)}`, { value }),
  /** the user's answers and the form the plugin last declared; the form outlives the plugin running */
  pluginSettings: (id: string) => req<{ values: Record<string, unknown>; schema: import('./plugins/route').SettingField[] }>('GET', `/plugins/${encodeURIComponent(id)}/settings`),
  pluginSchemaSet: (id: string, schema: import('./plugins/route').SettingField[]) => req<{ ok: true }>('PUT', `/plugins/${encodeURIComponent(id)}/schema`, { schema }),
  pluginSettingsSet: (id: string, values: Record<string, unknown>) => req<{ ok: true }>('PUT', `/plugins/${encodeURIComponent(id)}/settings`, { values }),
  pluginFetch: (id: string, url: string, init?: unknown) =>
    req<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>('POST', `/plugins/${encodeURIComponent(id)}/fetch`, { url, init }),
  pluginSites: (id: string) => req<{ sites: string[]; signedIn: string[]; available: boolean }>('GET', `/plugins/${encodeURIComponent(id)}/sites`),
  pluginSignIn: (id: string, site: string) => req<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/sites/signin`, { site }),
  /** switch a plugin chat on or off in the feed's watch list */
  pluginWatch: (key: string, on: boolean) => req<{ ok: true }>('PUT', '/plugins/watch', { key, on }),
};
