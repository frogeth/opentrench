/**
 * What a Discord / Telegram / bot link points at, so the app can open it in-app instead of
 * handing it to the browser. Anything else (X, charts, explorers, invites) returns null.
 */
export type ChatLink =
  | { kind: 'bot'; bot: string; start?: string }
  | { kind: 'telegram'; internal?: string; username?: string; msgId?: string }
  | { kind: 'discord'; guild: string; channel: string; msgId?: string };

const TG_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'telegram.dog']);
const DISCORD_RE = /^(?:www\.|ptb\.|canary\.)?(?:discord\.com|discordapp\.com)$/i;

export function parseChatLink(href: string): ChatLink | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === 'tg:') {
    // tg://resolve?domain=<user>&start=<payload>, tg://resolve?domain=<user>&post=<id>
    const domain = u.searchParams.get('domain');
    if (!domain) return null;
    const start = u.searchParams.get('start') ?? u.searchParams.get('startapp');
    if (start || /bot$/i.test(domain)) return { kind: 'bot', bot: domain, start: start ?? undefined };
    const post = u.searchParams.get('post') ?? '';
    return { kind: 'telegram', username: domain, msgId: /^\d+$/.test(post) ? post : undefined };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (TG_HOSTS.has(host)) {
    if (parts.length === 0) return null;
    if (parts[0] === 'c' && /^\d+$/.test(parts[1] ?? '')) {
      // t.me/c/<internal id>/<msg> or t.me/c/<internal id>/<topic>/<msg>
      const last = parts[parts.length - 1];
      const msgId = parts.length >= 3 && /^\d+$/.test(last) ? last : undefined;
      return { kind: 'telegram', internal: parts[1], msgId };
    }
    if (parts[0] === 's' && parts[1]) parts.shift(); // t.me/s/<channel> (web preview) is the channel
    const user = parts[0];
    if (!/^[A-Za-z0-9_]{3,32}$/.test(user) || user === 'joinchat' || user === 'addstickers' || user === 'proxy' || user === 'share' || user === 'iv') return null;
    const start = u.searchParams.get('start') ?? u.searchParams.get('startapp');
    if (start || /bot$/i.test(user)) return { kind: 'bot', bot: user, start: start ?? undefined };
    const last = parts[parts.length - 1];
    const msgId = parts.length >= 2 && /^\d+$/.test(last) ? last : undefined;
    return { kind: 'telegram', username: user, msgId };
  }
  if (DISCORD_RE.test(host) && parts[0] === 'channels' && parts[1] && parts[2]) {
    const msg = parts[3];
    // ids are 64-bit snowflakes: keep them as strings (a Number would lose the low digits)
    return { kind: 'discord', guild: parts[1], channel: parts[2], msgId: msg && /^\d+$/.test(msg) ? msg : undefined };
  }
  return null;
}
