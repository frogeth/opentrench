import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
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
const REQUEST_PATH = '/together/request';
/** discovery beacons: one UDP broadcast every few seconds while sharing, name and port only */
export const DISCOVERY_PORT = 3212;
const BEACON_MS = 3_000;
const NEARBY_TTL_MS = 12_000;
const REQUEST_TTL_MS = 10 * 60_000;
const REQUEST_MAX = 20;
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
/** someone on the network asked to follow this machine's calls; the user allows or ignores it */
export interface PairingRequest {
  id: string;
  name: string;
  from: string;
  /** four characters both screens show, so the host can tell it is really the friend asking */
  code: string;
  ts: number;
  state: 'pending' | 'approved' | 'denied';
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = (): string => Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

function readJson(req: http.IncomingMessage, limit = 4096): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

export class TogetherHost extends EventEmitter {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private unhook?: () => void;
  clients = 0;
  /** pairing requests from the network, newest last */
  readonly requests = new Map<string, PairingRequest>();
  /** the user's answer to a request */
  answer(id: string, ok: boolean): PairingRequest | undefined {
    const r = this.requests.get(id);
    if (!r || r.state !== 'pending') return r;
    r.state = ok ? 'approved' : 'denied';
    this.emit('requests');
    return r;
  }
  pending(): PairingRequest[] {
    const now = Date.now();
    for (const [id, r] of this.requests) if (now - r.ts > REQUEST_TTL_MS) this.requests.delete(id);
    return [...this.requests.values()].filter((r) => r.state === 'pending');
  }
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
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.headers.origin !== undefined) return void res.writeHead(403).end('no browsers');
      if (url.pathname === HELLO_PATH && sameToken(url.searchParams.get('token') ?? '', this.opts.token())) {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ name: this.opts.name(), version: this.opts.version }));
      }
      // a friend found this machine on the network and asks to follow: no secret needed to ask,
      // the user's Allow on this side is what hands the token over
      if (url.pathname === REQUEST_PATH && req.method === 'POST') {
        const body = await readJson(req);
        const name = String(body?.name ?? '').trim().slice(0, 40);
        const code = String(body?.code ?? '').toUpperCase().slice(0, 4);
        if (!name || !/^[A-Z0-9]{4}$/.test(code)) return void res.writeHead(400).end('name and code');
        this.pending();
        if (this.requests.size >= REQUEST_MAX) return void res.writeHead(429).end('too many requests waiting');
        const from = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
        // the same friend asking twice gets the same request
        let r = [...this.requests.values()].find((x) => x.state === 'pending' && x.from === from && x.name === name);
        if (!r) {
          r = { id: crypto.randomBytes(8).toString('base64url'), name, from, code, ts: Date.now(), state: 'pending' };
          this.requests.set(r.id, r);
          console.log(`[together] ${name} (${from}) asks to follow, code ${code}`);
          this.emit('requests');
        }
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ id: r.id, name: this.opts.name() }));
      }
      if (url.pathname.startsWith(REQUEST_PATH + '/') && req.method === 'GET') {
        const r = this.requests.get(url.pathname.slice(REQUEST_PATH.length + 1));
        res.setHeader('content-type', 'application/json');
        if (!r) return void res.writeHead(404).end(JSON.stringify({ state: 'gone' }));
        return void res.end(JSON.stringify(r.state === 'approved' ? { state: 'approved', token: this.opts.token(), name: this.opts.name() } : { state: r.state }));
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


// ---------- finding each other on the network ----------

export interface Nearby {
  id: string;
  name: string;
  host: string;
  port: number;
  version: string;
  lastSeen: number;
}
interface Beacon {
  t: 'opentrench';
  v: 1;
  id: string;
  name: string;
  port: number;
  version: string;
}

/** the beacon another machine sent, or nothing if it is not one of ours */
export function parseBeacon(buf: Buffer | string): Beacon | undefined {
  try {
    const b = JSON.parse(String(buf));
    if (b?.t !== 'opentrench' || b?.v !== 1 || typeof b.id !== 'string' || typeof b.name !== 'string') return undefined;
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { t: 'opentrench', v: 1, id: b.id.slice(0, 32), name: b.name.slice(0, 40), port, version: String(b.version ?? '').slice(0, 20) };
  } catch {
    return undefined;
  }
}

/** every IPv4 broadcast address this machine can reach, from its interfaces' netmasks */
export function broadcastAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      out.add(a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
    }
  }
  return [...out];
}

