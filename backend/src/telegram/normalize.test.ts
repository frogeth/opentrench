import { describe, it, expect } from 'vitest';
import { classifyMedia, mapTelegramReactions, normalizeTelegram, webpagePreview } from './normalize.js';

describe('normalizeTelegram', () => {
  it('maps plain fields', () => {
    expect(
      normalizeTelegram({
        id: 42,
        chatId: '-1001234',
        chatTitle: 'Alpha Group',
        chatUsername: 'alphagrp',
        senderId: '777',
        senderName: '@caller',
        isBot: false,
        text: 'CA below',
        date: 1_757_332_800,
        hasMedia: true,
      }),
    ).toEqual({
      id: 'telegram:-1001234:42',
      source: 'telegram',
      chatId: '-1001234',
      chatName: 'Alpha Group',
      author: '@caller',
      avatar: '/api/telegram/avatar/777',
      isBot: false,
      text: 'CA below',
      ts: 1_757_332_800_000,
      contracts: [],
      repeat: false,
      link: 'https://t.me/alphagrp/42',
      hasAttachment: true,
      chatAvatar: '/api/telegram/avatar/-1001234',
      media: [],
      previews: [],
    });
  });
  it('maps reactions, skipping zero counts', () => {
    expect(
      mapTelegramReactions([
        { reaction: { emoticon: '🔥' }, count: 3 },
        { reaction: { documentId: '555' }, count: 1 },
        { reaction: { emoticon: '👍' }, count: 0 },
      ]),
    ).toEqual([
      { key: '🔥', name: '🔥', count: 3 },
      { key: 'custom:555', name: '★', count: 1 },
    ]);
    expect(mapTelegramReactions(undefined)).toEqual([]);
  });
  it('omits link and avatar when unknown', () => {
    const m = normalizeTelegram({
      id: 1,
      chatId: '-5',
      chatTitle: 'Priv',
      senderName: 'x',
      isBot: true,
      text: '',
      date: 0,
      hasMedia: false,
    });
    expect(m.link).toBeUndefined();
    expect(m.avatar).toBeUndefined();
    expect(m.isBot).toBe(true);
  });
});

describe('classifyMedia', () => {
  const U = '/api/telegram/media/-1/5';
  const doc = (mimeType: string, attrs: string[], size = 1000) => ({
    className: 'MessageMediaDocument',
    document: { mimeType, size, attributes: attrs.map((className) => ({ className })) },
  });
  it('photos are images', () => {
    expect(classifyMedia({ className: 'MessageMediaPhoto', photo: {} }, U)).toEqual([{ kind: 'image', url: U, mime: 'image/jpeg' }]);
  });
  it('webm video stickers keep their video mime', () => {
    expect(classifyMedia(doc('video/webm', ['DocumentAttributeSticker', 'DocumentAttributeVideo']), U)).toEqual([
      { kind: 'sticker', url: U, mime: 'video/webm' },
    ]);
  });
  it('lottie stickers fall back to the thumbnail', () => {
    expect(classifyMedia(doc('application/x-tgsticker', ['DocumentAttributeSticker']), U)).toEqual([
      { kind: 'sticker', url: `${U}?thumb=1`, mime: 'image/jpeg' },
    ]);
  });
  it('gifs, videos, images, and oversize docs', () => {
    expect(classifyMedia(doc('video/mp4', ['DocumentAttributeAnimated', 'DocumentAttributeVideo']), U)[0]).toMatchObject({ kind: 'gif', mime: 'video/mp4', poster: `${U}?thumb=1` });
    expect(classifyMedia(doc('video/mp4', ['DocumentAttributeVideo']), U)[0]).toMatchObject({ kind: 'video' });
    expect(classifyMedia(doc('image/webp', []), U)[0]).toMatchObject({ kind: 'image', mime: 'image/webp' });
    expect(classifyMedia(doc('video/mp4', ['DocumentAttributeVideo'], 99_000_000), U)).toEqual([]);
    expect(classifyMedia(undefined, U)).toEqual([]);
  });
  it('maps a web page preview', () => {
    expect(
      webpagePreview({ className: 'MessageMediaWebPage', webpage: { className: 'WebPage', url: 'https://x.com/a/status/1', siteName: 'X', author: 'Jack (@jack)', description: 'hi', photo: {} } }, `${U}?thumb=1`),
    ).toEqual({ url: 'https://x.com/a/status/1', site: 'x', title: 'X', author: 'Jack', handle: 'jack', text: 'hi', image: `${U}?thumb=1` });
    expect(webpagePreview({ className: 'MessageMediaWebPage', webpage: { className: 'WebPagePending' } }, U)).toBeUndefined();
  });
});
