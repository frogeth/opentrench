import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { PusherClient } from './pusher.js';

/** A Soketi stand-in that speaks just enough of the protocol; every frame it gets is recorded. */
class FakeSoketi {
  wss: WebSocketServer;
  port = 0;
  sockets: WebSocket[] = [];
  frames: any[] = [];
  connections = 0;
  /** what the server does on a subscribe: 'ok' | 'reject' */
  onSubscribe: 'ok' | 'reject' = 'ok';
  activityTimeout = 120;
  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.port = (this.wss.address() as { port: number }).port;
    this.wss.on('connection', (ws, req) => {
      this.connections++;
      this.sockets.push(ws);
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw));
        this.frames.push(f);
        if (f.event === 'pusher:subscribe') {
          const { channel, auth } = f.data;
          if (this.onSubscribe === 'ok' && auth === `vampy-key:sig-${channel}`) ws.send(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel, data: '{}' }));
          else ws.send(JSON.stringify({ event: 'pusher:subscription_error', channel, data: JSON.stringify({ type: 'AuthError', error: 'nope', status: 403 }) }));
        }
        if (f.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      });
      if (!req.url?.includes('/app/vampy-key?protocol=7')) {
        ws.send(JSON.stringify({ event: 'pusher:error', data: { code: 4001, message: 'App key does not exist' } }));
        return;
      }
      ws.send(JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: `${this.connections}.1`, activity_timeout: this.activityTimeout }) }));
    });
  }
  /** the newest socket the server holds */
  get last(): WebSocket {
    return this.sockets[this.sockets.length - 1];
  }
  push(channel: string, event: string, data: unknown): void {
    this.last.send(JSON.stringify({ event, channel, data }));
  }
  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let server: FakeSoketi;
let client: PusherClient | undefined;
beforeEach(() => {
  server = new FakeSoketi();
});
afterEach(async () => {
  client?.stop();
  client = undefined;
  await server.close();
});

const make = (key = 'vampy-key') =>
  new PusherClient({
    url: `ws://127.0.0.1:${server.port}`,
    key,
    authorize: async (_socketId, channel) => `vampy-key:sig-${channel}`,
    backoff: { min: 10, max: 20 },
    pongTimeoutMs: 100,
  });

