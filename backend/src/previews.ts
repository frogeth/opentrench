import type { LinkPreview } from './types.js';

/**
 * Tweet previews via the public fxtwitter API (no key). Used only when the
 * platform didn't already unfurl the link for us.
 */

const TWEET_RE = /https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\/(\w{1,20})\/status\/(\d{1,25})/g;
const API = 'https://api.fxtwitter.com/status/';
const TIMEOUT_MS = 8000;
const CACHE_MAX = 500;

export function extractTweetUrls(text: string): { url: string; id: string }[] {
  const out: { url: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TWEET_RE)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ url: m[0], id: m[2] });
  }
  return out;
}

export function mapFxTweet(json: any): LinkPreview | undefined {
  const t = json?.tweet;
  if (!t?.url) return undefined;
  return {
    url: String(t.url),
    site: 'x',
    author: t.author?.name ? String(t.author.name) : undefined,
    handle: t.author?.screen_name ? String(t.author.screen_name) : undefined,
    text: t.text ? String(t.text) : undefined,
    avatar: t.author?.avatar_url ? String(t.author.avatar_url) : undefined,
    image: t.media?.photos?.[0]?.url ?? t.media?.videos?.[0]?.thumbnail_url ?? undefined,
  };
}

export type Previewer = (text: string, alreadyHave: string[]) => Promise<LinkPreview[]>;

export function createPreviewer(fetchImpl: typeof fetch = fetch): Previewer {
  const cache = new Map<string, LinkPreview | null>();
  const get = async (id: string): Promise<LinkPreview | null> => {
    if (cache.has(id)) return cache.get(id)!;
    let result: LinkPreview | null = null;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API + id, { signal: ctl.signal });
      if (res.ok) result = mapFxTweet(await res.json()) ?? null;
    } catch (e: any) {
      console.warn('[previews] tweet fetch failed', id, e?.message ?? e);
    } finally {
      clearTimeout(t);
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(id, result);
    return result;
  };
  return async (text, alreadyHave) => {
    const wanted = extractTweetUrls(text).filter(({ id }) => !alreadyHave.some((u) => u.includes(`/status/${id}`)));
    const found = await Promise.all(wanted.map(({ id }) => get(id)));
    return found.filter((p): p is LinkPreview => !!p);
  };
}
