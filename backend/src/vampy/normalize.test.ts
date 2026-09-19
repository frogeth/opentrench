import { describe, expect, it } from 'vitest';
import { callToFeed, channelFor, chatNameOf, feedLink, messageToFeed, parseFeeds, rowToFeed, type VampyFeed } from './normalize.js';
import { contractsOf } from '../scanpost.js';

const CALLS: VampyFeed = { id: '7c4e1f2a', title: 'Alpha calls', type: 'call', channels: [{ channelId: '1234567890', serverId: '9876543210', channelName: 'calls', serverName: 'Some Alpha Group' }] };
const CHAT: VampyFeed = { id: 'feed-2', title: 'Alpha chat', type: 'message', channels: [] };

// shapes from the Vampy API doc (2026-09-19)
const CALL = {
  id: 0,
  platform: 'discord',
  server_external_id: '9876543210',
  channel_external_id: '1234567890',
  caller_external_id: '4242',
  message_external_id: '1415926535897932384',
  chain: 'solana',
  token_address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  token_symbol: 'BONK',
  token_name: 'Bonk',
  price_at_call: 0.0000213,
  market_cap_at_call: 1_840_000,
  timestamp: '2026-09-19T14:02:11.000Z',
  is_first_call: true,
  dex_paid: false,
  dividend_tokens: [],
  caller_username: 'degen',
  caller_display_name: 'Degen Dave',
  caller_avatar_url: 'https://cdn.discordapp.com/avatars/4242/abc.png',
  socials: { website: 'https://bonkcoin.com', twitter: 'https://x.com/bonk_inu', telegram: 'https://t.me/bonk' },
  volume_usd: '12345.6',
};

const MESSAGE = {
  id: 991,
  external_id: '1415926535897932000',
  platform: 'discord',
  server_external_id: '9876543210',
  channel_external_id: '1234567890',
  caller_external_id: '4242',
  attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', content_type: 'image/png' }],
  embeds: [],
  contains_call: false,
  edited: false,
  is_bot: false,
  timestamp: '2026-09-19T14:03:00.000Z',
  inserted_at: '2026-09-19T14:03:01.000Z',
  author_role_ids: [],
  mentions: [],
  content: 'gm **chat** @Degen Dave look at this',
  author_username: 'alice',
  author_display_name: 'Alice',
  author_avatar_url: 'https://cdn.discordapp.com/avatars/1/a.png',
  reply_to: { external_id: '1415926535897931000', content: 'anyone in?', author_caller_external_id: '7', author_display_name: 'Bob' },
};

describe('parseFeeds', () => {
  it('keeps call and message feeds with their channels, skips junk', () => {
    const out = parseFeeds({
      data: [
        { id: '7c4e1f2a', title: 'Alpha calls', type: 'call', channels: [{ channel_external_id: '1234567890', server_external_id: '9876543210', channel_name: 'calls', server_name: 'Some Alpha Group' }], filters: { exclude_bots: true } },
        { id: 'feed-2', title: '  Alpha\tchat ', type: 'message', channels: [] },
        { id: 'feed-3', title: 'nope', type: 'other' },
        { id: 'bad id!', title: 'x', type: 'call' },
        { id: '7c4e1f2a', title: 'dupe', type: 'call' },
        'junk',
      ],
    });
    expect(out).toEqual([CALLS, { id: 'feed-2', title: 'Alpha chat', type: 'message', channels: [] }]);
    expect(parseFeeds('garbage')).toEqual([]);
    expect(parseFeeds({ data: [{ id: 'f', type: 'call' }] })[0].title).toBe('Vampy calls');
  });
});

describe('feedLink', () => {
  it('builds Discord and Telegram links and refuses anything else', () => {
    expect(feedLink('discord', '9876543210', '1234567890', '55')).toBe('https://discord.com/channels/9876543210/1234567890/55');
    expect(feedLink('discord', undefined, '1234567890', '55')).toBe('https://discord.com/channels/@me/1234567890/55');
    expect(feedLink('telegram', undefined, '-1001234567890', '77')).toBe('https://t.me/c/1234567890/77');
    expect(feedLink('telegram', undefined, '1234567890', '77')).toBe('https://t.me/c/1234567890/77');
    expect(feedLink('discord', '1', 'javascript:alert(1)', '55')).toBeUndefined();
    expect(feedLink('discord', '1', '2', 'x')).toBeUndefined();
    expect(feedLink('slack', '1', '2', '3')).toBeUndefined();
  });
});

