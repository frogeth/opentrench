import { describe, it, expect } from 'vitest';
import { normalizeDiscord } from './normalize.js';

const payload = {
  id: '111',
  channel_id: '222',
  guild_id: '333',
  author: { id: '444', username: 'degen', global_name: 'Degen', avatar: 'abc123' },
  member: { nick: 'DegenNick', avatar: 'guildhash' },
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
      avatar: 'https://cdn.discordapp.com/guilds/333/users/444/avatars/guildhash.png?size=64',
      isBot: false,
      text: 'gm\nT\nD\nv',
      ts: Date.parse('2026-09-08T12:00:00.000Z'),
      contracts: [],
      repeat: false,
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
  it('uses the user avatar, then a default avatar', () => {
    const user = normalizeDiscord({ ...payload, member: { nick: 'x' } }, { name: 'a', guildName: 'g' });
    expect(user.avatar).toBe('https://cdn.discordapp.com/avatars/444/abc123.png?size=64');
    const none = normalizeDiscord(
      { ...payload, member: undefined, author: { id: '29360128', username: 'u' } },
      { name: 'a', guildName: 'g' },
    );
    expect(none.avatar).toBe('https://cdn.discordapp.com/embed/avatars/1.png');
  });
  it('flags bot authors', () => {
    const m = normalizeDiscord({ ...payload, author: { ...payload.author, bot: true } }, { name: 'a', guildName: 'g' });
    expect(m.isBot).toBe(true);
  });
});
