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
}
export interface DiscordChannel {
  id: string;
  name: string;
  guildName: string;
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
};
