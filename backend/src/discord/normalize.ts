import type { FeedMessage } from '../types.js';

export interface DiscordChannelInfo {
  name: string;
  guildName: string;
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
    text: parts.filter(Boolean).join('\n'),
    ts: Date.parse(d.timestamp) || Date.now(),
    contracts: [],
    link: d.guild_id ? `https://discord.com/channels/${d.guild_id}/${d.channel_id}/${d.id}` : undefined,
    hasAttachment: (d.attachments?.length ?? 0) > 0,
  };
}