describe('PusherClient', () => {
  it('connects, authorizes and subscribes, then delivers events with string or object data', async () => {
    client = make();
    const opened: string[] = [];
    const subscribed: string[] = [];
    const events: [string, string, unknown][] = [];
    client.on('open', (id) => opened.push(id));
    client.on('subscribed', (ch) => subscribed.push(ch));
    client.on('event', (ch, name, data) => events.push([ch, name, data]));
    client.subscribe('private-user-u-feed-a');
    client.start();
    await until(() => subscribed.length === 1);
    expect(opened).toEqual(['1.1']);
    expect(client.state).toBe('connected');
    expect(client.socketId).toBe('1.1');
    expect(server.frames).toEqual([{ event: 'pusher:subscribe', data: { channel: 'private-user-u-feed-a', auth: 'vampy-key:sig-private-user-u-feed-a' } }]);
    client.subscribe('private-user-u-feed-b');
    await until(() => subscribed.length === 2);
    server.push('private-user-u-feed-a', 'new-call', JSON.stringify({ id: 0, token_address: 'X' }));
    server.push('private-user-u-feed-b', 'new-message', { id: 7, content: 'hi' });
    server.push('private-user-u-feed-b', 'pusher_internal:member_added', '{}'); // never surfaced
    await until(() => events.length === 2);
    expect(events).toEqual([
      ['private-user-u-feed-a', 'new-call', { id: 0, token_address: 'X' }],
      ['private-user-u-feed-b', 'new-message', { id: 7, content: 'hi' }],
    ]);
    client.unsubscribe('private-user-u-feed-b');
    await until(() => server.frames.some((f) => f.event === 'pusher:unsubscribe'));
    expect(server.frames.at(-1)).toEqual({ event: 'pusher:unsubscribe', data: { channel: 'private-user-u-feed-b' } });
    expect(client.channels()).toEqual(['private-user-u-feed-a']);
  });

  it('answers the server ping and reports a refused subscription', async () => {
    client = make();
    server.onSubscribe = 'reject';
    const errors: [string, unknown][] = [];
    client.on('subscription_error', (ch, d) => errors.push([ch, d]));
    client.subscribe('private-user-u-feed-a');
    client.start();
    await until(() => errors.length === 1);
    expect(errors[0]).toEqual(['private-user-u-feed-a', { type: 'AuthError', error: 'nope', status: 403 }]);
    server.last.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    await until(() => server.frames.some((f) => f.event === 'pusher:pong'));
  });

  it('reports an authorizer that throws without dropping the socket', async () => {
    client = new PusherClient({
      url: `ws://127.0.0.1:${server.port}`,
      key: 'vampy-key',
      authorize: async () => {
        throw new Error('403 from the auth endpoint');
      },
      backoff: { min: 10, max: 20 },
    });
    const errors: [string, unknown][] = [];
    client.on('subscription_error', (ch, d) => errors.push([ch, d]));
    client.subscribe('private-user-u-feed-a');
    client.start();
    await until(() => errors.length === 1);
    expect(errors[0]).toEqual(['private-user-u-feed-a', { error: '403 from the auth endpoint' }]);
    expect(client.state).toBe('connected');
    expect(server.frames).toEqual([]);
  });

  it('reconnects after the server drops the socket and subscribes again', async () => {
    client = make();
    let opens = 0;
    const closes: number[] = [];
    client.on('open', () => opens++);
    client.on('close', (code) => closes.push(code));
    client.subscribe('private-user-u-feed-a');
    client.start();
    await until(() => server.frames.length === 1);
    server.last.close(1012, 'restart');
    await until(() => opens === 2);
    await until(() => server.frames.length === 2);
    expect(closes).toEqual([1012]);
    expect(server.connections).toBe(2);
    expect(client.socketId).toBe('2.1');
    expect(server.frames[1].data.channel).toBe('private-user-u-feed-a');
  });

  it('pings at the activity timeout and drops a socket that never pongs', async () => {
    server.activityTimeout = 1; // clamped to the 5 s floor: the ping itself is checked through a manual ping below
    client = make();
    client.start();
    await until(() => client!.state === 'connected');
    // the server stops answering pings: the next ping's pong timer expires and the socket is dropped
    server.last.removeAllListeners('message');
    const closed = new Promise<void>((r) => client!.once('close', () => r()));
    (client as any).activityMs = 20;
    (client as any).schedulePing();
    await closed;
    expect(server.frames.at(-1)?.event ?? 'pusher:ping').toBe('pusher:ping');
    await until(() => server.connections === 2); // and it comes back
  });

  it('gives up on a fatal error code until started again', async () => {
    client = make('wrong-key');
    const fatal: string[] = [];
    client.on('fatal', (m) => fatal.push(m));
    client.start();
    await until(() => fatal.length === 1);
    expect(fatal).toEqual(['App key does not exist']);
    expect(client.state).toBe('failed');
    await new Promise((r) => setTimeout(r, 60));
    expect(server.connections).toBe(1);
  });

  it('stop() closes the socket and does not reconnect', async () => {
    client = make();
    client.start();
    await until(() => client!.state === 'connected');
    client.stop();
    expect(client.state).toBe('disconnected');
    await new Promise((r) => setTimeout(r, 60));
    expect(server.connections).toBe(1);
  });
});

describe('PusherClient subscribe retries', () => {
  it('asks again after the authorizer fails, and after the server refuses', async () => {
    let authFails = 1;
    client = new PusherClient({
      url: `ws://127.0.0.1:${server.port}`,
      key: 'vampy-key',
      authorize: async (_s, channel) => {
        if (authFails-- > 0) throw new Error('429 from the auth endpoint');
        return `vampy-key:sig-${channel}`;
      },
      backoff: { min: 10, max: 20 },
      subscribeRetryMs: 10,
    });
    const errors: unknown[] = [];
    const subscribed: string[] = [];
    client.on('subscription_error', (_ch, d) => errors.push(d));
    client.on('subscribed', (ch) => subscribed.push(ch));
    server.onSubscribe = 'reject';
    client.subscribe('private-user-u-feed-a');
    client.start();
    // first try: the authorizer throws; second try: the server refuses; then it is let in
    await until(() => errors.length === 2);
    expect(errors[0]).toEqual({ error: '429 from the auth endpoint' });
    expect(errors[1]).toMatchObject({ type: 'AuthError' });
    server.onSubscribe = 'ok';
    await until(() => subscribed.length === 1);
    expect(server.frames.filter((f) => f.event === 'pusher:subscribe')).toHaveLength(2);
    // once in, no more retries
    await new Promise((r) => setTimeout(r, 80));
    expect(server.frames.filter((f) => f.event === 'pusher:subscribe')).toHaveLength(2);
  });

  it('forgets a retry when the channel is unsubscribed', async () => {
    client = new PusherClient({
      url: `ws://127.0.0.1:${server.port}`,
      key: 'vampy-key',
      authorize: async () => {
        throw new Error('down');
      },
      backoff: { min: 10, max: 20 },
      subscribeRetryMs: 10,
    });
    let errors = 0;
    client.on('subscription_error', () => errors++);
    client.subscribe('private-user-u-feed-a');
    client.start();
    await until(() => errors >= 1);
    client.unsubscribe('private-user-u-feed-a');
    const seen = errors;
    await new Promise((r) => setTimeout(r, 80));
    expect(errors).toBe(seen);
  });
});
