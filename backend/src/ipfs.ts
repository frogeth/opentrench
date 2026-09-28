/**
 * IPFS image proxy: tries several public gateways in order and caches the
 * bytes, so a launchpad logo never depends on one flaky gateway (or on the
 * browser being allowed to reach it).
 */

/** What the IPFS proxy will serve: raster images and video. No SVG, HTML or anything else a browser could run. */
export const IPFS_MEDIA = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'video/mp4', 'video/webm', 'video/quicktime']);

// Pinata first: since 2026-09 ipfs.io and dweb.link answer every request with a "service worker gateway" notice (429)
const GATEWAYS = [
  (cid: string, path: string) => `https://gateway.pinata.cloud/ipfs/${cid}${path}`,
  (cid: string, path: string) => `https://${cid}.ipfs.w3s.link${path}`,
  (cid: string, path: string) => `https://ipfs.io/ipfs/${cid}${path}`,
  (cid: string, path: string) => `https://${cid}.ipfs.dweb.link${path}`,
];
const TIMEOUT_MS = 10_000;
const MAX_ITEM = 8 * 1024 * 1024;
const MAX_TOTAL = 80 * 1024 * 1024;

export interface IpfsBlob {
  buf: Buffer;
  mime: string;
}

export class IpfsCache {
  private items = new Map<string, IpfsBlob | null>();
  private total = 0;
  private inflight = new Map<string, Promise<IpfsBlob | null>>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  get(cid: string, path = ''): Promise<IpfsBlob | null> {
    const key = cid + path;
    const hit = this.items.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetchAny(cid, path).then((blob) => {
      this.inflight.delete(key);
      if (blob) {
        this.total += blob.buf.length;
        while (this.total > MAX_TOTAL && this.items.size) {
          const oldest = this.items.keys().next().value!;
          this.total -= this.items.get(oldest)?.buf.length ?? 0;
          this.items.delete(oldest);
        }
      }
      this.items.set(key, blob);
      return blob;
    });
    this.inflight.set(key, p);
    return p;
  }

  private async fetchAny(cid: string, path: string): Promise<IpfsBlob | null> {
    for (const gw of GATEWAYS) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(gw(cid, path), {
          signal: ctl.signal,
          headers: { accept: 'image/*,video/*', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) trenchfeed' },
        });
        if (!res.ok) continue;
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        // Gateways answer 200 with an HTML interstitial/error page for blocked content — not an image. And
        // what is behind a CID is whatever a coin's creator uploaded: SVG can carry script, and this is
        // served from the app's own address, so only raster images and video get through.
        if (!IPFS_MEDIA.has(mime)) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_ITEM) continue;
        return { buf, mime };
      } catch {
        /* next gateway */
      } finally {
        clearTimeout(t);
      }
    }
    console.warn('[ipfs] all gateways failed for', cid + path);
    return null;
  }
}
