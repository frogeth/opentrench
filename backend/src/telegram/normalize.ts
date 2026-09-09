import type { FeedMessage, LinkPreview, MediaItem, Reaction, ReplyContext } from '../types.js';

export interface TelegramPlain {
  id: number;
  chatId: string;
  chatTitle: string;
  chatUsername?: string;
  senderId?: string;
  senderName: string;
  isBot: boolean;
  text: string;
  date: number; // unix seconds
  hasMedia: boolean;
  replyTo?: ReplyContext;
  reactions?: Reaction[];
  media?: MediaItem[];
  previews?: LinkPreview[];
}

/** Map Telegram MessageReactions.results to our shape. Custom emoji have no cheap image; show a star. */
export function mapTelegramReactions(results: any[] | undefined): Reaction[] {
  const out: Reaction[] = [];
  for (const r of results ?? []) {
    const count = Number(r?.count ?? 0);
    if (!count) continue;
    const re = r.reaction;
    if (re?.emoticon) out.push({ key: String(re.emoticon), name: String(re.emoticon), count });
    else if (re?.documentId !== undefined) out.push({ key: `custom:${String(re.documentId)}`, name: '★', count });
  }
  return out;
}

export function normalizeTelegram(p: TelegramPlain): FeedMessage {
  return {
    id: `telegram:${p.chatId}:${p.id}`,
    source: 'telegram',
    chatId: p.chatId,
    chatName: p.chatTitle,
    author: p.senderName,
    avatar: p.senderId ? `/api/telegram/avatar/${p.senderId}` : undefined,
    isBot: p.isBot,
    text: p.text,
    ts: p.date * 1000,
    contracts: [],
    repeat: false,
    link: p.chatUsername ? `https://t.me/${p.chatUsername}/${p.id}` : undefined,
    hasAttachment: p.hasMedia,
    replyTo: p.replyTo,
    reactions: p.reactions,
    chatAvatar: `/api/telegram/avatar/${p.chatId}`,
    media: p.media ?? [],
    previews: p.previews ?? [],
  };
}
