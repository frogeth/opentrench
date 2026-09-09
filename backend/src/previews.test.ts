import { describe, it, expect } from 'vitest';
import { createPreviewer, extractTweetUrls, mapFxTweet } from './previews.js';

describe('previews', () => {
  it('extracts tweet urls across x/twitter/fx domains and dedupes by id', () => {
    const text = 'see https://x.com/jack/status/20?s=20 and https://twitter.com/jack/status/20 plus https://fxtwitter.com/a/status/12345 and https://x.com/home';
    expect(extractTweetUrls(text)).toEqual([
      { url: 'https://x.com/jack/status/20', id: '20' },
      { url: 'https://fxtwitter.com/a/status/12345', id: '12345' },
    ]);
  });

  it('maps an fxtwitter payload', () => {
    expect(
      mapFxTweet({
        tweet: {
          url: 'https://x.com/jack/status/20',
          text: 'just setting up my twttr',
          author: { name: 'jack', screen_name: 'jack', avatar_url: 'https://pbs/av.jpg' },
          media: { photos: [{ url: 'https://pbs/p.jpg' }] },
        },
      }),
    ).toEqual({
      url: 'https://x.com/jack/status/20',
      site: 'x',
      author: 'jack',
      handle: 'jack',
      text: 'just setting up my twttr',
      avatar: 'https://pbs/av.jpg',
      image: 'https://pbs/p.jpg',
    });
    expect(mapFxTweet({ code: 404 })).toBeUndefined();
  });

  it('fetches once per id, skips ids already previewed, tolerates failures', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/99')) throw new Error('boom');
      return { ok: true, json: async () => ({ tweet: { url: 'https://x.com/a/status/20', text: 'hi', author: {} } }) } as any;
    }) as unknown as typeof fetch;
    const preview = createPreviewer(fetchImpl);
    const a = await preview('https://x.com/a/status/20 https://x.com/b/status/99', []);
    expect(a).toHaveLength(1);
    const b = await preview('https://x.com/a/status/20', []);
    expect(b).toHaveLength(1);
    const c = await preview('https://x.com/a/status/20', ['https://x.com/a/status/20']);
    expect(c).toEqual([]);
    expect(calls).toEqual(['https://api.fxtwitter.com/status/20', 'https://api.fxtwitter.com/status/99']);
  });
});
