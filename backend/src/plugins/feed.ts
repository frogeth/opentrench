import type { FeedMessage, MediaItem } from '../types.js';
import type { PluginManifest } from './manifest.js';

/** What a plugin hands to `ot.feed.post`. */
export interface PluginPost {
  /** the plugin's own stable id for this item (dedupe) */
  id: string;
  /** the chat this belongs to, as the plugin names it; one plugin can post several chats */
  chat: string;
  author?: string;
  text?: string;
  ts?: number;
  avatar?: string;
  link?: string;
  attachments?: { url: string; kind?: 'image' | 'video' }[];
}

export const TEXT_MAX = 4000;
export const CHAT_SLUG_MAX = 40;
const ID_MAX = 120;
const CHAT_NAME_MAX = 60;
const AUTHOR_MAX = 60;
const URL_MAX = 2048;
const ATTACHMENTS_MAX = 8;
/** how far ahead of the clock a plugin's own timestamp may sit before we use ours instead */
const FUTURE_MAX = 60_000;

/** Removes control (Cc) and format (Cf) characters, collapses whitespace, and trims/truncates. */
const clean = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * The chat segment of a plugin chat key: lowercase a-z0-9 and dashes, max 40, never empty.
 * config.ts's key regexes mirror this, so every id this builds is a key the config will keep.
 */
export function chatSlug(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CHAT_SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'chat';
}

/** The feed's chat id for one of a plugin's chats: `plugin:<plugin id>:<chat slug>`. */
export function chatIdFor(pluginId: string, chat: string): string {
  return `plugin:${pluginId}:${chatSlug(chat)}`;
}

/** Accepts http(s) URLs only (so no `javascript:`, `data:` or file paths reach the UI); '' and undefined mean "not set". */
const httpUrl = (u: unknown, what: string): string | undefined => {
  if (u === undefined || u === null || u === '') return undefined;
  const s = String(u).trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s) || s.length > URL_MAX) throw new Error(`${what} must be an http(s) URL`);
  return s;
};

/** Text keeps its line breaks and tabs (the UI renders them); every other control/format char becomes a space. */
const cleanText = (v: unknown): string =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ' '))
    .slice(0, TEXT_MAX);

/** Turns one `ot.feed.post` call into a feed message, or throws with a message the plugin author can act on. */
export function toFeedMessage(pluginId: string, manifest: PluginManifest, p: PluginPost): FeedMessage {
  const id = clean(p.id, ID_MAX);
  if (!id) throw new Error('post needs an id');
  const chat = clean(p.chat, CHAT_NAME_MAX);
  if (!chat) throw new Error('post needs a chat name');

  const author = clean(p.author, AUTHOR_MAX) || manifest.name;
  const text = cleanText(p.text);
  const avatar = httpUrl(p.avatar, 'avatar');
  const link = httpUrl(p.link, 'link');

  const media: MediaItem[] = [];
  for (const a of (p.attachments ?? []).slice(0, ATTACHMENTS_MAX)) {
    const url = httpUrl(a?.url, 'attachment url');
    if (!url) throw new Error('attachment url must be an http(s) URL');
    const kind = a?.kind === 'video' ? 'video' : 'image';
    media.push({ kind, url, mime: kind === 'video' ? 'video/mp4' : 'image/*' });
  }
  if (!text.trim() && !media.length) throw new Error('post needs text or an attachment');

  const given = Number(p.ts);
  const ts = Number.isFinite(given) && given > 0 ? Math.min(Math.round(given), Date.now() + FUTURE_MAX) : Date.now();

  const chatId = chatIdFor(pluginId, chat);
  return {
    id: `${chatId}:${id}`,
    source: 'plugin',
    chatId,
    chatName: chat,
    author,
    avatar,
    isBot: false,
    hidden: false,
    text,
    ts,
    contracts: [],
    repeat: false,
    link,
    hasAttachment: media.length > 0,
    media: media.length ? media : undefined,
  };
}

/** A sliding window of post times per plugin: at most `max` posts in any `windowMs`. */
export class PostLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a post and says whether it is allowed; a refused post is not recorded. */
  take(pluginId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(pluginId) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.max) {
      this.hits.set(pluginId, times);
      return false;
    }
    times.push(now);
    this.hits.set(pluginId, times);
    return true;
  }
}
