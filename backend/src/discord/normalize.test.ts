import { describe, it, expect } from 'vitest';
import { normalizeDiscord } from './normalize.js';

const payload = {
  id: '111',
  channel_id: '222',
  guild_id: '333',
  author: { id: '444', username: 'degen', global_name: 'Degen' },
  member: { nick: 'DegenNick' },
  content: 'gm',
  timestamp: '2026-09-08T12:00:00.000Z',
  attachments: [{ id: '1' }],
  embeds: [{ title: 'T', description: 'D', fields: [{ name: 'n', value: 'v' }] }],
};

describe('normalizeDiscord', () => {
  it('maps a MESSAGE_CREATE payload', () => {
    const m = normalizeDiscord(payload, { name: 'alpha', guildName: 'Trenches' });
    expect(m).toEqual({
      id: 'discord:111',
      source: 'discord',
      chatId: '222',
      chatName: '#alpha (Trenches)',
      author: 'DegenNick',
      text: 'gm\nT\nD\nv',
      ts: Date.parse('2026-09-08T12:00:00.000Z'),
      contracts: [],
      link: 'https://discord.com/channels/333/222/111',
      hasAttachment: true,
    });
  });
  it('falls back through nick -> global_name -> username', () => {
    expect(normalizeDiscord({ ...payload, member: undefined }, { name: 'a', guildName: 'g' }).author).toBe('Degen');
    expect(
      normalizeDiscord({ ...payload, member: undefined, author: { id: '1', username: 'u' } }, { name: 'a', guildName: 'g' })
        .author,
    ).toBe('u');
  });
  it('handles missing embeds/attachments', () => {
    const m = normalizeDiscord({ ...payload, embeds: undefined, attachments: undefined }, { name: 'a', guildName: 'g' });
    expect(m.text).toBe('gm');
    expect(m.hasAttachment).toBe(false);
  });
});
