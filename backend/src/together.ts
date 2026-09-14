import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';
import type { MessageHub } from './hub.js';
import type { ServerEvent, TokenInfo } from './types.js';

/**
 * TrenchTogether: share your calls with a friend on the same network (or the same VPN). Only the
 * call side travels — the token, who called it where, and the market numbers this machine
 * already fetched — never a chat message. The guest shows your calls tagged "via <name>" and
 * skips its own API lookups for tokens you keep fresh, so two machines behind one router stop
 * fighting over the same rate limits.
 *
 * Security: the main backend stays on 127.0.0.1. Sharing opens one extra listener on the LAN
 * that serves only this stream, only to a peer presenting the pairing token, and never to a
 * browser (any request carrying an Origin header is refused). The token lives in the pairing
 * string the host hands over out of band.
 */
export const TOGETHER_PORT = 3211;
const HELLO_PATH = '/together/hello';
const STREAM_PATH = '/together/stream';
const SHARE_WINDOW_MS = 24 * 3600e3;

export interface Pairing {
  host: string;
  port: number;
  token: string;
  name: string;
}

export const newToken = (): string => crypto.randomBytes(18).toString('base64url');

/** `opentrench://together/<host>:<port>/<token>#<name>` — one per LAN address the host has. */
export function encodePairing(p: Pairing): string {
  const host = p.host.includes(':') ? `[${p.host}]` : p.host;
  return `opentrench://together/${host}:${p.port}/${encodeURIComponent(p.token)}#${encodeURIComponent(p.name)}`;
}
export function decodePairing(s: string): Pairing | undefined {
  const m = /^opentrench:\/\/together\/(\[[^\]]+\]|[^/:]+):(\d+)\/([^#\s]+)(?:#(.*))?$/.exec(s.trim());
  if (!m) return undefined;
  const host = m[1].replace(/^\[|\]$/g, '');
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port, token: decodeURIComponent(m[3]), name: decodeURIComponent(m[4] ?? '') || host };
}

