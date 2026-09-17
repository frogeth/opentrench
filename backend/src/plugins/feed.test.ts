import { describe, expect, it } from 'vitest';
import { PostLimiter, chatIdFor, toFeedMessage } from './feed.js';

const M = { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: ['https://example.com'], permissions: ['feed:write' as const], ui: false, description: '' };
/** the same plugin with nothing declared: every media URL is off-site for it */
const NO_SITES = { ...M, sites: [] };

describe('chatIdFor', () => {
  it('slugs the chat name to lowercase a-z0-9 and dashes, so the config key regexes accept it', () => {
    expect(chatIdFor('hello-feed', 'Alerts!')).toBe('plugin:hello-feed:alerts');
    expect(chatIdFor('hello-feed', '  Daily   News // EU ')).toBe('plugin:hello-feed:daily-news-eu');
    expect(chatIdFor('hello-feed', '日本')).toBe('plugin:hello-feed:chat');
    expect(chatIdFor('hello-feed', 'x'.repeat(80))).toMatch(/^plugin:hello-feed:x{40}$/);
    expect(chatIdFor('hello-feed', 'Alerts!')).toMatch(/^plugin:[a-z0-9-]+:[a-z0-9-]+$/);
  });
});

describe('toFeedMessage', () => {
  it('builds a plugin-sourced message keyed by plugin and chat, with the plugin id in the message id', () => {
    const m = toFeedMessage('hello-feed', M, { id: '42', chat: 'Alerts!', author: 'scanner', text: 'new pair 0xdac17f958d2ee523a2206206994597c13d831ec7', ts: 1000 });
    expect(m).toMatchObject({ id: 'plugin:hello-feed:alerts:42', source: 'plugin', chatId: 'plugin:hello-feed:alerts', chatName: 'Alerts!', author: 'scanner', text: 'new pair 0xdac17f958d2ee523a2206206994597c13d831ec7', ts: 1000, isBot: false, hidden: false, repeat: false, contracts: [], hasAttachment: false });
  });
  it('defaults ts to now, caps text, rejects empties and bad urls, sanitizes author and chat', () => {
    const now = Date.now();
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x' }).ts).toBeGreaterThanOrEqual(now);
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'y'.repeat(9000) }).text.length).toBe(4000);
    expect(() => toFeedMessage('p', M, { id: '', chat: 'c', author: 'a', text: 'x' })).toThrow('id');
    expect(() => toFeedMessage('p', M, { id: '1', chat: '', author: 'a', text: 'x' })).toThrow('chat');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: '' })).toThrow('text');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: 'javascript:alert(1)' })).toThrow('link');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', attachments: 'nope' as any })).toThrow('attachments must be an array');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', attachments: [{ url: 'ftp://x' }] })).toThrow('attachment');
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: 'https://example.com/x', avatar: 'https://example.com/a.png' })).toMatchObject({ link: 'https://example.com/x', avatar: 'https://example.com/a.png' });
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: '', text: 'x' }).author).toBe('Hello feed');
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a b\n\nc', text: 'x' }).author).toBe('a b c');
    expect(toFeedMessage('p', M, { id: '1', chat: ' Chat\u202ename ', author: 'a', text: 'x' }).chatName).toBe('Chat name');
    // ZWJ holds an emoji sequence together, so sanitizing must not break it the way stripping all of \p{Cf} would
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: '👩\u200d🚀 astro', text: 'x' }).author).toBe('👩\u200d🚀 astro');
    // an id is a dedupe key: control chars go, inner spacing stays
    expect(toFeedMessage('p', M, { id: ' a\u202e b ', chat: 'c', author: 'a', text: 'x' }).id).toBe('plugin:p:c:a b');
    const a = toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: '', attachments: [{ url: 'https://example.com/i.png' }, { url: 'https://example.com/v.mp4', kind: 'video' }] });
    expect(a.hasAttachment).toBe(true);
    expect(a.media?.map((x) => x.kind)).toEqual(['image', 'video']);
  });
  it('a future or absurd ts is clamped to now', () => {
    const now = Date.now();
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', ts: now + 3_600_000 })).toMatchObject({ ts: expect.any(Number) });
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', ts: now + 3_600_000 }).ts).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', ts: -5 }).ts).toBeGreaterThanOrEqual(now);
  });
});

describe('media and link URLs', () => {
  it('media loads on its own, so it must be https on a declared site; anything else would be a beacon', () => {
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', avatar: 'https://example.com/a.png' }).avatar).toBe('https://example.com/a.png');
    expect(() => toFeedMessage('p', NO_SITES, { id: '1', chat: 'c', author: 'a', text: 'x', avatar: 'https://example.com/a.png' })).toThrow("avatar must be https on one of the plugin's sites");
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', avatar: 'https://tracker.example.org/a.png' })).toThrow('avatar');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', avatar: 'http://example.com/a.png' })).toThrow('avatar');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', attachments: [{ url: 'https://tracker.example.org/i.png' }] })).toThrow("attachment url must be https on one of the plugin's sites");
    // a declared site with a port or another path is still one origin: the origin is what must match
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', avatar: 'https://example.com:8443/a.png' })).toThrow('avatar');
  });
  it('a link is click-gated, so http is fine, but never at a local or private address', () => {
    expect(toFeedMessage('p', NO_SITES, { id: '1', chat: 'c', author: 'a', text: 'x', link: 'http://news.example.org/x' }).link).toBe('http://news.example.org/x');
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: 'http://127.0.0.1:3210/x' })).toThrow('link must not point at a local address');
    const local = [
      'localhost:3210',
      'localhost.', // the root-label spelling resolves the same
      'a.localhost.',
      '10.0.0.5',
      '192.168.1.9',
      '172.20.0.1',
      '169.254.169.254', // the cloud metadata address
      '0.0.0.0',
      '127.1', // short form: URL folds it to 127.0.0.1
      '0x7f000001', // hex form: likewise
      '[::1]:3210',
      '[::ffff:127.0.0.1]', // IPv4-mapped, which URL re-serializes as [::ffff:7f00:1]
      '[::ffff:10.0.0.1]',
      '[fc00::1]', // unique local
      '[fe80::1]', // link-local
    ];
    for (const host of local) expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: `http://${host}/x` })).toThrow('local address');
    // a public host that merely looks close to a private range is fine
    for (const host of ['example.com', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.1.1'])
      expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: `https://${host}/x` }).link).toBe(`https://${host}/x`);
  });
});

describe('PostLimiter', () => {
  it('allows 60 posts a minute per plugin, then refuses until the window moves', () => {
    const l = new PostLimiter(60, 60_000);
    for (let i = 0; i < 60; i++) expect(l.take('a', 1000 + i)).toBe(true);
    expect(l.take('a', 1100)).toBe(false);
    expect(l.take('b', 1100)).toBe(true);
    expect(l.take('a', 1000 + 60_001)).toBe(true);
  });
});
