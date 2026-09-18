import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { TokenInfo } from '../types.js';
import { open, roomIdOf, seal } from './crypto.js';

/**
 * One member's connection to one room on a relay (spec §2, §3, §5).
 *
 * The relay sees the room id, the member id and ciphertext; everything with meaning (names,
 * tokens) is sealed with the room key before it goes out and opened after it comes in. The
 * client reconnects on its own like the LAN guest does, and turns terminal problems (wrong
 * key, old relay, access code, full) into states the settings screen can show as-is.
 */

export type RoomState = 'connecting' | 'connected' | 'disconnected' | 'key-mismatch' | 'relay-too-old' | 'access-denied' | 'full' | 'rate-limited';

export type RoomClientOptions = {
  /** `wss://host` or `ws://localhost:port`, no path; the client adds `/v1`. */
  relay: string;
  key: string;
  memberId: string;
  /** Read at hello time so a renamed user shows up under the new name on the next connect. */
  name: () => string;
  version: string;
  access?: string;
  onToken: (peerName: string, token: TokenInfo) => void;
  log?: (m: string) => void;
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect delay bounds; tests shrink them so a reconnect takes milliseconds, not seconds. */
  backoffMs?: { min: number; max: number };
};

/** The wire protocol this client speaks. Kept here rather than imported: the relay package is a dev-only dependency of the app. */
const PROTOCOL_VERSION = 1;
/** Undecryptable messages in a row before the room is declared a key mismatch (spec §3). */
const STRIKES = 3;
/** A wrong key, an old relay, an access code or a full room does not fix itself in seconds; poll gently. */
const SLOW_RETRY_MS = 60_000;
/** The relay's hello limit is per minute; half of that is enough to get back under it. */
const RATE_RETRY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

type RelayErrorCode = 'too-old' | 'too-new' | 'access' | 'full' | 'rate' | 'bad';
/** The relay's close codes, one per error, for a socket that closed without an error frame reaching us first. */
const CLOSE_TO_CODE: Record<number, RelayErrorCode> = { 4001: 'too-old', 4002: 'too-new', 4003: 'access', 4004: 'full', 4005: 'rate', 4006: 'bad' };
const KNOWN_CODES = new Set<string>(['too-old', 'too-new', 'access', 'full', 'rate', 'bad']);

type Buffered = { from: string; body: string };

