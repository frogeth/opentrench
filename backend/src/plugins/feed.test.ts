import { describe, expect, it } from 'vitest';
import { PostLimiter, chatIdFor, toFeedMessage } from './feed.js';

const M = { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: [], permissions: ['feed:write' as const], ui: false, description: '' };

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
    expect(() => toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', attachments: [{ url: 'ftp://x' }] })).toThrow('attachment');
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a', text: 'x', link: 'https://example.com/x', avatar: 'https://example.com/a.png' })).toMatchObject({ link: 'https://example.com/x', avatar: 'https://example.com/a.png' });
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: '', text: 'x' }).author).toBe('Hello feed');
    expect(toFeedMessage('p', M, { id: '1', chat: 'c', author: 'a b\n\nc', text: 'x' }).author).toBe('a b c');
    expect(toFeedMessage('p', M, { id: '1', chat: ' Chat‮name ', author: 'a', text: 'x' }).chatName).toBe('Chat name');
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

describe('PostLimiter', () => {
  it('allows 60 posts a minute per plugin, then refuses until the window moves', () => {
    const l = new PostLimiter(60, 60_000);
    for (let i = 0; i < 60; i++) expect(l.take('a', 1000 + i)).toBe(true);
    expect(l.take('a', 1100)).toBe(false);
    expect(l.take('b', 1100)).toBe(true);
    expect(l.take('a', 1000 + 60_001)).toBe(true);
  });
});
