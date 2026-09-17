import type { FeedMessage, MediaItem } from '../types.js';
import type { PluginManifest } from './manifest.js';
import { isLocalHost } from './hosts.js';

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
export const POSTS_PER_WINDOW = 60;
export const POST_WINDOW_MS = 60_000;
const ID_MAX = 120;
const CHAT_NAME_MAX = 60;
const AUTHOR_MAX = 60;
const URL_MAX = 2048;
const ATTACHMENTS_MAX = 8;
/** how far ahead of the clock a plugin's own timestamp may sit before we use ours instead */
const FUTURE_MAX = 60_000;

/**
 * Characters that never belong in a name the UI shows: C0/C1 controls, the bidi overrides and
 * isolates, the LRM/RLM marks and the BOM. Deliberately NOT all of `\p{Cf}`: ZWNJ (U+200C) and
 * ZWJ (U+200D) are how Persian names and emoji sequences are written, so they stay.
 */
const STRIP_RE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** Drops the characters above, collapses whitespace, and trims/truncates. For names, not bodies. */
const clean = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** An id is a dedupe key, so its inner spacing is left exactly as the plugin wrote it. */
const cleanId = (v: unknown): string => String(v ?? '').replace(STRIP_RE, '').trim().slice(0, ID_MAX);

/** Text keeps its line breaks and tabs (the UI renders them); the rest of the set above becomes a space. */
const cleanText = (v: unknown): string =>
  String(v ?? '')
    .replace(STRIP_RE, (c) => (c === '\n' || c === '\t' ? c : ' '))
    .slice(0, TEXT_MAX);

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

/** The origins of the plugin's declared sites; a site that will not parse allows nothing. */
function siteOrigins(manifest: PluginManifest): Set<string> {
  const out = new Set<string>();
  for (const s of manifest.sites ?? []) {
    try {
      out.add(new URL(String(s)).origin);
    } catch {
      /* not an origin, so not an allowed one */
    }
  }
  return out;
}

const parsed = (u: string): URL | undefined => {
  try {
    return new URL(u);
  } catch {
    return undefined;
  }
};

/**
 * Media the renderer loads on its own (avatars, attachments): https, and only from an origin the plugin
 * declared in `sites`. Anywhere else the URL itself would be the message — a beacon telling a server of
 * the plugin author's choosing what the user is looking at, with no click to gate it.
 */
const mediaUrl = (u: unknown, what: string, origins: Set<string>): string | undefined => {
  if (u === undefined || u === null || u === '') return undefined;
  const s = String(u).trim();
  if (!s) return undefined;
  const url = s.length <= URL_MAX ? parsed(s) : undefined;
  if (!url || url.protocol !== 'https:' || !origins.has(url.origin)) throw new Error(`${what} must be https on one of the plugin's sites`);
  return s;
};

/** `link` is click-gated, so it may be any http(s) address — except one on the user's own machine or LAN. */
const linkUrl = (u: unknown): string | undefined => {
  if (u === undefined || u === null || u === '') return undefined;
  const s = String(u).trim();
  if (!s) return undefined;
  const url = s.length <= URL_MAX ? parsed(s) : undefined;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('link must be an http(s) URL');
  if (isLocalHost(url.hostname)) throw new Error('link must not point at a local address');
  return s;
};

/** Turns one `ot.feed.post` call into a feed message, or throws with a message the plugin author can act on. */
export function toFeedMessage(pluginId: string, manifest: PluginManifest, p: PluginPost): FeedMessage {
  const id = cleanId(p.id);
  if (!id) throw new Error('post needs an id');
  const chat = clean(p.chat, CHAT_NAME_MAX);
  if (!chat) throw new Error('post needs a chat name');

  const origins = siteOrigins(manifest);
  const author = clean(p.author, AUTHOR_MAX) || manifest.name;
  const text = cleanText(p.text);
  const avatar = mediaUrl(p.avatar, 'avatar', origins);
  const link = linkUrl(p.link);

  if (p.attachments !== undefined && !Array.isArray(p.attachments)) throw new Error('attachments must be an array');
  const media: MediaItem[] = [];
  for (const a of (p.attachments ?? []).slice(0, ATTACHMENTS_MAX)) {
    const url = mediaUrl(a?.url, 'attachment url', origins);
    if (!url) throw new Error("attachment url must be https on one of the plugin's sites");
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

  /** Forgets a plugin's history: it was removed, disabled, or reinstalled. */
  forget(pluginId: string): void {
    this.hits.delete(pluginId);
  }
}
