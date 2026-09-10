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
}
export interface BotSeen {
  name: string;
  avatar?: string;
  source: 'discord' | 'telegram';
  count: number;
  lastTs: number;
  chats: string[];
  hidden: boolean;
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
export interface MaskedConfig {
  discord: { hasToken: boolean; watch: string[] };
  telegram: { apiId: number | null; hasApiHash: boolean; hasSession: boolean; watch: string[] };
  cove: { amounts: number[] };
  blacklist: string[];
  bots: BotPolicy;
  favorites: string[];
  pingTelegram: boolean;
  hasO1Key: boolean;
  railOrder: string[];
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
}
export interface TelegramDialog {
  id: string;
  title: string;
  type: 'group' | 'channel';
}

export const api = {
  config: () => req<MaskedConfig>('GET', '/config'),
  setDiscordToken: (token: string) => req('PUT', '/discord/token', { token }),
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
  watched: () => req<WatchedChat[]>('GET', '/watched'),
  ohlcv: (address: string, interval: string) =>
    req<{ candles: { t: number; o: number; h: number; l: number; c: number; v: number }[]; mcPerPrice?: number; reason?: string }>(
      'GET',
      `/token/${encodeURIComponent(address)}/ohlcv?interval=${interval}`,
    ),
  sitePreview: (url: string) => req<SitePreview | null>('GET', `/site-preview?url=${encodeURIComponent(url)}`),
  xProfile: (handle: string) => req<XProfile | null>('GET', `/x-profile/${encodeURIComponent(handle)}`),
  preview: (source: 'discord' | 'telegram', id: string) =>
    req<import('./types').FeedMessage[]>('GET', `/preview/${source}/${encodeURIComponent(id)}`),
};
