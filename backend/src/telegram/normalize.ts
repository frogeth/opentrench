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
  /** Telegram's own flag: you were mentioned or replied to */
  mentioned?: boolean;
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
    // chosenOrder is present only on reactions you set yourself
    const mine = r?.chosenOrder !== undefined && r?.chosenOrder !== null ? true : undefined;
    if (re?.emoticon) out.push({ key: String(re.emoticon), name: String(re.emoticon), count, ...(mine ? { mine } : {}) });
    else if (re?.documentId !== undefined) out.push({ key: `custom:${String(re.documentId)}`, name: '★', count, ...(mine ? { mine } : {}) });
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
    ...(p.mentioned ? { mention: 'user' as const } : {}),
    reactions: p.reactions,
    chatAvatar: `/api/telegram/avatar/${p.chatId}`,
    media: p.media ?? [],
    previews: p.previews ?? [],
  };
}

const MEDIA_ITEM_MAX = 25 * 1024 * 1024;

function hasAttr(doc: any, cls: string): boolean {
  return (doc?.attributes ?? []).some((a: any) => a?.className === cls);
}

/**
 * Classify a message's media into what the feed can render. `url` is our
 * media endpoint for this message; `?thumb=1` on it returns a JPEG preview.
 */
export function classifyMedia(media: any, url: string): MediaItem[] {
  if (!media) return [];
  if (media.className === 'MessageMediaPhoto' && media.photo) return [{ kind: 'image', url, mime: 'image/jpeg' }];
  if (media.className === 'MessageMediaDocument' && media.document) {
    const doc = media.document;
    const mime = String(doc.mimeType ?? '');
    if (Number(doc.size ?? 0) > MEDIA_ITEM_MAX) return [];
    if (hasAttr(doc, 'DocumentAttributeSticker')) {
      // Lottie (.tgs) has no static form we can play; show Telegram's thumbnail instead.
      if (mime === 'application/x-tgsticker') return [{ kind: 'sticker', url: `${url}?thumb=1`, mime: 'image/jpeg' }];
      return [{ kind: 'sticker', url, mime }];
    }
    if (hasAttr(doc, 'DocumentAttributeAnimated') || mime === 'image/gif') return [{ kind: 'gif', url, poster: `${url}?thumb=1`, mime }];
    if (hasAttr(doc, 'DocumentAttributeVideo') || mime.startsWith('video/')) return [{ kind: 'video', url, poster: `${url}?thumb=1`, mime }];
    if (mime.startsWith('image/')) return [{ kind: 'image', url, mime }];
  }
  return [];
}

/** Telegram's own link preview (web page) → our card. */
export function webpagePreview(media: any, imageUrl: string): LinkPreview | undefined {
  const w = media?.className === 'MessageMediaWebPage' ? media.webpage : undefined;
  if (!w || w.className !== 'WebPage' || !w.url) return undefined;
  const url = String(w.url);
  const isX = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url);
  const m = /^(.*?)\s*\(@([A-Za-z0-9_]+)\)\s*$/.exec(String(w.author ?? w.title ?? ''));
  return {
    url,
    site: isX ? 'x' : 'web',
    title: w.siteName ? String(w.siteName) : undefined,
    author: m ? m[1] : w.author ? String(w.author) : w.title ? String(w.title) : undefined,
    handle: m ? m[2] : undefined,
    text: w.description ? String(w.description) : undefined,
    image: w.photo ? imageUrl : undefined,
  };
}

/**
 * Telegram formats text with entities (offset/length in UTF-16 units) rather than
 * markup. Turn the ones we render — text links, bold, code — into the markdown
 * the UI already understands, so bot panels keep their links and emphasis.
 */
/**
 * The same text for Discord, which has its own markdown: bold, italic, underline, strike,
 * spoilers, code, quotes. Discord does not render masked links in a person's message, so a
 * text link becomes "text (url)" and a bare url stays as it is.
 */
