import type { FeedMessage } from '../types.js';

export interface TelegramPlain {
  id: number;
  chatId: string;
  chatTitle: string;
  chatUsername?: string;
  senderName: string;
  text: string;
  date: number; // unix seconds
  hasMedia: boolean;
}

export function normalizeTelegram(p: TelegramPlain): FeedMessage {
  return {
    id: `telegram:${p.chatId}:${p.id}`,
    source: 'telegram',
    chatId: p.chatId,
    chatName: p.chatTitle,
    author: p.senderName,
    text: p.text,
    ts: p.date * 1000,
    contracts: [],
    link: p.chatUsername ? `https://t.me/${p.chatUsername}/${p.id}` : undefined,
    hasAttachment: p.hasMedia,
  };
}
