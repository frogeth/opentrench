import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { DiscordState } from '../types.js';

export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  on(ev: 'open' | 'message' | 'close' | 'error', fn: (...args: any[]) => void): void;
}
export type WsFactory = (url: string) => WsLike;

export interface DiscordChannel {
  id: string;
  name: string;
  guildName: string;
}

const GATEWAY_HOST = 'wss://gateway.discord.gg';
const QUERY = '/?v=10&encoding=json';
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NO_RESUME_CODES = new Set([4007, 4009]);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const defaultFactory: WsFactory = (url) =>
  new WebSocket(url, { headers: { 'User-Agent': USER_AGENT, Origin: 'https://discord.com' } }) as unknown as WsLike;

/**
 * Raw Discord gateway client for a user token.
 * Events: 'state' (DiscordState, error?), 'channels' (DiscordChannel[]), 'message' (raw MESSAGE_CREATE d).
 */
export class DiscordGateway extends EventEmitter {
  private ws?: WsLike;
  private seq: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private hbTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private acked = true;
  private backoff = 1000;
  private stopped = false;
  private wsFactory: WsFactory;
  state: DiscordState = 'disconnected';

  constructor(
    private token: string,
    opts: { wsFactory?: WsFactory } = {},
  ) {
    super();
    this.wsFactory = opts.wsFactory ?? defaultFactory;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000);
    } catch {
      /* ignore */
    }
    this.setState('disconnected');
  }

  private open(): void {
    this.clearTimers();
    this.acked = true;
    this.setState('connecting');
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl.replace(/\/?$/, '') : GATEWAY_HOST;
    const ws = this.wsFactory(base + QUERY);
    this.ws = ws;
    ws.on('open', () => {
      /* wait for HELLO */
    });
    ws.on('message', (data) => {
      let p: any;
      try {
        p = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ws === this.ws) this.handle(p);
    });
    ws.on('close', (code: number) => {
      if (ws === this.ws) this.onClose(code);
    });
    ws.on('error', (e: any) => console.warn('[discord] ws error', e?.message ?? e));
  }

  private handle(p: any): void {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10:
        this.startHeartbeat(p.d.heartbeat_interval);
        if (this.sessionId) this.resume();
        else this.identify();
        break;
      case 11:
        this.acked = true;
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7: // reconnect requested
        this.ws?.close(4000);
        break;
      case 9: // invalid session
        if (!p.d) {
          this.sessionId = undefined;
          this.seq = null;
        }
        this.ws?.close(4000);
        break;
      case 0:
        this.dispatch(p.t, p.d);
        break;
    }
  }

  private dispatch(t: string, d: any): void {
    switch (t) {
      case 'READY': {
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.backoff = 1000;
        const channels: DiscordChannel[] = [];
        for (const g of d.guilds ?? []) channels.push(...extractChannels(g));
        this.emit('channels', channels);
        this.setState('connected');
        break;
      }
      case 'RESUMED':
        this.backoff = 1000;
        this.setState('connected');
        break;
      case 'GUILD_CREATE':
        this.emit('channels', extractChannels(d));
        break;
      case 'MESSAGE_CREATE':
        this.emit('message', d);
        break;
    }
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 30717,
        properties: {
          os: 'Mac OS X',
          browser: 'Chrome',
          device: '',
          system_locale: 'en-US',
          browser_user_agent: USER_AGENT,
          browser_version: '128.0.0.0',
          os_version: '10.15.7',
          referrer: '',
          referring_domain: '',
          referrer_current: '',
          referring_domain_current: '',
          release_channel: 'stable',
          client_build_number: 320000,
          client_event_source: null,
        },
        presence: { status: 'online', since: 0, activities: [], afk: false },
        compress: false,
        client_state: { guild_versions: {} },
      },
    });
  }

  private resume(): void {
    this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.acked = true;
    this.hbTimer = setInterval(() => {
      if (!this.acked) {
        console.warn('[discord] missed heartbeat ack, reconnecting');
        this.ws?.close(4000);
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[discord] send failed', e);
    }
  }

  private onClose(code: number): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = undefined;
    this.ws = undefined;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.stopped = true;
      this.setState(
        'auth_error',
        code === 4004 ? 'Discord rejected the token' : `Discord closed the connection (${code})`,
      );
      return;
    }
    if (NO_RESUME_CODES.has(code)) {
      this.sessionId = undefined;
      this.seq = null;
    }
    if (this.stopped) return;
    this.setState('disconnected');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.hbTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setState(state: DiscordState, error?: string): void {
    this.state = state;
    this.emit('state', state, error);
  }
}

function extractChannels(g: any): DiscordChannel[] {
  const guildName = g.properties?.name ?? g.name ?? 'Unknown';
  return (g.channels ?? [])
    .filter((c: any) => c.type === 0 || c.type === 5)
    .map((c: any) => ({ id: String(c.id), name: String(c.name), guildName }));
}
