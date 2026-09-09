import { describe, it, expect } from 'vitest';
import { MessageHub } from './hub.js';
import type { FeedMessage, ServerEvent } from './types.js';

function msg(i: number, text = 'hi'): FeedMessage {
  return {
    id: `discord:${i}`,
    source: 'discord',
    chatId: 'c',
    chatName: '#c',
    author: 'a',
    text,
    ts: i,
    contracts: [],
    hasAttachment: false,
  };
}

describe('MessageHub', () => {
  it('detects contracts on push and broadcasts', () => {
    const hub = new MessageHub(10);
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message');
    expect((events[0] as any).msg.contracts).toEqual([
      { chain: 'evm', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    ]);
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
});
