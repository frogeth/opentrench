import type { FeedMessage, ReplyContext } from '../types.js';
import { discordEmbeds, discordMedia, discordPreviews } from '../discord/normalize.js';
import type { ExtractedMeta } from '../links.js';
import { cleanText } from '../plugins/feed.js';
import { VAMPY_FEED_ID_RE } from '../config.js';

/**
 * Vampy (vampy.app) rows → feed messages. A feed the user built there is one chat here; a call row
 * becomes a message whose text carries the contract, so the hub registers it as a call like any
 * other. Every field is optional on the wire (omitted, never null), so every read is defensive.
 */

/** A feed as GET /feeds lists it, trimmed to what the app uses. */
export interface VampyFeed {
  id: string;
  title: string;
  type: 'call' | 'message';
  /** the Discord / Telegram channels it is built from; empty on a message feed = every channel the user can read */
  channels: { channelId: string; serverId?: string; channelName?: string; serverName?: string }[];
}

/** One feed row turned into the feed's message, with what the hub needs beside it. */
export interface VampyRow {
  msg: FeedMessage;
  /** name, symbol and socials the payload carried (calls) */
  meta?: ExtractedMeta;
  /** the market cap Vampy recorded at the call */
  marketCap?: number;
  /** read back from the feed's past (boot, a reconnect), not a live event */
  history?: true;
}

const TITLE_MAX = 60;
const AUTHOR_MAX = 80;
const SYMBOL_MAX = 20;
const URL_MAX = 2048;
/** characters that never belong in a name the UI shows (controls, bidi overrides, marks, BOM) */
const STRIP_RE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  return s || undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** a name: controls out, whitespace collapsed, bounded */
const name = (v: unknown, max: number): string => String(v ?? '').replace(STRIP_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const httpUrl = (v: unknown, httpsOnly = false): string | undefined => {
  const s = str(v);
  if (!s || s.length > URL_MAX) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:') ? s : undefined;
  } catch {
    return undefined;
  }
};
/** the first timestamp that parses: ISO 8601, unix seconds or ms */
const when = (...vals: unknown[]): number => {
  for (const v of vals) {
    if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v;
    const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
};
/** an array as delivered, or one serialized as a JSON string */
const list = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};
/** an object as delivered, or one serialized as a JSON string */
const obj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
};
const SNOWFLAKE = /^\d{1,30}$/;
/** a platform id as the API relays it: digits (Telegram chats may carry a sign), bounded */
const PLATFORM_ID = /^-?[A-Za-z0-9_]{1,40}$/;
const idOf = (v: unknown): string | undefined => {
  const s = str(v);
  return s && PLATFORM_ID.test(s) ? s : undefined;
};

/** The attachment fields the Discord normalizer reads, with only https urls left in. */
const safeAttachments = (v: unknown): any[] =>
  list(v)
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const url = httpUrl(a.proxy_url ?? a.url, true);
      return url ? { url, content_type: typeof a.content_type === 'string' ? a.content_type.slice(0, 100) : undefined } : undefined;
    })
    .filter(Boolean);

/** An embed as the Discord normalizer reads it, every url field checked (https only), the rest passed as strings. */
const safeEmbeds = (v: unknown): any[] =>
  list(v)
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const media = (m: unknown) => {
        const url = m && typeof m === 'object' ? httpUrl((m as any).proxy_url ?? (m as any).url, true) : undefined;
        return url ? { url } : undefined;
      };
      const author =
        e.author && typeof e.author === 'object'
          ? { name: str(e.author.name), url: httpUrl(e.author.url), icon_url: httpUrl(e.author.proxy_icon_url ?? e.author.icon_url, true) }
          : undefined;
      return {
        type: str(e.type),
        title: str(e.title),
        url: httpUrl(e.url),
        description: str(e.description),
        color: typeof e.color === 'number' ? e.color : undefined,
        author,
        fields: list(e.fields).map((f) => ({ name: str(f?.name), value: str(f?.value), inline: !!f?.inline })),
        thumbnail: media(e.thumbnail),
        image: media(e.image),
        video: media(e.video),
        footer: e.footer && typeof e.footer === 'object' ? { text: str(e.footer.text) } : undefined,
        timestamp: str(e.timestamp),
      };
    });

/** What a feed is called in the app: its Vampy title, marked the way a Discord channel carries its server. */
export function chatNameOf(feed: Pick<VampyFeed, 'title'>): string {
  return `${feed.title} (Vampy)`;
}

