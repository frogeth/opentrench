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

export interface MaskedConfig {
  discord: { hasToken: boolean; watch: string[] };
  telegram: { apiId: number | null; hasApiHash: boolean; hasSession: boolean; watch: string[] };
  cove: { amounts: number[] };
  blacklist: string[];
  favorites: string[];
  pingTelegram: boolean;
  hasO1Key: boolean;
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
  favoriteToggle: (name: string) => req<{ favorite: boolean }>('POST', '/favorites/toggle', { name }),
  setFavorites: (names: string[]) => req('PUT', '/favorites', { names }),
  setPings: (telegram: boolean) => req('PUT', '/pings', { telegram }),
  setO1Key: (apiKey: string) => req('PUT', '/o1', { apiKey }),
  watched: () => req<WatchedChat[]>('GET', '/watched'),
};
