import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * A minimal Pusher-protocol client (protocol 7) over `ws`, enough for Soketi's private channels:
 * connection_established → authorize each wanted channel through a callback → subscribe; ping/pong
 * both ways; events delivered with their data parsed; reconnect with backoff, resubscribing what was
 * wanted. A 4000–4099 error from the server (bad key, app disabled) is fatal until `start()` again.
 *
 * Events: 'open' (socket id), 'subscribed' (channel), 'subscription_error' (channel, detail),
 * 'event' (channel, name, data), 'close', 'fatal' (message), 'log' (message).
 */
export interface PusherOptions {
  /** the socket host, `wss://ws.vampy.app` */
  url: string;
  /** the app key in the path (`/app/<key>`) */
  key: string;
  /** signs a private channel for this socket: the `auth` string the server wants, or throws */
  authorize: (socketId: string, channel: string) => Promise<string>;
  client?: string;
  version?: string;
  /** reconnect delays: doubling from min up to max (ms) */
  backoff?: { min: number; max: number };
  /** how long a pong may take before the socket is dropped (ms) */
  pongTimeoutMs?: number;
  /** first retry of a refused subscription (ms); doubles up to five minutes */
  subscribeRetryMs?: number;
  /** tests: build the socket */
  wsFactory?: (url: string) => WebSocket;
}

export type PusherState = 'disconnected' | 'connecting' | 'connected' | 'failed';

const DEFAULT_BACKOFF = { min: 1000, max: 30_000 };
const DEFAULT_PONG_MS = 30_000;
const DEFAULT_SUBSCRIBE_RETRY_MS = 2000;
const SUBSCRIBE_RETRY_MAX_MS = 5 * 60_000;

/** Closes a socket without a later 'error' from an aborted handshake surfacing as uncaught. */
const closeQuietly = (ws: WebSocket | undefined): void => {
  if (!ws) return;
  ws.removeAllListeners();
  ws.on('error', () => {});
  try {
    ws.close();
  } catch {
    /* already gone */
  }
};
/** the server says how quiet the line may go before we ping; never faster than this */
const MIN_ACTIVITY_MS = 5000;

const parseData = (d: unknown): unknown => {
  if (typeof d !== 'string') return d;
  try {
    return JSON.parse(d);
  } catch {
    return d;
  }
};

export class PusherClient extends EventEmitter {
  state: PusherState = 'disconnected';
  socketId?: string;
  private ws?: WebSocket;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private stopped = true;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private activityMs = 120_000;
  /** channels whose subscribe was refused, waiting to be asked for again */
  private retries = new Map<string, { timer?: NodeJS.Timeout; attempt: number }>();

  constructor(private readonly opts: PusherOptions) {
    super();
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    this.socketId = undefined;
    this.subscribed.clear();
    closeQuietly(ws);
    this.setState('disconnected');
  }

  /** Channels this client keeps subscribed across reconnects. */
  channels(): string[] {
    return [...this.wanted];
  }

  subscribe(channel: string): void {
    if (this.wanted.has(channel)) return;
    this.wanted.add(channel);
    if (this.state === 'connected') void this.doSubscribe(channel);
  }

  unsubscribe(channel: string): void {
    if (!this.wanted.delete(channel)) return;
    this.subscribed.delete(channel);
    this.forgetRetry(channel);
    if (this.state === 'connected') this.send({ event: 'pusher:unsubscribe', data: { channel } });
  }

  private setState(s: PusherState): void {
    this.state = s;
  }

