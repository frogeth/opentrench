/** Discord REST with the user token: channel history for previews (self-bot, same risk as the gateway). */
const API = 'https://discord.com/api/v10';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Post a message as the user (self-bot: this is the riskier half of the ToS problem; gated in the API). */
export async function sendChannelMessage(
  token: string,
  channelId: string,
  content: string,
  replyToId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const body: Record<string, unknown> = { content, nonce: Date.now().toString(), tts: false, flags: 0 };
    if (replyToId) body.message_reference = { channel_id: channelId, message_id: replyToId };
    const res = await fetchImpl(`${API}/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { authorization: token, 'user-agent': USER_AGENT, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`discord send ${res.status}${txt ? `: ${txt.slice(0, 160)}` : ''}`);
    }
    const json: any = await res.json();
    return { id: String(json?.id ?? '') };
  } finally {
    clearTimeout(t);
  }
}

/** Add or remove the user's reaction. `emoji` is the unicode emoji, or `name:id` for a custom one. */
export async function reactMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
  on: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(`${API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: on ? 'PUT' : 'DELETE',
      signal: ctl.signal,
      headers: { authorization: token, 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!res.ok && res.status !== 204) throw new Error(`discord react ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

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