/** The addresses a peer on the LAN can reach this machine on: IPv4, not loopback, not link-local (169.254.x is a self-assigned address nobody else can route to). */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      if (!(i.family === 'IPv4' || (i.family as unknown) === 4)) continue;
      if (i.address.startsWith('169.254.')) continue;
      out.push(i.address);
    }
  }
  // the private ranges first: those are the ones a friend on the same Wi-Fi can use
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}
const isPrivate = (ip: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The token as a peer sees it: everything about the call, nothing about the chat, and no `via` chain. */
export function shareable(t: TokenInfo): TokenInfo {
  const { via: _via, ...rest } = t;
  return rest as TokenInfo;
}

/** Serves the share stream on the LAN while sharing is on. */
export class TogetherHost extends EventEmitter {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private unhook?: () => void;
  clients = 0;
  constructor(
    private readonly hub: MessageHub,
    private readonly opts: { name: () => string; token: () => string; version: string },
  ) {
    super();
  }
  get listening(): boolean {
    return !!this.server?.listening;
  }
  /** Bind on every interface. Resolves with the port. */
  start(port = TOGETHER_PORT, host = '0.0.0.0'): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as { port: number }).port);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.headers.origin !== undefined) return void res.writeHead(403).end('no browsers');
      if (url.pathname === HELLO_PATH && sameToken(url.searchParams.get('token') ?? '', this.opts.token())) {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ name: this.opts.name(), version: this.opts.version }));
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket: Duplex, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const from = req.socket.remoteAddress ?? '?';
      if (url.pathname !== STREAM_PATH || req.headers.origin !== undefined || !sameToken(url.searchParams.get('token') ?? '', this.opts.token())) {
        console.warn(`[together] refused ${from}: ${url.pathname !== STREAM_PATH ? 'wrong path' : req.headers.origin !== undefined ? 'browser origin' : 'wrong secret'}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    wss.on('connection', (ws, req) => {
      const from = req.socket.remoteAddress ?? '?';
      this.clients++;
      this.emit('clients', this.clients);
      const tokens = this.hub.activeTokens(SHARE_WINDOW_MS).map(shareable);
      const hello = JSON.stringify({ type: 'hello', name: this.opts.name(), version: this.opts.version, tokens });
      console.log(`[together] ${from} connected; sending ${tokens.length} calls (${Math.round(hello.length / 1024)} KB)`);
      ws.send(hello);
      ws.on('error', (e) => console.warn(`[together] ${from} socket error: ${e.message}`));
      ws.on('close', (code, reason) => {
        this.clients--;
        this.emit('clients', this.clients);
        console.log(`[together] ${from} disconnected (${code}${reason?.length ? ` ${reason}` : ''})`);
      });
    });
    const onEvent = (ev: ServerEvent) => {
      if (ev.type !== 'token') return;
      const data = JSON.stringify({ type: 'token', token: shareable(ev.token) });
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
    };
    this.hub.on('event', onEvent);
    this.unhook = () => this.hub.off('event', onEvent);
    this.server = server;
    this.wss = wss;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as { port: number }).port));
    });
  }
  stop(): void {
    this.unhook?.();
    for (const c of this.wss?.clients ?? []) c.close(1001, 'sharing stopped');
    this.wss?.close();
    this.server?.close();
    this.server = undefined;
    this.wss = undefined;
    this.clients = 0;
    this.emit('clients', 0);
  }
}

export type PeerState = 'connecting' | 'connected' | 'disconnected' | 'unauthorized';

/** Follows one host: reconnects on its own, hands every shared token to the hub, and remembers which tokens it currently streams. */
export class TogetherGuest extends EventEmitter {
  state: PeerState = 'disconnected';
  /** why the last attempt failed (ECONNREFUSED, timeout…), for the settings screen */
  lastError?: string;
  name: string;
  /** tokens received while connected: the host keeps these fresh, so local refresh loops skip them */
  readonly live = new Set<string>();
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private backoff = 2_000;
  private stopped = false;
  constructor(
    readonly pairing: Pairing,
    private readonly apply: (peer: string, token: TokenInfo) => void,
    private readonly WS: typeof WebSocket = WebSocket,
  ) {
    super();
    this.name = pairing.name;
  }
  get url(): string {
    const host = this.pairing.host.includes(':') ? `[${this.pairing.host}]` : this.pairing.host;
    return `ws://${host}:${this.pairing.port}${STREAM_PATH}`;
  }
  start(): void {
    this.stopped = false;
    this.connect();
  }
  /** drop whatever is there and dial again now (the user re-pasted the pairing, or pressed reconnect) */
  reconnect(): void {
    clearTimeout(this.timer);
    this.backoff = 2_000;
    this.stopped = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = undefined;
      ws.removeAllListeners('close');
      ws.close();
    }
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = undefined;
    this.live.clear();
    this.setState('disconnected');
  }
  private setState(s: PeerState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }
  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    const ws = new this.WS(`${this.url}?token=${encodeURIComponent(this.pairing.token)}`, { handshakeTimeout: 8_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 2_000;
      this.lastError = undefined;
      this.setState('connected');
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg?.type === 'hello') {
        if (typeof msg.name === 'string' && msg.name) this.name = msg.name;
        for (const t of Array.isArray(msg.tokens) ? msg.tokens : []) this.take(t);
      } else if (msg?.type === 'token') this.take(msg.token);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.lastError = `HTTP ${res.statusCode}`;
      if (res.statusCode === 403) this.setState('unauthorized');
    });
    ws.on('error', (e: Error & { code?: string }) => {
      this.lastError = e.code ?? e.message;
      this.emit('state', this.state);
    });
    ws.on('close', () => {
      this.live.clear();
      if (this.state !== 'unauthorized') this.setState('disconnected');
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.state === 'unauthorized' ? 30_000 : this.backoff);
      this.timer.unref?.();
      this.backoff = Math.min(15_000, this.backoff * 2);
    });
  }
  private take(t: any): void {
    if (!t || typeof t.address !== 'string' || !Array.isArray(t.calls)) return;
    this.live.add(t.address);
    this.apply(this.name, t as TokenInfo);
  }
}