describe('callToFeed', () => {
  it('turns a call into a message the contract detector registers, with meta and the market cap', () => {
    const row = callToFeed(CALLS, CALL)!;
    expect(row.msg).toMatchObject({
      id: `vampy:7c4e1f2a:1234567890:1415926535897932384:${CALL.token_address}`,
      source: 'vampy',
      chatId: '7c4e1f2a',
      chatName: 'Alpha calls (Vampy)',
      author: 'Degen Dave',
      avatar: CALL.caller_avatar_url,
      isBot: false,
      ts: Date.parse('2026-09-19T14:02:11.000Z'),
      link: 'https://discord.com/channels/9876543210/1234567890/1415926535897932384',
      hasAttachment: false,
      repeat: false,
    });
    expect(row.msg.text).toBe(`$BONK ${CALL.token_address}\ncalled at $1.8M mc`);
    expect(contractsOf(row.msg.text, false)).toEqual([{ chain: 'sol', address: CALL.token_address }]);
    expect(row.meta).toEqual({ name: 'Bonk', symbol: 'BONK', website: 'https://bonkcoin.com', twitter: 'https://x.com/bonk_inu', telegram: 'https://t.me/bonk' });
    expect(row.marketCap).toBe(1_840_000);
  });
  it('lives without the optional fields and keys the same call the same way twice', () => {
    const bare = { platform: 'telegram', channel_external_id: '-100777', message_external_id: '12', caller_external_id: '123456789', token_address: '0x' + 'ab'.repeat(20), timestamp: '2026-09-19T14:02:11.000Z', caller_is_bot: true };
    const a = callToFeed(CALLS, bare)!;
    const b = callToFeed(CALLS, { ...bare, id: 5 })!;
    expect(a.msg.id).toBe(b.msg.id);
    expect(a.msg.author).toBe('user 456789');
    expect(a.msg.isBot).toBe(true);
    expect(a.msg.text).toBe('0x' + 'ab'.repeat(20));
    expect(a.msg.link).toBe('https://t.me/c/777/12');
    expect(a.meta).toBeUndefined();
    expect(a.marketCap).toBeUndefined();
    expect(callToFeed(CALLS, { ...bare, market_cap_at_call: '0' })!.marketCap).toBeUndefined();
    expect(callToFeed(CALLS, { ...bare, market_cap_at_call: '25000' })!.marketCap).toBe(25000);
    expect(callToFeed(CALLS, { ...bare, token_address: '' })).toBeUndefined();
    expect(callToFeed(CALLS, { ...bare, message_external_id: undefined })).toBeUndefined();
    expect(callToFeed(CALLS, null)).toBeUndefined();
  });
  it('strips controls from names and refuses non-https avatars', () => {
    const row = callToFeed(CALLS, { ...CALL, caller_display_name: 'Ev\u202Eil\u0000', caller_avatar_url: 'http://cdn.discordapp.com/a.png', token_symbol: '$PEPE' })!;
    expect(row.msg.author).toBe('Ev il');
    expect(row.msg.avatar).toBeUndefined();
    expect(row.msg.text.startsWith('$PEPE ')).toBe(true);
    expect(row.meta?.symbol).toBe('PEPE');
  });
});

