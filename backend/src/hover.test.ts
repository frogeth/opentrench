import { describe, expect, it } from 'vitest';
import { createHoverFetchers, isPublicAddress, mapFxUser, parseSitePreview, xHandleFromUrl, type Lookup } from './hover.js';

const publicDns: Lookup = async () => [{ address: '93.184.216.34' }];

describe('hover cards', () => {
  it('parses open graph tags in either attribute order, resolving relative images', () => {
    const html = `<html><head><title>Fallback &amp; title</title>
      <meta content="Own the fee generating layer." property="og:title">
      <meta name="description" content="plain desc">
      <meta property="og:description" content="A 5% tax on every trade &#39;airdropped&#39;">
      <meta property="og:image" content="/og.png">
      <meta property="og:site_name" content="Ouro"></head></html>`;
    expect(parseSitePreview('https://www.ourolayer.com/x', html)).toEqual({
      url: 'https://www.ourolayer.com/x',
      domain: 'ourolayer.com',
      title: 'Own the fee generating layer.',
      description: "A 5% tax on every trade 'airdropped'",
      image: 'https://www.ourolayer.com/og.png',
      siteName: 'Ouro',
    });
    expect(parseSitePreview('https://a.b', '<title>Only &amp; title</title>')).toEqual({ url: 'https://a.b', domain: 'a.b', title: 'Only & title' });
  });

  it('maps an fxtwitter user', () => {
    const p = mapFxUser({
      user: {
        screen_name: 'OuroLayer',
        name: 'Ouro',
        description: 'Own the fee generating layer',
        avatar_url: 'https://pbs.twimg.com/a_normal.jpg',
        banner_url: 'https://pbs.twimg.com/b.jpg',
        followers: 207,
        following: 6,
        tweets: 12,
        joined: 'Sat Aug 01 00:00:00 +0000 2026',
        location: 'Robinhood Chain',
        website: { url: 'https://ourolayer.com' },
        verification: { verified: true },
      },
    });
    expect(p).toMatchObject({
      handle: 'OuroLayer',
      name: 'Ouro',
      url: 'https://x.com/OuroLayer',
      avatar: 'https://pbs.twimg.com/a_200x200.jpg',
      followers: 207,
      following: 6,
      location: 'Robinhood Chain',
      website: 'https://ourolayer.com',
      verified: true,
    });
    expect(p?.joined).toBe(Date.parse('Sat Aug 01 00:00:00 +0000 2026'));
    expect(mapFxUser({ code: 404 })).toBeUndefined();
  });

  it('extracts profile handles from x links but not search / status-less specials', () => {
    expect(xHandleFromUrl('https://x.com/OuroLayer')).toBe('OuroLayer');
    expect(xHandleFromUrl('https://twitter.com/ouro/status/123')).toBe('ouro');
    expect(xHandleFromUrl('https://x.com/search?q=ouro')).toBeUndefined();
    expect(xHandleFromUrl('https://x.com/i/communities/1')).toBeUndefined();
    expect(xHandleFromUrl(undefined)).toBeUndefined();
  });

  it('caches lookups, including misses', async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      n++;
      if (url.includes('fxtwitter')) return { ok: true, json: async () => ({ user: { screen_name: 'a', name: 'A' } }) };
      return { ok: true, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<title>T</title>' };
    }) as unknown as typeof fetch;
    const h = createHoverFetchers(fetchImpl, undefined, publicDns);
    expect((await h.site('https://a.b'))?.title).toBe('T');
    expect((await h.site('https://a.b'))?.title).toBe('T');
    expect((await h.xProfile('a'))?.name).toBe('A');
    expect((await h.xProfile('A'))?.name).toBe('A');
    expect(n).toBe(2);
  });

  it('knows public addresses from local, private and special ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.10'])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  /** A token's website is whatever its creator typed; this machine must not be made to fetch its own network. */
  describe('site previews never reach the local network', () => {
    const page = (url: string) => ({ ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<title>Public</title>' });
    const quiet = () => {
      const warn = console.warn;
      console.warn = () => {};
      return () => (console.warn = warn);
    };

    it('refuses local, private and metadata addresses, typed or resolved', async () => {
      const restore = quiet();
      const fetched: string[] = [];
      const fetchImpl = (async (url: string) => (fetched.push(url), page(url))) as unknown as typeof fetch;
      const dns: Lookup = async (host) => [{ address: host === 'router.example' ? '192.168.1.1' : '93.184.216.34' }];
      const h = createHoverFetchers(fetchImpl, undefined, dns);
      for (const u of ['http://127.0.0.1:3210/api/config', 'http://localhost:3210/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://router.example/'])
        expect(await h.site(u), u).toBeUndefined();
      restore();
      expect(fetched).toEqual([]);
    });

    it('checks every redirect hop, not only the first address', async () => {
      const restore = quiet();
      const fetched: string[] = [];
      const fetchImpl = (async (url: string) => {
        fetched.push(url);
        if (url.startsWith('https://bounce.example')) return { ok: false, status: 302, headers: new Headers({ location: 'http://10.0.0.5/admin' }), text: async () => '' };
        if (url === 'https://hop.example/start') return { ok: false, status: 301, headers: new Headers({ location: '/landing' }), text: async () => '' };
        return page(url);
      }) as unknown as typeof fetch;
      const h = createHoverFetchers(fetchImpl, undefined, publicDns);
      expect(await h.site('https://bounce.example/')).toBeUndefined();
      expect((await h.site('https://hop.example/start'))?.title).toBe('Public');
      restore();
      expect(fetched).toEqual(['https://bounce.example/', 'https://hop.example/start', 'https://hop.example/landing']);
    });
  });
});