  private send(frame: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      this.emit('log', `send failed: ${(e as Error).message}`);
    }
  }

  private url(): string {
    const q = new URLSearchParams({ protocol: '7', client: this.opts.client ?? 'opentrench', version: this.opts.version ?? '1.0', flash: 'false' });
    return `${this.opts.url.replace(/\/+$/, '')}/app/${encodeURIComponent(this.opts.key)}?${q}`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = this.opts.wsFactory ? this.opts.wsFactory(this.url()) : new WebSocket(this.url());
    } catch (e) {
      this.emit('log', `connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let frame: any;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame && typeof frame === 'object') this.handle(frame);
    });
    // 'error' on the socket is followed by 'close'; reconnecting happens there
    ws.on('error', (e) => this.emit('log', `socket error: ${e.message}`));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.onClose(code, String(reason ?? ''));
    });
  }

  private handle(frame: { event?: unknown; channel?: unknown; data?: unknown }): void {
    const event = typeof frame.event === 'string' ? frame.event : '';
    const channel = typeof frame.channel === 'string' ? frame.channel : undefined;
    switch (event) {
      case 'pusher:connection_established': {
        const d = parseData(frame.data) as any;
        this.socketId = typeof d?.socket_id === 'string' ? d.socket_id : String(d?.socket_id ?? '');
        const t = Number(d?.activity_timeout);
        this.activityMs = Math.max(MIN_ACTIVITY_MS, (Number.isFinite(t) && t > 0 ? t : 120) * 1000);
        this.attempt = 0;
        this.setState('connected');
        this.schedulePing();
        this.emit('open', this.socketId);
        for (const ch of this.wanted) void this.doSubscribe(ch);
        return;
      }
      case 'pusher:ping':
        this.send({ event: 'pusher:pong', data: {} });
        return;
      case 'pusher:pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case 'pusher:error': {
        const d = parseData(frame.data) as any;
        const code = Number(d?.code);
        const message = String(d?.message ?? 'pusher error');
        if (code >= 4000 && code <= 4099) {
          // the server will not have us back with this key/app: stop trying until start() again
          this.emit('log', `fatal ${code}: ${message}`);
          this.stopped = true;
          this.clearTimers();
          const ws = this.ws;
          this.ws = undefined;
          closeQuietly(ws);
          this.setState('failed');
          this.emit('fatal', message);
        } else this.emit('log', `error ${Number.isFinite(code) ? code : '?'}: ${message}`);
        return;
      }
      case 'pusher_internal:subscription_succeeded':
        if (channel) {
          this.subscribed.add(channel);
          this.forgetRetry(channel);
          this.emit('subscribed', channel);
        }
        return;
      case 'pusher:subscription_error':
      case 'pusher_internal:subscription_error':
        if (channel) {
          this.emit('subscription_error', channel, parseData(frame.data));
          this.scheduleResubscribe(channel);
        }
        return;
      default:
        if (channel && event && !event.startsWith('pusher')) this.emit('event', channel, event, parseData(frame.data));
    }
  }

  private async doSubscribe(channel: string): Promise<void> {
    const ws = this.ws;
    const socketId = this.socketId;
    if (!ws || !socketId) return;
    let auth: string;
    try {
      auth = await this.opts.authorize(socketId, channel);
    } catch (e) {
      this.emit('subscription_error', channel, { error: (e as Error).message });
      // the auth endpoint was busy or down (a burst at boot, a blip): ask again later, not only on the next socket
      if (this.ws === ws) this.scheduleResubscribe(channel);
      return;
    }
    // the socket may have turned over while the auth call was out; the new one resubscribes on its own
    if (this.ws !== ws || !this.wanted.has(channel)) return;
    this.send({ event: 'pusher:subscribe', data: { channel, auth } });
  }

  /** A refused or failed subscribe is tried again with a doubling delay while the channel is still wanted on this socket. */
  private scheduleResubscribe(channel: string): void {
    if (!this.wanted.has(channel) || this.state !== 'connected') return;
    const cur = this.retries.get(channel);
    if (cur?.timer) clearTimeout(cur.timer);
    const attempt = cur ? cur.attempt + 1 : 0;
    const delay = Math.min(SUBSCRIBE_RETRY_MAX_MS, (this.opts.subscribeRetryMs ?? DEFAULT_SUBSCRIBE_RETRY_MS) * 2 ** Math.min(attempt, 8));
    const timer = setTimeout(() => {
      this.retries.set(channel, { attempt });
      if (this.state === 'connected' && this.wanted.has(channel) && !this.subscribed.has(channel)) void this.doSubscribe(channel);
    }, delay);
    timer.unref?.();
    this.retries.set(channel, { timer, attempt });
  }

  private forgetRetry(channel: string): void {
    const r = this.retries.get(channel);
    if (r?.timer) clearTimeout(r.timer);
    this.retries.delete(channel);
  }

  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = undefined;
      if (this.state !== 'connected') return;
      this.send({ event: 'pusher:ping', data: {} });
      this.pongTimer = setTimeout(() => {
        this.pongTimer = undefined;
        this.emit('log', 'no pong; dropping the socket');
        try {
          this.ws?.terminate();
        } catch {
          /* gone */
        }
      }, this.opts.pongTimeoutMs ?? DEFAULT_PONG_MS);
      this.pongTimer.unref?.();
      this.schedulePing();
    }, this.activityMs);
    this.pingTimer.unref?.();
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.pingTimer, this.pongTimer]) if (t) clearTimeout(t);
    this.reconnectTimer = this.pingTimer = this.pongTimer = undefined;
    // a new socket subscribes everything wanted on its own
    for (const r of this.retries.values()) if (r.timer) clearTimeout(r.timer);
    this.retries.clear();
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws = undefined;
    this.socketId = undefined;
    this.subscribed.clear();
    this.setState('disconnected');
    this.emit('close', code, reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const { min, max } = this.opts.backoff ?? DEFAULT_BACKOFF;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
