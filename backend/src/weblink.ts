import type { TokenInfo } from './types.js';

/**
 * Token links come from people we do not know: whoever launched a coin writes its website and socials
 * on-chain (Genius, Pons, pump-style launchpads), chart sites copy what creators typed, and a friend in
 * a room sends their copy of a token. The app opens these links and embeds the chart one, so only plain
 * web addresses are kept. Anything else (`javascript:`, `file:`, a UNC path, an OS handler scheme) is a
 * way to run something on the viewer's machine and is dropped.
 */
export function webLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 2048) return undefined;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname ? s : undefined;
  } catch {
    return undefined;
  }
}

/** A token image: a web address, our own IPFS proxy path, or inline image data. */
export function imageLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\/api\/ipfs\/[A-Za-z0-9]+(?:\/[A-Za-z0-9._~-]+)*$/.test(s) && !s.split('/').some((seg) => seg === '..' || seg === '.')) return s;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 512_000) return s;
  return webLink(s);
}

const WEB_KEYS = ['website', 'twitter', 'telegram', 'launchpadUrl', 'chartUrl', 'embedUrl', 'explorerUrl'] as const;

/** Drops every link on a token that is not safe to open or embed; returns how many went. */
export function scrubLinks(t: Partial<TokenInfo>): number {
  let dropped = 0;
  for (const k of WEB_KEYS) {
    const v = t[k];
    if (v === undefined) continue;
    const ok = webLink(v);
    if (ok === undefined) {
      delete t[k];
      dropped++;
    } else if (ok !== v) t[k] = ok;
  }
  if (t.imageUrl !== undefined) {
    const ok = imageLink(t.imageUrl);
    if (ok === undefined) {
      delete t.imageUrl;
      dropped++;
    } else t.imageUrl = ok;
  }
  return dropped;
}
