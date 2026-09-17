import type { WatchedChat } from './api';
import type { FeedMessage } from './types';

/** Telegram chat id in one shape: strip '-', then a '100' supergroup marker only when a real (long) channel id follows. */
export const normTg = (id: string) => {
  let s = id.startsWith('-') ? id.slice(1) : id;
  if (s.startsWith('100') && s.length >= 12) s = s.slice(3);
  return s;
};

/**
 * The watch-list key a message answers to: `<source>:<id>` for the platforms, and for a plugin the
 * chat id itself — that already is the whole key, `plugin:<plugin>:<chat>`.
 */
export const watchKeyOf = (m: Pick<FeedMessage, 'source' | 'chatId'>): string =>
  m.source === 'plugin' ? m.chatId : m.source === 'telegram' ? `telegram:${normTg(m.chatId)}` : `discord:${m.chatId}`;

/**
 * What a chat is called on screen. Views are scoped by chat *name*, so a plugin chat that happens
 * to share a platform chat's name would answer for it: show that one as "<name> (plugin)" instead.
 * The proper fix is keying views by chatKey rather than by name.
 */
export const displayChatName = (w: WatchedChat, all: WatchedChat[]): string =>
  w.source === 'plugin' && all.some((o) => o.source !== 'plugin' && o.name === w.name) ? `${w.name} (plugin)` : w.name;
