import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiscordBridge } from './bridge.js';

/** A fake plugin socket: what we send it is recorded; `recv` plays a message from the plugin. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  recv(obj: unknown) {
    this.emit('message', JSON.stringify(obj));
  }
}

const HELLO = {
  t: 'hello',
  version: 1,
  user: { id: '42', username: 'frog', globalName: 'frog.eth' },
  guilds: [
    {
      id: 'g1',
      name: 'Trenches',
      icon: 'https://cdn/icon.png',
      roles: [{ id: 'r1', name: 'Degens' }],
      myRoles: ['r1'],
      channels: [
        { id: 'c1', name: 'alpha-calls', type: 0, position: 3, category: 'CALLS' },
        { id: 'c2', name: 'news', type: 5, position: 0 },
      ],
    },
  ],
};

describe('DiscordBridge', () => {
  it('learns who we are and the channel list from hello, then tells the plugin what to watch', () => {
    const b = new DiscordBridge();
    const states: string[] = [];
    b.on('state', (s) => states.push(s));
    const ws = new FakeSocket();
    b.watch(['c1']);
    b.accept(ws as any);
    ws.recv(HELLO);
    expect(states).toEqual(['connecting', 'connected']);
    expect(b.self).toEqual({ id: '42', username: 'frog.eth', roles: new Map([['g1', ['r1']]]) });
    expect([...b.channels.values()]).toEqual([
      { id: 'c1', name: 'alpha-calls', guildId: 'g1', guildName: 'Trenches', guildIcon: 'https://cdn/icon.png', category: 'CALLS', position: 3 },
      { id: 'c2', name: 'news', guildId: 'g1', guildName: 'Trenches', guildIcon: 'https://cdn/icon.png', category: undefined, position: 0 },
    ]);
    expect(b.roles.get('g1')?.get('r1')).toBe('Degens');
    expect(ws.sent).toEqual([{ t: 'watch', channels: ['c1'] }]);
  });

  it('relays messages and reactions, and round-trips requests by id', async () => {
    const b = new DiscordBridge();
    const ws = new FakeSocket();
    b.accept(ws as any);
    ws.recv(HELLO);
    const got: any[] = [];
    b.on('message', (d) => got.push(['message', d.id]));
    b.on('reaction', (d, delta) => got.push(['reaction', d.message_id, delta]));
    ws.recv({ t: 'message', d: { id: 'm1', channel_id: 'c1' } });
    ws.recv({ t: 'reaction', delta: -1, d: { channel_id: 'c1', message_id: 'm1', emoji: { name: '🔥' } } });
    expect(got).toEqual([
      ['message', 'm1'],
      ['reaction', 'm1', -1],
    ]);
    const p = b.request('send', { channelId: 'c1', content: 'gm' });
    const req = ws.sent.at(-1);
    expect(req).toMatchObject({ t: 'req', op: 'send', channelId: 'c1', content: 'gm' });
    ws.recv({ t: 'reply', id: req.id, ok: true, result: { id: 'm2' } });
    await expect(p).resolves.toEqual({ id: 'm2' });
    const p2 = b.request('react', {});
    ws.recv({ t: 'reply', id: ws.sent.at(-1).id, ok: false, error: 'nope' });
    await expect(p2).rejects.toThrow('nope');
  });

  it('rejects requests when the client is gone and fails the ones in flight on disconnect', async () => {
    const b = new DiscordBridge();
    await expect(b.request('send')).rejects.toThrow(/isn’t connected/);
    const ws = new FakeSocket();
    b.accept(ws as any);
    ws.recv(HELLO);
    const p = b.request('history', { channelId: 'c1' });
    ws.close();
    await expect(p).rejects.toThrow(/disconnected/);
    expect(b.state).toBe('disconnected');
  });

  it('a second client replaces the first', () => {
    const b = new DiscordBridge();
    const a = new FakeSocket();
    const c = new FakeSocket();
    b.accept(a as any);
    b.accept(c as any);
    expect(a.readyState).toBe(3);
    a.emit('close'); // the old socket closing must not flip state
    expect(b.state).toBe('connecting');
  });
});