describe('messageToFeed', () => {
  it('keeps the Discord markdown, the reply, the media and the link', () => {
    const m = messageToFeed(CHAT, MESSAGE)!;
    expect(m).toMatchObject({
      id: 'vampy:feed-2:1234567890:1415926535897932000',
      source: 'vampy',
      chatId: 'feed-2',
      chatName: 'Alpha chat (Vampy)',
      author: 'Alice',
      avatar: MESSAGE.author_avatar_url,
      isBot: false,
      text: 'gm **chat** @Degen Dave look at this',
      ts: Date.parse('2026-09-19T14:03:00.000Z'),
      link: 'https://discord.com/channels/9876543210/1234567890/1415926535897932000',
      hasAttachment: true,
      replyTo: { author: 'Bob', text: 'anyone in?', id: 'vampy:feed-2:1234567890:1415926535897931000' },
    });
    expect(m.media).toEqual([{ kind: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', mime: 'image/png' }]);
    expect(m.mention).toBeUndefined();
    expect(m.embeds).toBeUndefined();
    expect(m.body).toBeUndefined();
  });
  it('reads attachments and embeds serialized as JSON strings, and flattens embeds into the text', () => {
    const m = messageToFeed(CHAT, {
      ...MESSAGE,
      content: 'scan',
      attachments: '[]',
      embeds: JSON.stringify([{ title: 'Bonk', description: 'MC $1.8M', fields: [{ name: 'CA', value: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }], color: 5793266 }]),
    })!;
    expect(m.text).toBe('scan\nBonk\nMC $1.8M\nDezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(m.body).toBe('scan');
    expect(m.embeds).toHaveLength(1);
    expect(m.embeds![0]).toMatchObject({ title: 'Bonk', description: 'MC $1.8M', color: '#5865f2' });
    expect(m.hasAttachment).toBe(false);
  });
  it('falls back to db_id, keeps Telegram rows apart by channel, drops empty and malformed rows', () => {
    const tg = { platform: 'telegram', channel_external_id: '-1001234567890', db_id: 42, content: 'hi', timestamp: '2026-09-19T14:03:00.000Z', author_username: 'carol', is_bot: true, thread_name: 'General' };
    const m = messageToFeed(CHAT, tg)!;
    expect(m.id).toBe('vampy:feed-2:-1001234567890:42');
    expect(m.link).toBe('https://t.me/c/1234567890/42');
    expect(m.author).toBe('carol');
    expect(m.isBot).toBe(true);
    expect(m.authorTag).toBe('General');
    expect(messageToFeed(CHAT, { ...tg, channel_external_id: '-1009999' })!.id).toBe('vampy:feed-2:-1009999:42');
    expect(messageToFeed(CHAT, { ...tg, content: '   ' })).toBeUndefined();
    expect(messageToFeed(CHAT, { ...tg, db_id: undefined })).toBeUndefined();
    expect(messageToFeed(CHAT, 'junk')).toBeUndefined();
  });
  it('keeps a deleted message as delivered', () => {
    const m = messageToFeed(CHAT, { ...MESSAGE, content: 'oops\n-# (deleted)' })!;
    expect(m.text).toBe('oops\n-# (deleted)');
  });
});

describe('rowToFeed / names', () => {
  it('dispatches on the feed type', () => {
    expect(rowToFeed(CALLS, CALL)?.marketCap).toBe(1_840_000);
    expect(rowToFeed(CHAT, MESSAGE)?.msg.author).toBe('Alice');
    expect(rowToFeed(CHAT, {})).toBeUndefined();
  });
  it('names the chat and the realtime channel', () => {
    expect(chatNameOf(CALLS)).toBe('Alpha calls (Vampy)');
    expect(channelFor('5b1d', '7c4e1f2a')).toBe('private-user-5b1d-feed-7c4e1f2a');
  });
});

describe('untrusted fields', () => {
  it('drops attachment and embed urls that are not https before the Discord normalizer sees them', () => {
    const m = messageToFeed(CHAT, {
      ...MESSAGE,
      content: 'look',
      attachments: [
        { url: 'javascript:alert(1)', content_type: 'image/png' },
        { url: 'http://cdn.discordapp.com/attachments/1/2/plain.png', content_type: 'image/png' },
        { proxy_url: 'https://media.discordapp.net/attachments/1/2/ok.png', content_type: 'image/png' },
        'junk',
      ],
      embeds: [
        { title: 'card', url: 'javascript:void(0)', author: { name: 'bot', url: 'data:text/html,x', icon_url: 'http://x/i.png' }, image: { url: 'javascript:1' }, thumbnail: { proxy_url: 'https://cdn.discordapp.com/t.png' }, fields: [{ name: 'a', value: 'b' }] },
      ],
    })!;
    expect(m.media).toEqual([{ kind: 'image', url: 'https://media.discordapp.net/attachments/1/2/ok.png', mime: 'image/png' }]);
    expect(m.embeds).toHaveLength(1);
    expect(m.embeds![0]).toMatchObject({ title: 'card', author: { name: 'bot' }, thumbnail: 'https://cdn.discordapp.com/t.png' });
    expect(m.embeds![0].url).toBeUndefined();
    expect(m.embeds![0].author?.url).toBeUndefined();
    expect(m.embeds![0].author?.icon).toBeUndefined();
    expect(m.embeds![0].image).toBeUndefined();
    expect(m.hasAttachment).toBe(true);
  });
  it('bounds platform ids and keeps a token name out of the call text', () => {
    // an id that is not one is skipped as a key: the row falls back to the next id it carries, or is dropped
    expect(messageToFeed(CHAT, { ...MESSAGE, external_id: 'x'.repeat(41) })!.id).toBe('vampy:feed-2:1234567890:991');
    expect(messageToFeed(CHAT, { ...MESSAGE, external_id: '1 OR 1', id: undefined })).toBeUndefined();
    expect(messageToFeed(CHAT, { ...MESSAGE, channel_external_id: 'a/b' })!.id).toBe('vampy:feed-2::1415926535897932000');
    expect(callToFeed(CALLS, { ...CALL, message_external_id: 'nope!' })).toBeUndefined();
    expect(callToFeed(CALLS, { ...CALL, token_address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 extra' })).toBeUndefined();
    const evm = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const row = callToFeed(CALLS, { ...CALL, token_symbol: '', token_name: `Pepe ${evm}` })!;
    expect(row.msg.text).toBe(`${CALL.token_address}\ncalled at $1.8M mc`);
    expect(contractsOf(row.msg.text, false)).toEqual([{ chain: 'sol', address: CALL.token_address }]);
    expect(row.meta?.name).toBe(`Pepe ${evm}`);
    expect(callToFeed(CALLS, { ...CALL, token_symbol: 'BO NK' })!.msg.text.startsWith('$BONK ')).toBe(true);
  });
});
