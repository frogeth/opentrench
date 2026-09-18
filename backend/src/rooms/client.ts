import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { TokenInfo } from '../types.js';
import { open, roomIdOf, seal } from './crypto.js';

/**
 * One member's connection to one room on a relay (spec §2, §3, §5).
 *
 * The relay sees the room id, the member id and ciphertext; everything with meaning (names,
 * tokens) is sealed with the room key before it goes out and opened after it comes in. The
 * client reconnects on its own like the LAN guest does, and turns relay refusals (old relay,
 * access code, full) into states the settings screen can show as-is.
 *
 * Ciphertext never changes state. The room id is derived from the key, so a client cannot hold
 * the wrong key for a room it computed the id of: a message that does not open is the sender's
 * doing (a copied id and a made-up key, or plain garbage), never ours. Three such messages mute
 * that sender for the rest of the connection; the socket stays up and everyone else is heard.
 *
 * The one plaintext that does change state is `{k:'rotated'}`: a member made a new invite, so this
 * room is dead. The client goes to `key-mismatch` and stays there (no retry, ever) until the user
 * leaves; the card reads "invite changed — ask for the new one". Anyone holding the invite can say
 * it, and that is the trust model: whoever has the key already reads every call in the room, so
 * letting them end it is nothing they could not do by handing the invite around.
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
  /** Gap between two outbound messages; tests shrink it to drain a burst quickly. */
  paceMs?: number;
};