/** The realtime channel a feed's events arrive on. */
export function channelFor(userId: string, feedId: string): string {
  return `private-user-${userId}-feed-${feedId}`;
}

/** The feeds in a GET /feeds answer (`{ data: [...] }` or a bare list); malformed entries are skipped. */
export function parseFeeds(raw: unknown): VampyFeed[] {
  const rows = Array.isArray(raw) ? raw : list((raw as any)?.data);
  const out: VampyFeed[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const id = str(r.id);
    if (!id || !VAMPY_FEED_ID_RE.test(id) || seen.has(id)) continue;
    const type = r.type === 'call' || r.type === 'message' ? r.type : undefined;
    if (!type) continue;
    seen.add(id);
    const channels = list(r.channels)
      .map((c) => ({ channelId: str(c?.channel_external_id) ?? '', serverId: str(c?.server_external_id), channelName: str(c?.channel_name), serverName: str(c?.server_name) }))
      .filter((c) => c.channelId)
      .map((c) => ({ channelId: c.channelId, ...(c.serverId ? { serverId: c.serverId } : {}), ...(c.channelName ? { channelName: c.channelName } : {}), ...(c.serverName ? { serverName: c.serverName } : {}) }));
    out.push({ id, title: name(r.title, TITLE_MAX) || (type === 'call' ? 'Vampy calls' : 'Vampy messages'), type, channels });
  }
  return out;
}

/** The original message on its platform: Discord's channel/message link, or a t.me/c link for a Telegram channel. */
export function feedLink(platform: unknown, server: unknown, channel: unknown, message: unknown): string | undefined {
  const ch = str(channel);
  const msg = str(message);
  if (!ch || !msg || !SNOWFLAKE.test(msg)) return undefined;
  if (platform === 'discord') {
    if (!SNOWFLAKE.test(ch)) return undefined;
    const sv = str(server);
    return `https://discord.com/channels/${sv && SNOWFLAKE.test(sv) ? sv : '@me'}/${ch}/${msg}`;
  }
  if (platform === 'telegram') {
    // channels and supergroups arrive as -100<id>, -<id> or a bare id; t.me/c wants the bare one
    const bare = ch.replace(/^-100/, '').replace(/^-/, '');
    return SNOWFLAKE.test(bare) ? `https://t.me/c/${bare}/${msg}` : undefined;
  }
  return undefined;
}

/** `$1.2M`, `$840K`, `$12` */
const compactUsd = (n: number): string => {
  const abs = Math.abs(n);
  const f = (v: number, unit: string) => `$${(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString()}${unit}`;
  if (abs >= 1e9) return f(n / 1e9, 'B');
  if (abs >= 1e6) return f(n / 1e6, 'M');
  if (abs >= 1e3) return f(n / 1e3, 'K');
  return `$${Math.round(n)}`;
};

function replyContext(feedId: string, channel: string, r: unknown): ReplyContext | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const raw = r as any;
  const author = name(raw.author_display_name, AUTHOR_MAX) || name(raw.author_username, AUTHOR_MAX);
  const text = cleanText(raw.content ?? '').replace(/\s+/g, ' ').trim();
  if (!author && !text) return undefined;
  const ext = idOf(raw.external_id);
  return { author: author || 'unknown', text, ...(ext ? { id: `vampy:${feedId}:${channel}:${ext}` } : {}) };
}

/**
 * A message-feed row (history or the `new-message` event). The id carries the channel: Telegram
 * message ids are per chat, and one feed can span several.
 */
