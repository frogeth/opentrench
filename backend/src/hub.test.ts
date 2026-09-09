import { describe, it, expect } from 'vitest';
import { MessageHub } from './hub.js';
import type { FeedMessage, ServerEvent, TokenInfo } from './types.js';

const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function msg(i: number, text = 'hi', extra: Partial<FeedMessage> = {}): FeedMessage {
  return {
    id: `discord:${i}`,
    source: 'discord',
    chatId: 'c',
    chatName: '#c',
    author: 'a',
    isBot: false,
    text,
    ts: i,
    contracts: [],
    repeat: false,
    hasAttachment: false,
    ...extra,
  };
}

function tokensOf(events: ServerEvent[]): TokenInfo[] {
  return events.filter((e) => e.type === 'token').map((e) => (e as any).token);
}

describe('MessageHub', () => {
  it('detects contracts on push and broadcasts', () => {
    const hub = new MessageHub(10);
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, EVM));
    const m = events.find((e) => e.type === 'message') as any;
    expect(m.msg.contracts).toEqual([{ chain: 'evm', address: EVM }]);
  });

  it('caps the buffer', () => {
    const hub = new MessageHub(3);
    for (let i = 0; i < 5; i++) hub.push(msg(i));
    expect(hub.hello().messages.map((m) => m.id)).toEqual(['discord:2', 'discord:3', 'discord:4']);
  });

  it('tracks status and broadcasts it', () => {
    const hub = new MessageHub();
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.setStatus('discord', 'auth_error', 'bad token');
    hub.setStatus('telegram', 'connected');
    expect(hub.hello().status).toEqual({
      discord: 'auth_error',
      telegram: 'connected',
      loginStep: 'idle',
      error: { discord: 'bad token' },
    });
    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
  });

  it('clears the error when a source recovers', () => {
    const hub = new MessageHub();
    hub.setStatus('discord', 'auth_error', 'bad');
    hub.setStatus('discord', 'connected');
    expect(hub.hello().status.error).toEqual({});
  });

  it('counts one call per chat and flags repeats within a chat', () => {
    const hub = new MessageHub();
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, `ca ${EVM}`, { chatId: 'a', chatName: '#a' }));
    hub.push(msg(2, `again ${EVM}`, { chatId: 'a', chatName: '#a' }));
    hub.push(msg(3, `${EVM} and ${SOL}`, { chatId: 'b', chatName: 'B group' }));
    hub.push(msg(4, `${EVM}`, { chatId: 'b', chatName: 'B group' }));
    const msgs = events.filter((e) => e.type === 'message').map((e) => (e as any).msg as FeedMessage);
    expect(msgs.map((m) => m.repeat)).toEqual([false, true, false, true]);
    const toks = tokensOf(events);
    expect(toks.map((t) => [t.address, t.seen])).toEqual([
      [EVM, 1],
      [EVM, 1],
      [EVM, 2],
      [SOL, 1],
      [EVM, 2],
    ]);
    expect(hub.hello().tokens.map((t) => [t.address, t.seen, t.calledIn, t.firstSeenTs])).toEqual([
      [EVM, 2, ['#a', 'B group'], 1],
      [SOL, 1, ['B group'], 3],
    ]);
  });

  it('merges link metadata; bot posts override, humans only fill gaps', () => {
    const hub = new MessageHub();
    hub.push(msg(1, EVM, { isBot: false }), { website: 'https://human.example', name: 'Human' });
    hub.push(msg(2, EVM, { isBot: false }), { website: 'https://other.example', twitter: 'https://x.com/h' });
    let t = hub.hello().tokens[0];
    expect(t).toMatchObject({ website: 'https://human.example', twitter: 'https://x.com/h', name: 'Human' });
    hub.push(msg(3, EVM, { isBot: true }), { website: 'https://rick.example', symbol: 'RCK' });
    t = hub.hello().tokens[0];
    expect(t).toMatchObject({ website: 'https://rick.example', symbol: 'RCK', name: 'Human' });
  });

  it('enriches new tokens through the fetcher without overriding socials', async () => {
    const calls: string[] = [];
    const hub = new MessageHub(500, async (addr) => {
      calls.push(addr);
      return { priceUsd: 1.5, marketCap: 100, website: 'https://dex.example', symbol: 'DEX' };
    });
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, EVM, { isBot: true }), { website: 'https://rick.example' });
    hub.push(msg(2, EVM));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([EVM]);
    const t = hub.hello().tokens[0];
    expect(t).toMatchObject({ priceUsd: 1.5, marketCap: 100, website: 'https://rick.example', symbol: 'DEX' });
    expect(tokensOf(events).at(-1)?.priceUsd).toBe(1.5);
  });

  it('survives a failing fetcher', async () => {
    const hub = new MessageHub(500, async () => {
      throw new Error('boom');
    });
    hub.push(msg(1, EVM));
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.hello().tokens[0].seen).toBe(1);
  });
});
