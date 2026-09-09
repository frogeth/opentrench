import type { FeedMessage, LinkPreview, MediaItem, Reaction, ReplyContext } from '../types.js';

export interface DiscordChannelInfo {
  name: string;
  guildName: string;
  guildIcon?: string;
}

const MEDIA_URL_RE = /https?:\/\/[^\s<>()]+?\.(?:gif|png|jpe?g|webp)(?:\?[^\s<>()]*)?/gi;
const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\/\w{1,20}\/status\/\d{1,25}/i;

function kindForUrl(url: string, contentType = ''): MediaItem['kind'] {
  const clean = url.split('?')[0].toLowerCase();
  if (contentType.startsWith('image/gif') || clean.endsWith('.gif')) return 'gif';
  if (contentType.startsWith('video/') || /\.(mp4|webm|mov)$/.test(clean)) return 'video';
  return 'image';
}

/** Attachments, gif/image embeds, stickers and bare image links. */
export function discordMedia(d: any): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  const add = (m: MediaItem) => {
    const k = m.url.split('?')[0];
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  for (const a of d.attachments ?? []) {
    const ct = String(a.content_type ?? '');
    const url = String(a.proxy_url ?? a.url ?? '');
    if (!url) continue;
    if (ct.startsWith('image/') || ct.startsWith('video/') || /\.(gif|png|jpe?g|webp|mp4|webm|mov)$/i.test(url.split('?')[0]))
      add({ kind: kindForUrl(url, ct), url, ...(ct ? { mime: ct.split(';')[0] } : {}) });
  }
  for (const e of d.embeds ?? []) {
    if (e.type === 'gifv' && (e.video?.proxy_url || e.video?.url)) {
      add({ kind: 'gif', url: String(e.video.proxy_url ?? e.video.url), poster: e.thumbnail?.proxy_url ?? e.thumbnail?.url });
    } else if (e.type === 'image' && (e.thumbnail?.proxy_url || e.thumbnail?.url)) {
      const url = String(e.thumbnail.proxy_url ?? e.thumbnail.url);
      add({ kind: kindForUrl(url), url });
    }
  }
  for (const s of d.sticker_items ?? []) {
    if (s.format_type === 3) continue; // lottie: no static render
    const ext = s.format_type === 4 ? 'gif' : 'png';
    add({ kind: 'sticker', url: `https://media.discordapp.net/stickers/${s.id}.${ext}?size=160` });
  }
  for (const m of String(d.content ?? '').matchAll(MEDIA_URL_RE)) add({ kind: kindForUrl(m[0]), url: m[0] });
  return out;
}

/** Discord's own unfurl of a tweet, when it already came with the message. */
export function discordPreviews(d: any): LinkPreview[] {
  const out: LinkPreview[] = [];
  for (const e of d.embeds ?? []) {
    const url = String(e.url ?? '');
    if (!TWEET_URL_RE.test(url) || !e.description) continue;
    const m = /^(.*?)\s*\(@([A-Za-z0-9_]+)\)\s*$/.exec(String(e.author?.name ?? ''));
    out.push({
      url,
      site: 'x',
      author: m ? m[1] : e.author?.name ? String(e.author.name) : undefined,
      handle: m ? m[2] : undefined,
      text: String(e.description),
      image: e.image?.proxy_url ?? e.image?.url ?? e.thumbnail?.proxy_url ?? e.thumbnail?.url ?? undefined,
      avatar: e.author?.proxy_icon_url ?? e.author?.icon_url ?? undefined,
    });
  }
  return out;
}

const CDN = 'https://cdn.discordapp.com';

function avatarUrl(d: any): string | undefined {
  const uid = d.author?.id;
  if (!uid) return undefined;
  if (d.guild_id && d.member?.avatar) return `${CDN}/guilds/${d.guild_id}/users/${uid}/avatars/${d.member.avatar}.png?size=64`;
  if (d.author?.avatar) return `${CDN}/avatars/${uid}/${d.author.avatar}.png?size=64`;
  try {
    return `${CDN}/embed/avatars/${Number((BigInt(uid) >> 22n) % 6n)}.png`;
  } catch {
    return undefined;
  }
}

function authorName(a: any, member?: any): string {
  return member?.nick ?? a?.global_name ?? a?.username ?? 'unknown';
}

function replyContext(d: any): ReplyContext | undefined {
  const r = d.referenced_message;
  if (!r) return undefined;
  const text = String(r.content ?? '').trim() || (r.attachments?.length ? '📎 attachment' : r.embeds?.length ? '(embed)' : '');
  return { author: authorName(r.author, r.member), text };
}

/** Map a gateway emoji object to our reaction identity (no count). */
export function discordReaction(emoji: any): Omit<Reaction, 'count'> {
  if (emoji?.id) {
    return {
      key: `custom:${emoji.id}`,
      name: String(emoji.name ?? 'emoji'),
      imageUrl: `${CDN}/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}?size=32`,
    };
  }
  const name = String(emoji?.name ?? '?');
  return { key: name, name };
}

export function normalizeDiscord(d: any, ch: DiscordChannelInfo): FeedMessage {
  const parts: string[] = [d.content ?? ''];
  for (const e of d.embeds ?? []) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields ?? []) if (f.value) parts.push(f.value);
  }
  return {
    id: `discord:${d.id}`,
    source: 'discord',
    chatId: String(d.channel_id),
    chatName: `#${ch.name} (${ch.guildName})`,
    author: authorName(d.author, d.member),
    avatar: avatarUrl(d),
    // Webhooks carry bot:true too, but a webhook channel *is* the feed (alert bots, scanners
    // posting for people). Only real bot users (Rick etc.) are hidden; blacklist the rest.
    isBot: !!d.author?.bot && !d.webhook_id,
    text: parts.filter(Boolean).join('\n'),
    ts: Date.parse(d.timestamp) || Date.now(),
    contracts: [],
    repeat: false,
    link: d.guild_id ? `https://discord.com/channels/${d.guild_id}/${d.channel_id}/${d.id}` : undefined,
    hasAttachment: (d.attachments?.length ?? 0) > 0,
    replyTo: replyContext(d),
    chatAvatar: ch.guildIcon,
    media: discordMedia(d),
    previews: discordPreviews(d),
  };
}