export function entitiesToDiscord(text: string, entities: any[] | undefined): string {
  if (!entities?.length || !text) return text;
  const wrap: { start: number; end: number; open: string; close: string }[] = [];
  for (const e of entities) {
    const start = Number(e.offset), end = start + Number(e.length);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > text.length) continue;
    const inner = text.slice(start, end);
    switch (e.className) {
      case 'MessageEntityTextUrl': {
        const url = String(e.url ?? '');
        if (url && inner.trim() !== url) wrap.push({ start, end, open: '', close: ` (${url})` });
        break;
      }
      case 'MessageEntityBold':
        wrap.push({ start, end, open: '**', close: '**' });
        break;
      case 'MessageEntityItalic':
        wrap.push({ start, end, open: '*', close: '*' });
        break;
      case 'MessageEntityUnderline':
        wrap.push({ start, end, open: '__', close: '__' });
        break;
      case 'MessageEntityStrike':
        wrap.push({ start, end, open: '~~', close: '~~' });
        break;
      case 'MessageEntitySpoiler':
        wrap.push({ start, end, open: '||', close: '||' });
        break;
      case 'MessageEntityCode':
        wrap.push({ start, end, open: '`', close: '`' });
        break;
      case 'MessageEntityPre':
        wrap.push({ start, end, open: `\`\`\`${e.language ? String(e.language) : ''}\n`, close: '\n```' });
        break;
      case 'MessageEntityBlockquote':
        wrap.push({ start, end, open: '> ', close: '' });
        break;
      default:
        break;
    }
  }
  if (wrap.length === 0) return text;
  // outermost first; nested spans apply inside their parent, overlapping ones are skipped
  wrap.sort((a, b) => a.start - b.start || b.end - a.end);
  const render = (from: number, to: number, spans: typeof wrap): string => {
    let out = '';
    let pos = from;
    for (let i = 0; i < spans.length; i++) {
      const w = spans[i];
      if (w.start < pos) continue; // overlaps the one just applied
      const inside: typeof wrap = [];
      let j = i + 1;
      while (j < spans.length && spans[j].start < w.end) {
        if (spans[j].end <= w.end) inside.push(spans[j]);
        j++;
      }
      const inner = render(w.start, w.end, inside);
      // a quote marks every line it spans
      out += text.slice(pos, w.start) + w.open + (w.open === '> ' ? inner.replace(/\n/g, '\n> ') : inner) + w.close;
      pos = w.end;
      i = j - 1;
    }
    return out + text.slice(pos, to);
  };
  return render(0, text.length, wrap);
}

export function entitiesToMarkdown(text: string, entities: any[] | undefined): string {
  if (!entities?.length || !text) return text;
  const wrap: { start: number; end: number; open: string; close: string }[] = [];
  for (const e of entities) {
    const start = Number(e.offset), end = start + Number(e.length);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > text.length) continue;
    switch (e.className) {
      case 'MessageEntityTextUrl':
        wrap.push({ start, end, open: '[', close: `](${String(e.url)})` });
        break;
      case 'MessageEntityBold':
        wrap.push({ start, end, open: '**', close: '**' });
        break;
      case 'MessageEntityCode':
        wrap.push({ start, end, open: '`', close: '`' });
        break;
      default:
        break;
    }
  }
  if (wrap.length === 0) return text;
  // outermost first; skip anything that overlaps an already-applied span
  wrap.sort((a, b) => a.start - b.start || b.end - a.end);
  const applied: typeof wrap = [];
  for (const w of wrap) {
    if (applied.some((a) => w.start < a.end && a.start < w.end)) continue;
    applied.push(w);
  }
  let out = '';
  let pos = 0;
  for (const w of applied) {
    out += text.slice(pos, w.start) + w.open + text.slice(w.start, w.end) + w.close;
    pos = w.end;
  }
  return out + text.slice(pos);
}
