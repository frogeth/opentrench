import type { FeedMessage } from '../types.js';

export interface DiscordChannelInfo {
  name: string;
  guildName: string;
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
    author: d.member?.nick ?? d.author?.global_name ?? d.author?.username ?? 'unknown',
    avatar: avatarUrl(d),
    isBot: !!d.author?.bot,
    text: parts.filter(Boolean).join('\n'),
    ts: Date.parse(d.timestamp) || Date.now(),
    contracts: [],
    repeat: false,
    link: d.guild_id ? `https://discord.com/channels/${d.guild_id}/${d.channel_id}/${d.id}` : undefined,
    hasAttachment: (d.attachments?.length ?? 0) > 0,
  };
}
