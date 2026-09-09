/** Discord REST with the user token: channel history for previews (self-bot, same risk as the gateway). */
const API = 'https://discord.com/api/v10';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export async function fetchChannelHistory(
  token: string,
  channelId: string,
  limit = 50,
  fetchImpl: typeof fetch = fetch,
): Promise<any[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(`${API}/channels/${encodeURIComponent(channelId)}/messages?limit=${Math.min(100, limit)}`, {
      signal: ctl.signal,
      headers: { authorization: token, 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`discord history ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(t);
  }
}
