import { describe, it, expect } from 'vitest';
import { normalizeJ7 } from './j7.js';

const base = { id: '1', author: { handle: 'someone' }, text: 'gm' };

describe('normalizeJ7 media', () => {
  it('takes image urls as strings or as objects, and drops what has no url', () => {
    const t = normalizeJ7({
      ...base,
      media: {
        images: ['https://pbs.twimg.com/a.jpg', { url: 'https://pbs.twimg.com/b.jpg', type: 'photo' }, { media_url_https: 'https://pbs.twimg.com/c.jpg' }, { type: 'video' }],
        thumbnails: [{ src: 'https://pbs.twimg.com/d.jpg' }],
      },
    });
    expect(t?.images).toEqual(['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg', 'https://pbs.twimg.com/c.jpg', 'https://pbs.twimg.com/d.jpg']);
  });

  it('accepts a bare media array of objects and never emits "[object Object]"', () => {
    const t = normalizeJ7({ ...base, media: [{ url: 'https://pbs.twimg.com/e.jpg' }, {}] });
    expect(t?.images).toEqual(['https://pbs.twimg.com/e.jpg']);
  });
});
