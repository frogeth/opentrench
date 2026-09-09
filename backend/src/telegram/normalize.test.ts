import { describe, it, expect } from 'vitest';
import { mapTelegramReactions, normalizeTelegram } from './normalize.js';

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
