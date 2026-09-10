import { describe, it, expect } from 'vitest';
import { discordEmbeds, discordMedia, discordPreviews, discordReaction, normalizeDiscord } from './normalize.js';

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
      body: 'gm',
      embeds: [{ title: 'T', description: 'D', fields: [{ name: 'n', value: 'v', inline: false }] }],
      ts: Date.parse('2026-09-08T12:00:00.000Z'),
      contracts: [],
      repeat: false,
      link: 'https://discord.com/channels/333/222/111',
      hasAttachment: true,
      media: [],
      previews: [],
    });
  });
  it('extracts media from attachments, gif embeds, stickers and bare links', () => {
    const d = {
      content: 'lol https://media.discordapp.net/attachments/1/2/thing.gif?ex=1 and https://i.imgur.com/a.png',
      attachments: [
        { url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', proxy_url: 'https://media.discordapp.net/attachments/1/2/pic.png', content_type: 'image/png' },
        { url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', content_type: 'video/mp4' },
        { url: 'https://cdn.discordapp.com/attachments/1/2/doc.pdf', content_type: 'application/pdf' },
      ],
      embeds: [{ type: 'gifv', url: 'https://tenor.com/view/x', video: { url: 'https://media.tenor.com/x.mp4' }, thumbnail: { url: 'https://media.tenor.com/x.png' } }],
      sticker_items: [{ id: '9', name: 'pepe', format_type: 1 }, { id: '10', name: 'lot', format_type: 3 }, { id: '11', name: 'g', format_type: 4 }],
    };
    expect(discordMedia(d)).toEqual([
      { kind: 'image', url: 'https://media.discordapp.net/attachments/1/2/pic.png', mime: 'image/png' },
      { kind: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', mime: 'video/mp4' },
      { kind: 'gif', url: 'https://media.tenor.com/x.mp4', poster: 'https://media.tenor.com/x.png' },
      { kind: 'sticker', url: 'https://media.discordapp.net/stickers/9.png?size=160' },
      { kind: 'sticker', url: 'https://media.discordapp.net/stickers/11.gif?size=160' },
      { kind: 'gif', url: 'https://media.discordapp.net/attachments/1/2/thing.gif?ex=1' },
      { kind: 'image', url: 'https://i.imgur.com/a.png' },
    ]);
  });
  it('turns a tweet embed into a preview', () => {
    const d = {
      embeds: [
        { type: 'rich', url: 'https://x.com/jack/status/20', description: 'just setting up my twttr', author: { name: 'jack (@jack)', icon_url: 'https://pbs/av.jpg' }, thumbnail: { url: 'https://pbs/img.jpg' } },
        { type: 'rich', url: 'https://example.com', description: 'not a tweet' },
      ],
    };
    expect(discordPreviews(d)).toEqual([
      { url: 'https://x.com/jack/status/20', site: 'x', author: 'jack', handle: 'jack', text: 'just setting up my twttr', image: 'https://pbs/img.jpg', avatar: 'https://pbs/av.jpg' },
    ]);
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
  it('carries reply context from referenced_message', () => {
    const m = normalizeDiscord(
      { ...payload, referenced_message: { id: '99', author: { username: 'og', global_name: 'OG' }, content: 'first call' } },
      { name: 'a', guildName: 'g' },
    );
    expect(m.replyTo).toEqual({ author: 'OG', text: 'first call', id: 'discord:99' });
    expect(normalizeDiscord(payload, { name: 'a', guildName: 'g' }).replyTo).toBeUndefined();
  });
  it('maps unicode and custom reactions', () => {
    expect(discordReaction({ id: null, name: '🔥' })).toEqual({ key: '🔥', name: '🔥' });
    expect(discordReaction({ id: '42', name: 'pepe', animated: true })).toEqual({
      key: 'custom:42',
      name: 'pepe',
      imageUrl: 'https://cdn.discordapp.com/emojis/42.gif?size=32',
    });
  });
  it('keeps rich embeds structured, skipping media and tweet unfurls', () => {
    const embeds = discordEmbeds({
      embeds: [
        {
          type: 'rich',
          title: '$babybaton · baby baton',
          url: 'https://dexscreener.com/solana/FJHv',
          description: '**Called** in Potion',
          color: 0x3ddc84,
          author: { name: 'Captain Hook', icon_url: 'https://cdn/x.png' },
          fields: [
            { name: 'MC', value: '$118K', inline: true },
            { name: 'Links', value: '[X](https://x.com/a) · [Dex](https://dexscreener.com/b)' },
          ],
          thumbnail: { url: 'https://cdn/thumb.png' },
          footer: { text: 'Potion' },
          timestamp: '2026-09-09T22:58:00.000Z',
        },
        { type: 'gifv', url: 'https://tenor.com/x', video: { url: 'https://media.tenor.com/x.mp4' } },
        { type: 'link', url: 'https://x.com/a/status/1', description: 'tweet', author: { name: 'A (@a)' } },
        { type: 'rich' },
      ],
    });
    expect(embeds).toEqual([
      {
        title: '$babybaton · baby baton',
        url: 'https://dexscreener.com/solana/FJHv',
        description: '**Called** in Potion',
        color: '#3ddc84',
        author: { name: 'Captain Hook', icon: 'https://cdn/x.png' },
        fields: [
          { name: 'MC', value: '$118K', inline: true },
          { name: 'Links', value: '[X](https://x.com/a) · [Dex](https://dexscreener.com/b)', inline: false },
        ],
        thumbnail: 'https://cdn/thumb.png',
        footer: 'Potion',
        timestamp: Date.parse('2026-09-09T22:58:00.000Z'),
      },
    ]);
  });
  it('flags bot authors', () => {
    const m = normalizeDiscord({ ...payload, author: { ...payload.author, bot: true } }, { name: 'a', guildName: 'g' });
    expect(m.isBot).toBe(true);
  });
  it('does not treat webhook posts as bots (alert channels are callers)', () => {
    const m = normalizeDiscord(
      { ...payload, member: undefined, webhook_id: '777', author: { ...payload.author, bot: true, username: 'Alerts', global_name: undefined } },
      { name: 'a', guildName: 'g' },
    );
    expect(m.isBot).toBe(false);
    expect(m.author).toBe('Alerts');
  });
});