export function messageToFeed(feed: VampyFeed, raw: any): FeedMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ext = idOf(raw.external_id) ?? idOf(raw.db_id) ?? idOf(raw.id);
  if (!ext) return undefined;
  const channel = idOf(raw.channel_external_id) ?? '';
  const content = cleanText(raw.content ?? '');
  // Discord-shaped attachments and embeds (the platforms' own objects, sometimes as JSON strings), with
  // every url checked first: the renderer loads these without a click, and Vampy is a party of its own
  const d = { content, attachments: safeAttachments(raw.attachments), embeds: safeEmbeds(raw.embeds) };
  const parts: string[] = [content];
  for (const e of d.embeds) {
    if (!e || typeof e !== 'object') continue;
    if (str(e.title)) parts.push(cleanText(e.title));
    if (str(e.description)) parts.push(cleanText(e.description));
    for (const f of list(e.fields)) if (str(f?.value)) parts.push(cleanText(f.value));
  }
  const embeds = discordEmbeds(d);
  const media = discordMedia(d);
  const previews = discordPreviews(d);
  const text = parts.filter(Boolean).join('\n');
  if (!text.trim() && media.length === 0 && d.attachments.length === 0) return undefined;
  const thread = name(raw.thread_name, TITLE_MAX);
  return {
    ...(embeds.length ? { body: content, embeds } : {}),
    id: `vampy:${feed.id}:${channel}:${ext}`,
    source: 'vampy',
    chatId: feed.id,
    chatName: chatNameOf(feed),
    author: name(raw.author_display_name, AUTHOR_MAX) || name(raw.author_username, AUTHOR_MAX) || 'unknown',
    avatar: httpUrl(raw.author_avatar_url, true),
    isBot: raw.is_bot === true,
    ...(thread ? { authorTag: thread } : {}),
    text,
    ts: when(raw.timestamp, raw.inserted_at),
    contracts: [],
    repeat: false,
    link: feedLink(raw.platform, raw.server_external_id, channel, ext),
    hasAttachment: d.attachments.length > 0,
    replyTo: replyContext(feed.id, channel, raw.reply_to),
    ...(media.length ? { media } : {}),
    ...(previews.length ? { previews } : {}),
  };
}

/**
 * A call-feed row (history or the `new-call` event): a message whose text is the ticker and the
 * contract, keyed on the platform message and the token (the live event's own `id` is always 0).
 */
export function callToFeed(feed: VampyFeed, raw: any): VampyRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const address = str(raw.token_address);
  const msgId = idOf(raw.message_external_id);
  if (!address || !msgId || !/^[A-Za-z0-9]{20,64}$/.test(address)) return undefined;
  const channel = idOf(raw.channel_external_id) ?? '';
  // the ticker is one word; the name is free text and goes to the token's meta only, never into the
  // line the contract detector reads (a "name" holding an address would register a second contract)
  const symbol = name(raw.token_symbol, SYMBOL_MAX).replace(/^\$/, '').replace(/\s+/g, '');
  const tokenName = name(raw.token_name, TITLE_MAX);
  const marketCap = num(raw.market_cap_at_call);
  const mc = marketCap !== undefined && marketCap > 0 ? marketCap : undefined;
  const lines = [symbol ? `$${symbol} ${address}` : address];
  if (mc !== undefined) lines.push(`called at ${compactUsd(mc)} mc`);
  const socials = obj(raw.socials);
  const meta: ExtractedMeta = {};
  if (tokenName) meta.name = tokenName;
  if (symbol) meta.symbol = symbol;
  const website = httpUrl(socials.website ?? socials.web ?? socials.site);
  const twitter = httpUrl(socials.twitter ?? socials.x);
  const telegram = httpUrl(socials.telegram ?? socials.tg);
  if (website) meta.website = website;
  if (twitter) meta.twitter = twitter;
  if (telegram) meta.telegram = telegram;
  const callerId = str(raw.caller_external_id);
  const msg: FeedMessage = {
    id: `vampy:${feed.id}:${channel}:${msgId}:${address}`,
    source: 'vampy',
    chatId: feed.id,
    chatName: chatNameOf(feed),
    author: name(raw.caller_display_name, AUTHOR_MAX) || name(raw.caller_username, AUTHOR_MAX) || (callerId ? `user ${callerId.slice(-6)}` : 'unknown'),
    avatar: httpUrl(raw.caller_avatar_url, true),
    isBot: raw.caller_is_bot === true,
    text: lines.join('\n'),
    ts: when(raw.timestamp),
    contracts: [],
    repeat: false,
    link: feedLink(raw.platform, raw.server_external_id, channel, msgId),
    hasAttachment: false,
  };
  return { msg, ...(Object.keys(meta).length ? { meta } : {}), ...(mc !== undefined ? { marketCap: mc } : {}) };
}

/** One row of a feed, by the feed's type. */
export function rowToFeed(feed: VampyFeed, raw: unknown): VampyRow | undefined {
  if (feed.type === 'call') return callToFeed(feed, raw);
  const msg = messageToFeed(feed, raw);
  return msg ? { msg } : undefined;
}