/** The wire protocol this client speaks. Kept here rather than imported: the relay package is a dev-only dependency of the app. */
const PROTOCOL_VERSION = 1;
/** Undecryptable messages from one sender before it is muted for the connection. */
const STRIKES = 3;
/** An old relay, an access code or a full room does not fix itself in seconds; poll gently. */
const SLOW_RETRY_MS = 60_000;
/** The relay's hello limit is per minute; half of that is enough to get back under it. */
const RATE_RETRY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** The largest frame taken from a relay: a welcome with a full buffer (2000 × 64 KB bodies is the relay's own cap) fits well inside; a hostile relay gets no more. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** 20 messages a second: under the relay's 30/s so a join burst (up to 200 calls) never trips its limit. */
const PACE_MS = 50;
/** Outbound backlog past which the oldest messages are dropped: 25 s of sending is more than any burst needs. */
const QUEUE_MAX = 500;
/** Display names come from strangers' ciphertext; long enough for any real name, short enough for any list. */
const NAME_MAX = 64;

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
  /** A member rotated the room: terminal until the user leaves (start() and reconnect() are no-ops). */
  private rotated = false;
  /** Undecryptable messages per sender on this connection; at STRIKES the sender is muted. */
  private readonly strikes = new Map<string, number>();
  /** Set when the current socket hit a relay error, so its close is not mistaken for a plain drop. */
  private failure?: RelayErrorCode;
  /** Sealed bodies waiting for their turn on the wire. */
  private queue: string[] = [];
  private paceTimer?: NodeJS.Timeout;
  private queueDropLogged = false;
  private readonly log: (m: string) => void;
  private readonly WS: typeof WebSocket;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly paceMs: number;

  constructor(private readonly opts: RoomClientOptions) {
    super();
    this.id = roomIdOf(opts.key);
    this.memberId = opts.memberId;
    this.log = opts.log ?? (() => {});
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.minBackoff = opts.backoffMs?.min ?? 2_000;
    this.maxBackoff = opts.backoffMs?.max ?? 15_000;
    this.paceMs = opts.paceMs ?? PACE_MS;
    this.backoff = this.minBackoff;
  }

  /** Messages accepted by send() that have not gone out yet. */
  get pending(): number {
    return this.queue.length;
  }

  start(): void {
    if (!this.stopped || this.rotated) return;
    this.stopped = false;
    this.connect();
  }

  /** Drop whatever is there and dial again now (the user pressed reconnect); the backoff starts over. A stopped or rotated client stays put. */
  reconnect(): void {
    if (this.stopped || this.rotated) return;
    clearTimeout(this.timer);
    this.backoff = this.minBackoff;
    this.abandon();
    this.connect();
  }

  /** Leaves politely (a best-effort `bye` so peers forget the name at once) and stays away until start(). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.dropQueue();
    if (this.ws && this.state === 'connected') this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, { k: 'bye' }) });
    this.abandon();
    this.members = 0;
    this.peers.clear();
    this.setState('disconnected');
  }

  /**
   * Seals one plaintext object and queues it for the room. True means accepted, not delivered: the
   * queue drains at one message per `paceMs` and is dropped with the connection. False when there
   * is no welcomed socket to drain into.
   */
  send(plain: object): boolean {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.queue.push(seal(this.opts.key, this.id, plain));
    if (this.queue.length > QUEUE_MAX) {
      this.queue.shift();
      if (!this.queueDropLogged) {
        this.queueDropLogged = true;
        this.log(`rooms: ${this.id} outbound queue full (${QUEUE_MAX}); dropping the oldest`);
      }
    }
    this.pump();
    return true;
  }

  /**
   * Tells the room this member just rotated it, so every other member shows "invite changed" rather
   * than sitting in a room nobody posts to any more. Straight onto the wire, ahead of the paced
   * queue: the caller stops this client next, and stop() drops that queue. Best effort, like bye.
   */
  announceRotation(): boolean {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    return this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, { k: 'rotated' }) });
  }

  // --- connection --------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.failure = undefined;
    this.strikes.clear();
    this.queueDropLogged = false;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(`${this.opts.relay}/v1`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, maxPayload: MAX_PAYLOAD_BYTES });
    } catch (e) {
      // A relay URL that does not parse throws here, before any socket exists; treat it like a failed dial.
      this.lastError = (e as Error).message;
      this.onClosed();
      return;
    }
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
    this.dropQueue();
    if (this.members) this.emit('members', (this.members = 0));
    this.peers.clear();
    const failure = this.failure;
    // A state set by the error frame stays visible while we wait; a plain drop is just disconnected.
    if (!failure || failure === 'too-new' || failure === 'bad') this.setState('disconnected');
    if (this.stopped) return;
    let delay: number;
    if (failure === 'rate') delay = RATE_RETRY_MS;
    // `bad` is a frame the relay would not take; the next dial may well go fine, so no slow retry.
    else if (failure && failure !== 'bad') delay = SLOW_RETRY_MS;
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

  /** Sends the head of the queue and books the next turn `paceMs` later; a no-op while a turn is booked. */
  private pump(): void {
    if (this.paceTimer) return;
    const body = this.queue.shift();
    if (body === undefined) return;
    this.sendFrame({ t: 'msg', body });
    this.paceTimer = setTimeout(() => {
      this.paceTimer = undefined;
      this.pump();
    }, this.paceMs);
    this.paceTimer.unref?.();
  }

  /** Whatever was waiting belongs to a connection that is gone: a replay on the next welcome would be stale. */
  private dropQueue(): void {
    this.queue = [];
    clearTimeout(this.paceTimer);
    this.paceTimer = undefined;
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
    let good = 0;
    let unreadable = 0;
    const unreadableFrom = new Set<string>();
    for (const raw of buffer) {
      const m = raw as Buffered | null;
      if (!m || typeof m !== 'object' || typeof m.from !== 'string' || typeof m.body !== 'string') continue;
      // This app's own calls are already in its hub, and it may have sent them under an older key.
      if (m.from === this.memberId) continue;
      if (this.onMessage(m.from, m.body)) good++;
      else {
        unreadable++;
        unreadableFrom.add(m.from);
      }
      // A rotation in the replay ends this room like a live one would; nothing after it matters.
      if (this.rotated) return;
    }
    // Names replayed from the buffer belong to whoever spoke in the last day; keep only those still here.
    for (const id of [...this.peers.keys()]) if (!others.includes(id)) this.peers.delete(id);
    this.sendFrame({ t: 'msg', body: seal(this.opts.key, this.id, { k: 'hello', name: this.opts.name(), v: this.opts.version }) });
    this.backoff = this.minBackoff;
    // One sender's garbage is that sender's problem; a whole room we cannot read is worth a line in Settings.
    this.lastError = good === 0 && unreadableFrom.size >= 2 ? `${unreadable} messages from ${unreadableFrom.size} members did not decrypt` : undefined;
    this.log(`rooms: ${this.id} connected, ${this.members} online, ${buffer.length} buffered`);
    this.setState('connected');
    this.emit('members', this.members);
    this.emit('peers');
  }

  /** Opens and applies one message. True when it decrypted (whatever it said); false for a muted sender or unreadable body. */
  private onMessage(from: string, body: string): boolean {
    const strikes = this.strikes.get(from) ?? 0;
    if (strikes >= STRIKES) return false;
    const plain = open(this.opts.key, this.id, body);
    if (plain === undefined) {
      this.strikes.set(from, strikes + 1);
      if (strikes + 1 === STRIKES) this.log(`rooms: ${this.id} muting ${from} after ${STRIKES} undecryptable messages`);
      return false;
    }
    if (strikes) this.strikes.delete(from);
    if (!plain || typeof plain !== 'object') return true;
    const p = plain as Record<string, unknown>;
    switch (p.k) {
      case 'hello':
        if (typeof p.name === 'string' && p.name) {
          this.peers.set(from, p.name.slice(0, NAME_MAX));
          this.emit('peers');
        }
        return true;
      case 'token': {
        const t = p.token as Partial<TokenInfo> | undefined;
        if (!t || typeof t !== 'object' || typeof t.address !== 'string' || typeof t.chain !== 'string' || !Array.isArray(t.calls)) return true;
        const name = typeof p.name === 'string' && p.name ? p.name.slice(0, NAME_MAX) : (this.peers.get(from) ?? 'friend');
        this.opts.onToken(name, t as TokenInfo);
        return true;
      }
      case 'bye':
        if (this.peers.delete(from)) this.emit('peers');
        return true;
      case 'rotated':
        this.onRotated();
        return true;
      default:
        return true;
    }
  }

  /** The room is over: hang up, forget everyone, and sit in key-mismatch until the user leaves (see the class comment for who may say this). */
  private onRotated(): void {
    if (this.rotated) return;
    this.rotated = true;
    this.stopped = true;
    clearTimeout(this.timer);
    this.dropQueue();
    this.abandon();
    this.lastError = 'the room was rotated; ask a member for the new invite';
    this.log(`rooms: ${this.id} rotated by a member; ask for the new invite`);
    if (this.members) this.emit('members', (this.members = 0));
    if (this.peers.size) {
      this.peers.clear();
      this.emit('peers');
    }
    this.setState('key-mismatch');
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