export class RoomClient extends EventEmitter {
  /** What the relay knows the room as: SHA-256 of the key, truncated. */
  readonly id: string;
  readonly memberId: string;
  state: RoomState = 'disconnected';
  /** Other members online right now (never counts this member, on any of its devices). */
  members = 0;
  /** Why the last attempt failed, for the settings screen. */
  lastError?: string;
  /** memberId → display name, learned from each peer's sealed hello. */
  readonly peers = new Map<string, string>();
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private backoff: number;
  private stopped = true;
  /** Undecryptable messages in a row; a good one resets it. */
  private strikes = 0;
  /** Set when the current socket hit a relay error, so its close is not mistaken for a plain drop. */
  private failure?: RelayErrorCode | 'key-mismatch';
  private readonly log: (m: string) => void;
  private readonly WS: typeof WebSocket;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  constructor(private readonly opts: RoomClientOptions) {
    super();
    this.id = roomIdOf(opts.key);
    this.memberId = opts.memberId;
    this.log = opts.log ?? (() => {});
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.minBackoff = opts.backoffMs?.min ?? 2_000;
    this.maxBackoff = opts.backoffMs?.max ?? 15_000;
    this.backoff = this.minBackoff;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Drop whatever is there and dial again now (the user pressed reconnect); the backoff starts over. */
  reconnect(): void {
    clearTimeout(this.timer);
    this.backoff = this.minBackoff;
    this.stopped = false;
    this.abandon();
    this.connect();
  }

  /** Leaves politely (a best-effort `bye` so peers forget the name at once) and stays away until start(). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws && this.state === 'connected') this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, { k: 'bye' }) });
    this.abandon();
    this.members = 0;
    this.peers.clear();
    this.setState('disconnected');
  }

  /** Seals and sends one plaintext object to the room. False when there is no live, welcomed socket. */
  send(plain: object): boolean {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    return this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, plain) });
  }

  // --- connection --------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.failure = undefined;
    this.strikes = 0;
    this.setState('connecting');
    const ws = new this.WS(`${this.opts.relay}/v1`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      const hello: Record<string, unknown> = { t: 'hello', v: PROTOCOL_VERSION, room: this.id, member: this.memberId };
      if (this.opts.access !== undefined) hello.access = this.opts.access;
      this.sendFrame(hello);
    });
    ws.on('message', (raw, isBinary) => {
      if (this.ws !== ws || isBinary) return;
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onFrame(frame);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (this.ws === ws) this.lastError = `HTTP ${res.statusCode}`;
    });
    ws.on('error', (e: Error & { code?: string }) => {
      if (this.ws !== ws) return;
      // A close always follows a ws error, and that close emits the state; no separate emit here.
      this.lastError = e.code ?? e.message;
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      // The error frame normally arrives first; the close code is the fallback for when it did not.
      if (!this.failure && CLOSE_TO_CODE[code]) this.onRelayError(CLOSE_TO_CODE[code]!);
      this.onClosed();
    });
  }

  /** Forgets the current socket without acting on its close: reconnect() and stop() already know what comes next. */
  private abandon(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.removeAllListeners('close');
    ws.on('error', () => {}); // a socket closed mid-handshake still emits; nobody is listening for it any more
    ws.close();
  }

  private onClosed(): void {
    if (this.members) this.emit('members', (this.members = 0));
    this.peers.clear();
    const failure = this.failure;
    // A terminal state set by the error frame stays visible while we wait; a plain drop is just disconnected.
    if (!failure || failure === 'too-new' || failure === 'bad') this.setState('disconnected');
    if (this.stopped) return;
    let delay: number;
    if (failure === 'rate') delay = RATE_RETRY_MS;
    else if (failure) delay = SLOW_RETRY_MS;
    else {
      delay = this.backoff;
      this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
    }
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref?.();
  }

  private sendFrame(frame: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      return false;
    }
  }

  private setState(s: RoomState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  // --- frames from the relay ---------------------------------------------------

  private onFrame(frame: unknown): void {
    if (!frame || typeof frame !== 'object') return;
    const f = frame as Record<string, unknown>;
    switch (f.t) {
      case 'welcome':
        return this.onWelcome(f);
      case 'msg':
        if (typeof f.from === 'string' && typeof f.body === 'string') this.onMessage(f.from, f.body);
        return;
      case 'presence':
        if (Array.isArray(f.members)) this.onPresence(f.members.filter((m): m is string => typeof m === 'string'));
        return;
      case 'error':
        if (typeof f.code === 'string' && KNOWN_CODES.has(f.code)) this.onRelayError(f.code as RelayErrorCode);
        else this.onRelayError('bad');
        return;
      default:
        return;
    }
  }

  private onWelcome(f: Record<string, unknown>): void {
    const others = Array.isArray(f.members) ? f.members.filter((m): m is string => typeof m === 'string' && m !== this.memberId) : [];
    this.members = others.length;
    const buffer = Array.isArray(f.buffer) ? f.buffer : [];
    for (const raw of buffer) {
      const m = raw as Buffered | null;
      if (!m || typeof m !== 'object' || typeof m.from !== 'string' || typeof m.body !== 'string') continue;
      // This app's own calls are already in its hub, and it may have sent them under an older key.
      if (m.from === this.memberId) continue;
      this.onMessage(m.from, m.body);
      if (this.failure) return; // three strikes closed the socket; nothing after this is trustworthy
    }
    // Names replayed from the buffer belong to whoever spoke in the last day; keep only those still here.
    for (const id of [...this.peers.keys()]) if (!others.includes(id)) this.peers.delete(id);
    this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, { k: 'hello', name: this.opts.name(), v: this.opts.version }) });
    this.backoff = this.minBackoff;
    this.lastError = undefined;
    this.log(`rooms: ${this.id} connected, ${this.members} online, ${buffer.length} buffered`);
    this.setState('connected');
    this.emit('members', this.members);
    this.emit('peers');
  }

  private onMessage(from: string, body: string): void {
    const plain = open(this.opts.key, this.id, body);
    if (plain === undefined) return this.strike();
    this.strikes = 0;
    if (!plain || typeof plain !== 'object') return;
    const p = plain as Record<string, unknown>;
    switch (p.k) {
      case 'hello':
        if (typeof p.name === 'string' && p.name) {
          this.peers.set(from, p.name);
          this.emit('peers');
        }
        return;
      case 'token': {
        const t = p.token as Partial<TokenInfo> | undefined;
        if (!t || typeof t !== 'object' || typeof t.address !== 'string' || !Array.isArray(t.calls)) return;
        const name = typeof p.name === 'string' && p.name ? p.name : (this.peers.get(from) ?? 'friend');
        this.opts.onToken(name, t as TokenInfo);
        return;
      }
      case 'bye':
        if (this.peers.delete(from)) this.emit('peers');
        return;
      default:
        return;
    }
  }

  /** One undecryptable message. Three in a row means the key is not this room's: stop reading and say so. */
  private strike(): void {
    if (++this.strikes < STRIKES) return;
    this.failure = 'key-mismatch';
    this.lastError = 'messages do not decrypt with this key; the room may have been rotated';
    this.log(`rooms: ${this.id} key mismatch after ${STRIKES} undecryptable messages`);
    this.setState('key-mismatch');
    // Our own close: the close handler sees the failure already set and schedules the slow retry.
    this.ws?.close();
  }

  private onPresence(list: string[]): void {
    this.members = list.filter((m) => m !== this.memberId).length;
    // Someone who dropped without a bye has no name to keep.
    let changed = false;
    for (const id of [...this.peers.keys()]) if (!list.includes(id)) changed = this.peers.delete(id) || changed;
    this.emit('members', this.members);
    if (changed) this.emit('peers');
  }

  private onRelayError(code: RelayErrorCode): void {
    this.failure = code;
    switch (code) {
      case 'too-old':
        this.lastError = 'this relay needs updating';
        return this.setState('relay-too-old');
      case 'too-new':
        this.lastError = 'relay speaks a newer protocol; update opentrench';
        return this.setState('disconnected');
      case 'access':
        this.lastError = 'the relay wants an access code';
        return this.setState('access-denied');
      case 'full':
        this.lastError = 'the relay or room is full';
        return this.setState('full');
      case 'rate':
        this.lastError = 'the relay is rate-limiting this connection';
        return this.setState('rate-limited');
      case 'bad':
        this.lastError = 'the relay rejected a frame as malformed';
        return this.setState('disconnected');
    }
  }
}
