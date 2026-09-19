import type { WatchedChat } from './api';
import type { FeedMessage, Source } from './types';

/** The sources the app can post, react and reply on: the platforms it is signed in to. Plugin and Vampy chats are read-only copies. */
export const canWrite = (s: Source): s is 'discord' | 'telegram' => s === 'discord' || s === 'telegram';

/** Telegram chat id in one shape: strip '-', then a '100' supergroup marker only when a real (long) channel id follows. */
export const normTg = (id: string) => {
  let s = id.startsWith('-') ? id.slice(1) : id;
  if (s.startsWith('100') && s.length >= 12) s = s.slice(3);
  return s;
};

/**
 * The watch-list key a message answers to: `<source>:<id>` for the platforms, `vampy:<feed>` for a
 * Vampy feed, and for a plugin the chat id itself — that already is the whole key, `plugin:<plugin>:<chat>`.
 */
export const watchKeyOf = (m: Pick<FeedMessage, 'source' | 'chatId'>): string =>
  m.source === 'plugin' ? m.chatId : m.source === 'vampy' ? `vampy:${m.chatId}` : m.source === 'telegram' ? `telegram:${normTg(m.chatId)}` : `discord:${m.chatId}`;

/** The names the platforms have taken, for `displayChatName`; build it once per list, not per chat. */
export const platformChatNames = (all: WatchedChat[]): Set<string> => new Set(all.filter((w) => w.source !== 'plugin').map((w) => w.name));

/**
 * What a chat is *called on screen*. Views are still scoped by the raw chat name, so this is a
 * label and never an identity: a plugin chat sharing a platform chat's name reads as
 * "<name> (plugin)" so the two are told apart on sight. The proper fix is keying views by chatKey.
 */
export const displayChatName = (w: WatchedChat, platformNames: Set<string>): string =>
  w.source === 'plugin' && platformNames.has(w.name) ? `${w.name} (plugin)` : w.name;
