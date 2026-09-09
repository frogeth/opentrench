import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordGateway, type WsLike } from './gateway.js';

class FakeWs implements WsLike {
  sent: any[] = [];
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  closed?: number;
  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code;
    this.fire('close', code ?? 1000);
  }
  on(ev: string, fn: (...a: any[]) => void) {
    (this.handlers[ev] ??= []).push(fn);
  }
  fire(ev: string, ...a: any[]) {
    for (const h of this.handlers[ev] ?? []) h(...a);
  }
  recv(obj: any) {
    this.fire('message', JSON.stringify(obj));
  }
}

function setup() {
  const sockets: FakeWs[] = [];
  const gw = new DiscordGateway('tok', {
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
  });
  const states: string[] = [];
  gw.on('state', (s) => states.push(s));
  return { gw, sockets, states };
}

const READY = {
  op: 0,
  t: 'READY',
  s: 1,
  d: {
    session_id: 'sess',
    resume_gateway_url: 'wss://resume.example',
    guilds: [
      {
        id: 'g1',
        properties: { name: 'Guild One' },
        channels: [
          { id: 'c1', name: 'alpha', type: 0 },
          { id: 'c2', name: 'voice', type: 2 },
          { id: 'c3', name: 'news', type: 5 },
        ],
      },
    ],
  },
};

describe('DiscordGateway', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('identifies after HELLO and heartbeats on the interval', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(ws.sent[0].op).toBe(2);
    expect(ws.sent[0].d.token).toBe('tok');
    vi.advanceTimersByTime(1000);
    expect(ws.sent.at(-1)).toEqual({ op: 1, d: null });
  });

  it('extracts text channels from READY and reports connected', () => {
    const { gw, sockets, states } = setup();
    const channels: any[] = [];
    gw.on('channels', (c) => channels.push(...c));
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    expect(channels).toEqual([
      { id: 'c1', name: 'alpha', guildName: 'Guild One' },
      { id: 'c3', name: 'news', guildName: 'Guild One' },
    ]);
    expect(states.at(-1)).toBe('connected');
  });

  it('emits MESSAGE_CREATE payloads', () => {
    const { gw, sockets } = setup();
    const msgs: any[] = [];
    gw.on('message', (m) => msgs.push(m));
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1', channel_id: 'c1', content: 'x' } });
    expect(msgs).toEqual([{ id: 'm1', channel_id: 'c1', content: 'x' }]);
  });

  it('reconnects with RESUME after a non-fatal close', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    ws.fire('close', 1006);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe('wss://resume.example/?v=10&encoding=json');
    sockets[1].fire('open');
    sockets[1].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(sockets[1].sent[0]).toEqual({ op: 6, d: { token: 'tok', session_id: 'sess', seq: 1 } });
  });

  it('closes and reconnects when a heartbeat ACK is missed', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    vi.advanceTimersByTime(1000); // heartbeat 1 sent, no ack
    vi.advanceTimersByTime(1000); // zombie detected
    expect(ws.closed).toBe(4000);
    vi.advanceTimersByTime(1000); // backoff
    expect(sockets).toHaveLength(2);
  });

  it('stops with auth_error on close 4004', () => {
    const { gw, sockets, states } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.fire('close', 4004);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('auth_error');
  });

  it('re-identifies after INVALID_SESSION', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    ws.recv({ op: 9, d: false });
    vi.advanceTimersByTime(5000);
    const ws2 = sockets[1];
    ws2.fire('open');
    ws2.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(ws2.sent[0].op).toBe(2);
  });
});
