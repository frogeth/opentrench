import { describe, expect, it } from 'vitest';
import type { WatchedChat } from './api';
import { chatKey } from './components/ColumnEditor';
import { displayChatName, normTg, platformChatNames, watchKeyOf } from './feedKeys';

const chat = (source: WatchedChat['source'], id: string, name: string): WatchedChat => ({ id, name, source });

describe('normTg', () => {
  it('strips the sign and the 100 supergroup marker only when a real channel id follows', () => {
    expect(normTg('-1001234567890')).toBe('1234567890');
    expect(normTg('1001234567890')).toBe('1234567890');
    expect(normTg('-123456')).toBe('123456');
    // '100…' that is too short to be a marked supergroup id is an id in its own right
    expect(normTg('1004567')).toBe('1004567');
  });
});

describe('watchKeyOf', () => {
  it('uses a plugin chat id as the whole key', () => {
    expect(watchKeyOf({ source: 'plugin', chatId: 'plugin:hello-feed:notes' })).toBe('plugin:hello-feed:notes');
  });
  it('normalises the telegram id and prefixes the source', () => {
    expect(watchKeyOf({ source: 'telegram', chatId: '-1001234567890' })).toBe('telegram:1234567890');
    expect(watchKeyOf({ source: 'telegram', chatId: '1234567890' })).toBe('telegram:1234567890');
  });
  it('prefixes a discord id as it stands', () => {
    expect(watchKeyOf({ source: 'discord', chatId: '987' })).toBe('discord:987');
  });
});

describe('platformChatNames', () => {
  it('collects the names the platforms have taken and leaves the plugins out', () => {
    const names = platformChatNames([chat('telegram', '1', 'Alpha'), chat('discord', '2', 'Beta'), chat('plugin', 'plugin:p:c', 'Gamma')]);
    expect([...names].sort()).toEqual(['Alpha', 'Beta']);
  });
});

describe('displayChatName', () => {
  const taken = platformChatNames([chat('telegram', '1', 'Alpha')]);
  it('marks a plugin chat only when a platform chat already has the name', () => {
    expect(displayChatName(chat('plugin', 'plugin:p:a', 'Alpha'), taken)).toBe('Alpha (plugin)');
    expect(displayChatName(chat('plugin', 'plugin:p:b', 'Solo'), taken)).toBe('Solo');
  });
  it('never marks a platform chat, even one sharing the name', () => {
    expect(displayChatName(chat('telegram', '1', 'Alpha'), taken)).toBe('Alpha');
    expect(displayChatName(chat('discord', '2', 'Alpha'), taken)).toBe('Alpha');
  });
});

describe('chatKey', () => {
  it('is the plugin chat id itself, and <source>:<id> for the platforms', () => {
    expect(chatKey(chat('plugin', 'plugin:hello-feed:notes', 'Notes'))).toBe('plugin:hello-feed:notes');
    expect(chatKey(chat('telegram', '1234567890', 'Alpha'))).toBe('telegram:1234567890');
    expect(chatKey(chat('discord', '987', 'Beta'))).toBe('discord:987');
  });
});
