import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DiscordState } from '../types.js';

/**
 * The Discord side of opentrench, the BetterDiscord/Vencord way: a plugin inside the
 * user's real Discord client connects to us over a local WebSocket and does the
 * reading and sending with the client's own functions. No token ever reaches
 * this process. One client at a time; a new connection replaces the old one.
 */
export interface DiscordChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  guildIcon?: string;
  category?: string;
  position: number;
}

export interface DiscordSelf {
  id: string;
  username: string;
  /** guild id → role ids you hold there */
  roles: Map<string, string[]>;
}

/** origins the plugin can legitimately connect from (the desktop client renders discord.com) */
const ALLOWED_ORIGINS = new Set(['https://discord.com', 'https://ptb.discord.com', 'https://canary.discord.com']);
const REQUEST_TIMEOUT_MS = 20_000;

export class DiscordBridge extends EventEmitter {
  state: DiscordState = 'disconnected';
  self?: DiscordSelf;
  readonly channels = new Map<string, DiscordChannel>();
  readonly roles = new Map<string, Map<string, string>>();
  private socket?: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private watched: string[] = [];

  /** A `noServer` WebSocket server for `/bridge`; mount it with `routeUpgrades` and gate it with `allowOrigin`. */
  readonly wss = new WebSocketServer({ noServer: true });
  constructor() {
    super();
    this.wss.on('connection', (ws) => this.accept(ws));
  }
  /** Only the Discord client's own origin may connect (a web page in a browser can't impersonate the plugin). */
  static allowOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return !origin || ALLOWED_ORIGINS.has(String(origin));
  }

  /** For tests and embedding: hand over a socket-like object directly. */
  accept(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    this.socket = ws;
    this.setState('connecting');
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.failPending(new Error('Discord client disconnected'));
      this.setState('disconnected');
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private handle(msg: any): void {
    switch (msg?.t) {
      case 'hello': {
        this.channels.clear();
        this.roles.clear();
        const roles = new Map<string, string[]>();
        for (const g of msg.guilds ?? []) {
          const guildId = String(g.id);
          this.roles.set(guildId, new Map((g.roles ?? []).map((r: any) => [String(r.id), String(r.name ?? 'role')])));
          roles.set(guildId, (g.myRoles ?? []).map(String));
          for (const c of g.channels ?? []) {
            this.channels.set(String(c.id), {
              id: String(c.id),
              name: String(c.name),
              guildId,
              guildName: String(g.name ?? 'Unknown'),
              guildIcon: typeof g.icon === 'string' ? g.icon : undefined,
              category: typeof c.category === 'string' ? c.category : undefined,
              position: Number(c.position ?? 0),
            });
          }
        }
        this.self = msg.user?.id ? { id: String(msg.user.id), username: String(msg.user.globalName ?? msg.user.username ?? ''), roles } : undefined;
        this.emit('self', this.self);
        this.emit('channels', [...this.channels.values()]);
        for (const [gid, map] of this.roles) this.emit('roles', gid, map);
        this.send({ t: 'watch', channels: this.watched });
        this.setState('connected');
        break;
      }
      case 'message':
        if (msg.d) this.emit('message', msg.d);
        break;
      case 'messageUpdate':
        if (msg.d) this.emit('messageUpdate', msg.d);
        break;
      case 'messageDelete':
        if (msg.d) this.emit('messageDelete', msg.d);
        break;
      case 'reaction':
        if (msg.d) this.emit('reaction', msg.d, msg.delta === -1 ? -1 : 1);
        break;
      case 'reply': {
        const p = this.pending.get(Number(msg.id));
        if (!p) return;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error ?? 'request failed')));
        break;
      }
    }
  }

  /** Which channels the plugin should forward. Sent now and again on every reconnect. */
  watch(channelIds: string[]): void {
    this.watched = [...channelIds];
    this.send({ t: 'watch', channels: this.watched });
  }

  /** Ask the client to do something (send, react, history…). Rejects when it isn't connected. */
  request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.socket || this.state !== 'connected') return Promise.reject(new Error('Discord isn’t connected: open Discord with the opentrench plugin enabled'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Discord client did not answer (${op})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'req', id, op, ...params });
    });
  }

  private send(obj: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(obj));
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private setState(state: DiscordState): void {
    this.state = state;
    this.emit('state', state);
  }
}
