import { describe, expect, it } from 'vitest';
import { createHoverFetchers, mapFxUser, parseSitePreview, xHandleFromUrl } from './hover.js';

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
    const h = createHoverFetchers(fetchImpl);
    expect((await h.site('https://a.b'))?.title).toBe('T');
    expect((await h.site('https://a.b'))?.title).toBe('T');
    expect((await h.xProfile('a'))?.name).toBe('A');
    expect((await h.xProfile('A'))?.name).toBe('A');
    expect(n).toBe(2);
  });
});