/**
 * While sharing is on, this machine says "here I am" on the LAN every few seconds: a name, a port
 * and a random id, nothing more. Every opentrench listens and keeps a list of who it hears, so a
 * friend appears by name in the Together tab and can be asked to pair with one click.
 */
export class TogetherDiscovery extends EventEmitter {
  private sock?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  readonly id = crypto.randomBytes(6).toString('base64url');
  private heard = new Map<string, Nearby>();
  constructor(private readonly opts: { name: () => string; port: () => number; announce: () => boolean; version: string; discoveryPort?: number }) {
    super();
  }
  start(): void {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => console.warn('[together] discovery socket:', e.message));
    sock.on('message', (msg, rinfo) => {
      const b = parseBeacon(msg);
      if (!b || b.id === this.id) return;
      const had = this.heard.get(b.id);
      this.heard.set(b.id, { id: b.id, name: b.name, host: rinfo.address, port: b.port, version: b.version, lastSeen: Date.now() });
      if (!had || had.name !== b.name || had.host !== rinfo.address) this.emit('nearby');
    });
    sock.bind(this.opts.discoveryPort ?? DISCOVERY_PORT, '0.0.0.0', () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* some interfaces refuse; unicast listeners still hear us */
      }
    });
    this.sock = sock;
    this.timer = setInterval(() => this.tick(), BEACON_MS);
    this.timer.unref();
    this.tick();
  }
  private tick(): void {
    // forget who went quiet
    const now = Date.now();
    let changed = false;
    for (const [id, n] of this.heard)
      if (now - n.lastSeen > NEARBY_TTL_MS) {
        this.heard.delete(id);
        changed = true;
      }
    if (changed) this.emit('nearby');
    if (!this.opts.announce() || !this.sock) return;
    const beacon: Beacon = { t: 'opentrench', v: 1, id: this.id, name: this.opts.name(), port: this.opts.port(), version: this.opts.version };
    const data = Buffer.from(JSON.stringify(beacon));
    for (const addr of broadcastAddresses()) this.sock.send(data, this.opts.discoveryPort ?? DISCOVERY_PORT, addr, () => {});
  }
  /** who is sharing on this network right now, most recently heard first */
  list(): Nearby[] {
    const now = Date.now();
    return [...this.heard.values()].filter((n) => now - n.lastSeen <= NEARBY_TTL_MS).sort((a, b) => b.lastSeen - a.lastSeen);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sock?.close();
    this.sock = undefined;
    this.heard.clear();
  }
}

/** Ask a sharing machine to follow it. Returns the request id to poll, and the host's name. */
export async function requestPairing(host: string, port: number, name: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; name: string }> {
  const h = host.includes(':') ? `[${host}]` : host;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetchImpl(`http://${h}:${port}${REQUEST_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, code }), signal: ctl.signal });
    if (!res.ok) throw new Error(res.status === 429 ? 'they have too many requests waiting' : `they answered ${res.status}`);
    const j = await res.json();
    if (typeof j?.id !== 'string') throw new Error('odd answer from their machine');
    return { id: j.id, name: String(j.name ?? '') };
  } finally {
    clearTimeout(t);
  }
}

/** Where a request stands on the other machine; the token arrives once they pressed Allow. */
export async function pollPairing(host: string, port: number, id: string, fetchImpl: typeof fetch = fetch): Promise<{ state: 'pending' | 'approved' | 'denied' | 'gone'; token?: string; name?: string }> {
  const h = host.includes(':') ? `[${host}]` : host;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetchImpl(`http://${h}:${port}${REQUEST_PATH}/${encodeURIComponent(id)}`, { signal: ctl.signal });
    const j = await res.json().catch(() => ({}));
    const state = j?.state === 'approved' || j?.state === 'denied' || j?.state === 'pending' ? j.state : 'gone';
    return { state, token: typeof j?.token === 'string' ? j.token : undefined, name: typeof j?.name === 'string' ? j.name : undefined };
  } finally {
    clearTimeout(t);
  }
}
