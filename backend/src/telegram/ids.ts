/**
 * Telegram hands the same chat back in several shapes. A supergroup/channel is
 * "-100<channelId>" (marked) or bare "<channelId>"; a basic group is "-<chatId>".
 * Channel ids are long (10+ digits), basic-group ids are short, so "-100" is only a
 * supergroup marker when what follows is long enough to be a channel id. That keeps a
 * basic group like "-1001" from being mangled into "1".
 */
const MIN_CHANNEL_DIGITS = 9;

export function canonicalChatId(id: string | number | bigint | undefined | null): string {
  let s = String(id ?? '').trim();
  if (!s) return '';
  if (s.startsWith('-')) s = s.slice(1);
  if (s.startsWith('100') && s.length >= 3 + MIN_CHANNEL_DIGITS) s = s.slice(3);
  return s;
}

export function sameChat(a: string | number | bigint | undefined | null, b: string | number | bigint | undefined | null): boolean {
  const x = canonicalChatId(a);
  return x !== '' && x === canonicalChatId(b);
}

/** Is this chat on a watch list, in any of its shapes? */
export function isWatched(watch: readonly string[], id: string | number | bigint | undefined | null): boolean {
  const c = canonicalChatId(id);
  return c !== '' && watch.some((w) => canonicalChatId(w) === c);
}
