import { describe, it, expect } from 'vitest';
import { normalizeTelegram } from './normalize.js';

describe('normalizeTelegram', () => {
  it('maps plain fields', () => {
    expect(
      normalizeTelegram({
        id: 42,
        chatId: '-1001234',
        chatTitle: 'Alpha Group',
        chatUsername: 'alphagrp',
        senderName: '@caller',
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
      text: 'CA below',
      ts: 1_757_332_800_000,
      contracts: [],
      link: 'https://t.me/alphagrp/42',
      hasAttachment: true,
    });
  });
  it('omits link for private chats', () => {
    const m = normalizeTelegram({
      id: 1,
      chatId: '-5',
      chatTitle: 'Priv',
      senderName: 'x',
      text: '',
      date: 0,
      hasMedia: false,
    });
    expect(m.link).toBeUndefined();
  });
});
