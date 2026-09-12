async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
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
export interface ColumnDef {
  id: string;
  type: 'calls' | 'chat' | 'callers' | 'cove' | 'salpha' | 'j7' | 'web' | 'mints' | 'nftvol' | 'osmint';
  title: string;
  /** `<source>:<id>` keys of watched chats; empty = all */
  chats: string[];
  /** web columns: the page to embed */
  url?: string;
  /** nftvol: which OpenSea list, and which rolling window */
  ranking?: 'trending' | 'top';
  timeframe?: '1h' | '1d';
  /** a second column stacked under this one (one level only), sharing its width */
  split?: { bottom: ColumnDef; ratio?: number };
  /** fixed width in px (drag-resized); unset = share the space */
  width?: number;
  /** callers leaderboard window */
  window?: '24h' | '7d' | '30d';
  /** play a sound when a new call lands in this column */
  alert?: { on: boolean; sound: string };
  filters?: ColumnFilters;
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
  railOrder: string[];
  columns: ColumnDef[];
  seenTokens: string[];
  opensea: { hasWallet: boolean; walletAddress?: string; rpc: Record<string, string>; chains?: { id: string; name: string; defaultRpc: string; symbol: string }[] };
}
export interface WatchedChat {
  id: string;
  name: string;
  source: 'discord' | 'telegram';
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
export interface TelegramDialog {
  id: string;
  title: string;
  type: 'group' | 'channel' | 'dm';
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
  send: (source: 'discord' | 'telegram', chatId: string, text: string, replyTo?: string) => req<{ ok: true }>('POST', '/send', { source, chatId, text, replyTo }),
  setJ7Token: (token: string) => req<{ hasToken: boolean }>('PUT', '/j7/token', { token }),
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
  setDiscordToken: (token: string) => req<{ hasToken: boolean }>('PUT', '/discord/token', { token }),
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
  botPress: (bot: string, msgId: number, data: string) => req<{ message?: string; alert?: boolean; url?: string; gone?: boolean }>('POST', `/bot/${encodeURIComponent(bot)}/press`, { msgId, data }),
  react: (source: 'discord' | 'telegram', chatId: string, msgId: string, key: string, name: string, on: boolean) =>
    req<{ ok: true }>('POST', '/react', { source, chatId, msgId, key, name, on }),
  markSeen: (add: string[], remove: string[] = []) => req<{ count: number }>('POST', '/seen', { add, remove }),
  setColumns: (columns: ColumnDef[]) => req<ColumnDef[]>('PUT', '/columns', { columns }),
  watched: () => req<WatchedChat[]>('GET', '/watched'),
  tickers: () => req<{ sym: string; usd: number; change24h: number }[]>('GET', '/tickers'),
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
  setOpenSeaRpc: (chain: string, url: string) => req<MaskedConfig['opensea']>('PUT', '/opensea/rpc', { chain, url }),
  osQuote: (locator: string, quantity: number, chain?: string) => req<import('./types').MintJob>('POST', '/osmint/quote', { locator, quantity, chain }),
  osSend: (jobId: string) => req<{ ok: true }>('POST', '/osmint/send', { jobId }),
};
