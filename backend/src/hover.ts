/**
 * Hover cards: a website's Open Graph summary and an X profile. Fetched lazily
 * when the user hovers, cached for a while, never stored.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true });
const MAX_REDIRECTS = 5;

/**
 * An address on the public internet. A token's website is whatever its creator typed, and the preview is
 * fetched by this machine, so a site on the user's own network (the router, this backend, a NAS) or a
 * cloud metadata address must never be reached through it.
 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast / reserved
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^(?:0*:)*:?(?:ffff:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(x) ?? /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1]);
    if (x === '::' || x === '::1') return false;
    if (/^f[cd]/.test(x)) return false; // unique local
    if (/^fe[89ab]/.test(x)) return false; // link-local
    if (/^ff/.test(x)) return false; // multicast
    return true;
  }
  return false;
}

/** The URL is http(s) and every address its host resolves to is public; the reason when it is not. */
async function refusal(url: URL, lookup: Lookup): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'not a web address';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || /(^|\.)localhost$/i.test(host)) return 'a local address';
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host);
  if (!addrs.length) return 'no address';
  if (addrs.some((a) => !isPublicAddress(a.address))) return 'a local or private address';
  return undefined;
}

export interface SitePreview {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface XProfile {
  handle: string;
  name: string;
  url: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  followers?: number;
  following?: number;
  tweets?: number;
  joined?: number;
  location?: string;
  website?: string;
  verified?: boolean;
}

const TIMEOUT_MS = 7000;
const MAX_HTML = 512 * 1024;
const UA = 'Mozilla/5.0 (compatible; opentrench/1.0; +https://github.com/frogeth/opentrench)';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** <meta property/name="…" content="…"> in either attribute order. */
function meta(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta\\s+(?:[^>]*?\\s)?(?:property|name)=["']${key}["'][^>]*?\\scontent=["']([^"']*)["']|<meta\\s+(?:[^>]*?\\s)?content=["']([^"']*)["'][^>]*?\\s(?:property|name)=["']${key}["']`,
    'i',
  );
  const m = re.exec(html);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v) : undefined;
}

export function parseSitePreview(url: string, html: string): SitePreview {
  const head = html.slice(0, MAX_HTML);
  const title = meta(head, 'og:title') ?? meta(head, 'twitter:title') ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? '');
  const description = meta(head, 'og:description') ?? meta(head, 'twitter:description') ?? meta(head, 'description');
  let image = meta(head, 'og:image') ?? meta(head, 'og:image:url') ?? meta(head, 'twitter:image');
  if (image && !/^https?:/i.test(image)) {
    try {
      image = new URL(image, url).toString();
    } catch {
      image = undefined;
    }
  }
  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  const out: SitePreview = { url, domain, title: title || undefined, description, image, siteName: meta(head, 'og:site_name') };
  for (const k of Object.keys(out) as (keyof SitePreview)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function mapFxUser(json: any): XProfile | undefined {
  const u = json?.user;
  if (!u?.screen_name) return undefined;
  const out: XProfile = {
    handle: String(u.screen_name),
    name: String(u.name ?? u.screen_name),
    url: `https://x.com/${u.screen_name}`,
    bio: u.description ? String(u.description) : undefined,
    avatar: u.avatar_url ? String(u.avatar_url).replace('_normal.', '_200x200.') : undefined,
    banner: u.banner_url ? String(u.banner_url) : undefined,
    followers: Number.isFinite(Number(u.followers)) ? Number(u.followers) : undefined,
    following: Number.isFinite(Number(u.following)) ? Number(u.following) : undefined,
    tweets: Number.isFinite(Number(u.tweets)) ? Number(u.tweets) : undefined,
    joined: u.joined && Number.isFinite(Date.parse(u.joined)) ? Date.parse(u.joined) : undefined,
    location: u.location ? String(u.location) : undefined,
    website: u.website?.url ? String(u.website.url) : undefined,
    verified: u.verification?.verified ?? u.verified ?? undefined,
  };
  for (const k of Object.keys(out) as (keyof XProfile)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** x.com/<handle>[/status/…] → handle; search / i / home / hashtag links have no profile. */
export function xHandleFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,20})(?:[/?#]|$)/i.exec(url);
  const h = m?.[1];
  if (!h || /^(search|i|home|explore|intent|hashtag|share|login|settings)$/i.test(h)) return undefined;
  return h;
}

export interface HoverFetchers {
  site: (url: string) => Promise<SitePreview | undefined>;
  xProfile: (handle: string) => Promise<XProfile | undefined>;
}

export function createHoverFetchers(fetchImpl: typeof fetch = fetch, ttlMs = 30 * 60 * 1000, lookup: Lookup = systemLookup): HoverFetchers {
  const cache = new Map<string, { at: number; v: unknown }>();
  const remember = <T>(key: string, v: T): T => {
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), v });
    return v;
  };
  const hit = <T>(key: string): T | undefined => {
    const c = cache.get(key);
    return c && Date.now() - c.at < ttlMs ? (c.v as T) : undefined;
  };
  const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fn(ctl.signal);
    } finally {
      clearTimeout(t);
    }
  };
  return {
    async site(url) {
      const key = `site:${url}`;
      const c = hit<SitePreview | null>(key);
      if (c !== undefined) return c ?? undefined;
      try {
        return (
          remember(
            key,
            await withTimeout(async (signal) => {
              // redirects by hand, so every hop is checked, not only the address the creator typed
              let at = new URL(url);
              for (let hop = 0; ; hop++) {
                const why = await refusal(at, lookup);
                if (why) {
                  console.warn(`[hover] site preview refused: ${at.host} is ${why}`);
                  return null;
                }
                const res = await fetchImpl(at.href, { signal, redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
                const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
                if (next) {
                  if (hop >= MAX_REDIRECTS) return null;
                  at = new URL(next, at);
                  continue;
                }
                if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') ?? '')) return null;
                const html = (await res.text()).slice(0, MAX_HTML);
                return parseSitePreview(at.href, html);
              }
            }),
          ) ?? undefined
        );
      } catch (e: any) {
        console.warn('[hover] site preview failed', url, e?.message ?? e);
        return remember(key, null) ?? undefined;
      }
    },
    async xProfile(handle) {
      const key = `x:${handle.toLowerCase()}`;
      const c = hit<XProfile | null>(key);
      if (c !== undefined) return c ?? undefined;
      try {
        return (
          remember(
            key,
            await withTimeout(async (signal) => {
              const res = await fetchImpl(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, { signal, headers: { 'user-agent': UA } });
              if (!res.ok) return null;
              return mapFxUser(await res.json()) ?? null;
            }),
          ) ?? undefined
        );
      } catch (e: any) {
        console.warn('[hover] x profile failed', handle, e?.message ?? e);
        return remember(key, null) ?? undefined;
      }
    },
  };
}
