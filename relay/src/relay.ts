// The rooms relay: a fan-out for opaque ciphertext. It learns room ids, member
// ids and IPs, and nothing else: every body it carries was encrypted on the
// member's machine with a key only the invite holds. Kept as a pure core
// (attach to any http.Server) so it can be tested in-process and embedded.
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export const PROTOCOL_VERSION = 1;

export type ErrorCode = 'too-old' | 'too-new' | 'access' | 'full' | 'rate' | 'bad';

/** WebSocket close codes, one per error, so a client can tell them apart without parsing the last frame. */
export const CLOSE_CODES: Record<ErrorCode, number> = {
  'too-old': 4001,
  'too-new': 4002,
  access: 4003,
  full: 4004,
  rate: 4005,
  bad: 4006,
};

export type RelayOptions = {
  /** When set, every hello must carry it. */
  accessCode?: string;
  maxRooms?: number;
  maxMembers?: number;
  /** Buffer keeps at most this many messages per room... */
  bufferMax?: number;
  /** ...and none older than this... */
  bufferHours?: number;
  /** ...and no more than this many bytes of body per room (default 4 MB): a member at the message cap must not own the relay's memory. */
  bufferBytes?: number;
  /** A room nobody has been in for this long is forgotten, buffer included. */
  idleDays?: number;
  /** Directory for one JSON file per room; omitted = memory only. */
  dataDir?: string;
  maxMessageBytes?: number;
  msgPerSec?: number;
  msgBurst?: number;
  helloPerMin?: number;
  /**
   * Take the client address from `fly-client-ip` or the last `x-forwarded-for`
   * entry instead of the socket. Only behind a proxy that sets those itself
   * (Fly does); otherwise a client picks its own address and the hello limiter is moot.
   */
  trustProxy?: boolean;
  /** Clock, injectable for tests. */
  now?: () => number;
  log?: (m: string) => void;
};

export type Relay = {
  /** Handles `/` and `/v1` on the server; other routes stay the host's. */
  attach(server: http.Server): void;
  rooms(): number;
  /** Drops every connection and flushes pending room files. Does not close the http server. */
  close(): void;
};

type Buffered = { from: string; body: string; ts: number };
type Bucket = { tokens: number; last: number };
type Room = {
  id: string;
  members: Map<string, Set<WebSocket>>;
  buffer: Buffered[];
  /** Sum of `body.length` over `buffer`, kept in step so trim() need not re-add it per message. */
  bytes: number;
  lastSeen: number;
  buckets: Map<string, Bucket>;
  saveTimer?: NodeJS.Timeout;
  /** A write is on its way to disk; `dirty` says whether another is owed after it. */
  saving: boolean;
  dirty: boolean;
};

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const BODY_RE = /^[A-Za-z0-9_-]+$/;
const SWEEP_MS = 10 * 60_000;
const SAVE_DEBOUNCE_MS = 2000;
const HELLO_TIMEOUT_MS = 10_000;
const HELLO_WINDOW_MS = 60_000;
/** Distinct IPs the hello limiter remembers before it forgets the oldest. */
const HELLO_IPS_MAX = 10_000;
/** A member bucket nobody has drawn on for this long is full again anyway. */
const BUCKET_IDLE_MS = 60_000;
/**
 * Sockets that have connected but not yet said hello, per IP and in all. The hello limiter only
 * counts hellos, so without these a client could hold thousands of silent sockets for the 10 s
 * each is allowed; past the cap a newcomer is refused at once with `rate`.
 */
const PENDING_PER_IP = 16;
const PENDING_TOTAL = 4096;

export function createRelay(opts: RelayOptions = {}): Relay {
  const maxRooms = opts.maxRooms ?? 1000;
  const maxMembers = opts.maxMembers ?? 50;
  const bufferMax = opts.bufferMax ?? 2000;
  const bufferMs = (opts.bufferHours ?? 24) * 3_600_000;
  const bufferBytes = opts.bufferBytes ?? 4 * 1024 * 1024;
  const idleMs = (opts.idleDays ?? 7) * 86_400_000;
  const maxMessageBytes = opts.maxMessageBytes ?? 65_536;
  const msgPerSec = opts.msgPerSec ?? 30;
  const msgBurst = opts.msgBurst ?? 60;
  const helloPerMin = opts.helloPerMin ?? 10;
  const trustProxy = opts.trustProxy ?? false;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  // Compared as digests: equal lengths for timingSafeEqual whatever the client sends.
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const accessCode = opts.accessCode ? digest(opts.accessCode) : undefined;

  const rooms = new Map<string, Room>();
  /** Per IP, the times of its hellos in the last minute, oldest first. */
  const hellos = new Map<string, number[]>();
  const sockets = new Set<WebSocket>();
  /** Per IP, how many of its sockets have yet to say hello; `pendingTotal` is the sum. */
  const pendingByIp = new Map<string, number>();
  let pendingTotal = 0;
  /** Told to go; frames that were already in flight from it are ignored. */
  const dead = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes * 2 });

  // --- token buckets ---------------------------------------------------------
  // Refill continuously so a member who paces itself never trips; a burst of
  // `burst` is fine, then `rate` per second.
  const take = (b: Bucket, rate: number, burst: number): boolean => {
    const t = now();
    b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * rate);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const bucketIn = (map: Map<string, Bucket>, key: string, burst: number): Bucket => {
    let b = map.get(key);
    if (!b) map.set(key, (b = { tokens: burst, last: now() }));
    return b;
  };
  // Hellos are a strict count per rolling minute: no burst on top, since a
  // reconnecting app needs one per room and an attacker gets nothing extra.
  const helloAllowed = (ip: string): boolean => {
    const t = now();
    let times = hellos.get(ip);
    if (!times) {
      if (hellos.size >= HELLO_IPS_MAX) hellos.delete(hellos.keys().next().value!); // oldest inserted
      hellos.set(ip, (times = []));
    }
    while (times.length && t - times[0]! >= HELLO_WINDOW_MS) times.shift();
    if (times.length >= helloPerMin) return false;
    times.push(t);
    return true;
  };

  // --- persistence -----------------------------------------------------------
  const fileFor = (id: string) => path.join(opts.dataDir!, `${id}.json`);
  const snapshot = (room: Room) => JSON.stringify({ buffer: room.buffer, lastSeen: room.lastSeen });
  // Buffers are written off the event loop; one write in flight per room and a
  // `dirty` flag so changes during the write get their own, later write. The
  // tmp-then-rename keeps a crash mid-write from leaving a half file.
  const writeRoom = async (room: Room) => {
    room.saving = true;
    room.dirty = false;
    const file = fileFor(room.id);
    try {
      await fs.promises.writeFile(file + '.tmp', snapshot(room));
      await fs.promises.rename(file + '.tmp', file);
    } catch (e) {
      log(`relay: could not write ${file}: ${(e as Error).message}`);
    } finally {
      room.saving = false;
      if (!rooms.has(room.id)) fs.rmSync(file, { force: true }); // dropped while writing
      else if (room.dirty) scheduleSave(room);
    }
  };
  const scheduleSave = (room: Room) => {
    if (!opts.dataDir) return;
    room.dirty = true;
    if (room.saveTimer || room.saving) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = undefined;
      void writeRoom(room);
    }, SAVE_DEBOUNCE_MS);
    room.saveTimer.unref();
  };
  // Synchronous, for the way out: the process will not wait for a promise.
  // Sharing the tmp name with the async path means whichever rename lands
  // last wins with the newest content, and the loser only logs an ENOENT.
  const flushSave = (room: Room) => {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    if (!room.dirty && !room.saving) return;
    const file = fileFor(room.id);
    try {
      fs.writeFileSync(file + '.tmp', snapshot(room));
      fs.renameSync(file + '.tmp', file);
      room.dirty = false;
    } catch (e) {
      log(`relay: could not write ${file}: ${(e as Error).message}`);
    }
  };
  const load = () => {
    if (!opts.dataDir) return;
    fs.mkdirSync(opts.dataDir, { recursive: true });
    for (const name of fs.readdirSync(opts.dataDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const file = path.join(opts.dataDir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { buffer?: unknown; lastSeen?: unknown };
        if (!Array.isArray(raw.buffer) || typeof raw.lastSeen !== 'number') throw new Error('unexpected shape');
        const buffer = raw.buffer.filter((m): m is Buffered => !!m && typeof m === 'object' && ID_RE.test((m as Buffered).from) && BODY_RE.test((m as Buffered).body) && typeof (m as Buffered).ts === 'number');
        const bytes = buffer.reduce((n, m) => n + m.body.length, 0);
        const room: Room = { id, members: new Map(), buffer, bytes, lastSeen: raw.lastSeen, buckets: new Map(), saving: false, dirty: false };
        trim(room);
        rooms.set(id, room);
      } catch (e) {
        log(`relay: skipping corrupt room file ${file}: ${(e as Error).message}`);
      }
    }
  };

  // --- rooms -----------------------------------------------------------------
  // Oldest first, until the buffer is within age, count and bytes at once. A body
  // that is over the byte cap on its own goes out to the room like any other but
  // is not kept: the cap is on what the relay holds, not on what it carries.
  const trim = (room: Room) => {
    const cutoff = now() - bufferMs;
    let drop = 0;
    while (drop < room.buffer.length && room.buffer[drop]!.ts < cutoff) drop++;
    if (room.buffer.length - drop > bufferMax) drop = room.buffer.length - bufferMax;
    let bytes = room.bytes;
    for (let i = 0; i < drop; i++) bytes -= room.buffer[i]!.body.length;
    while (drop < room.buffer.length && bytes > bufferBytes) bytes -= room.buffer[drop++]!.body.length;
    if (drop) room.buffer.splice(0, drop);
    room.bytes = bytes;
  };
  load();
  const memberIds = (room: Room) => [...room.members.keys()];
  const send = (ws: WebSocket, frame: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const broadcast = (room: Room, frame: unknown, except?: WebSocket) => {
    const text = JSON.stringify(frame);
    for (const set of room.members.values()) for (const ws of set) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(text);
  };
  const fail = (ws: WebSocket, code: ErrorCode) => {
    dead.add(ws);
    send(ws, { t: 'error', code });
    ws.close(CLOSE_CODES[code]);
  };
  const dropRoom = (room: Room) => {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    room.dirty = false;
    rooms.delete(room.id);
    if (opts.dataDir) fs.rmSync(fileFor(room.id), { force: true });
  };
  const sweep = () => {
    const t = now();
    for (const room of rooms.values()) {
      if (room.members.size === 0 && t - room.lastSeen > idleMs) {
        dropRoom(room);
        continue;
      }
      for (const [member, b] of room.buckets) if (t - b.last > BUCKET_IDLE_MS) room.buckets.delete(member);
    }
    for (const [ip, times] of hellos) if (!times.length || t - times[times.length - 1]! >= HELLO_WINDOW_MS) hellos.delete(ip);
  };
  const sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref();

  const leave = (room: Room, member: string, ws: WebSocket) => {
    const set = room.members.get(member);
    if (!set) return;
    set.delete(ws);
    if (set.size) return; // another device of the same member is still here
    // the member's bucket stays: leaving and coming back is not a fresh burst
    room.members.delete(member);
    room.lastSeen = now();
    scheduleSave(room);
    broadcast(room, { t: 'presence', members: memberIds(room) });
  };

  type Hello = { t: 'hello'; v: number; room: string; member: string; access?: string };
  const parseHello = (raw: unknown): Hello | ErrorCode => {
    if (!raw || typeof raw !== 'object') return 'bad';
    const f = raw as Record<string, unknown>;
    if (f.t !== 'hello' || typeof f.v !== 'number') return 'bad';
    // The code names the relay's side of the gap (spec §2): an app speaking a newer protocol than
    // this relay is told the relay is `too-old` (it needs updating); an app behind the relay is
    // told the relay is `too-new` (the app does).
    if (f.v > PROTOCOL_VERSION) return 'too-old';
    if (f.v < PROTOCOL_VERSION) return 'too-new';
    if (typeof f.room !== 'string' || !ID_RE.test(f.room) || typeof f.member !== 'string' || !ID_RE.test(f.member)) return 'bad';
    if (f.access !== undefined && typeof f.access !== 'string') return 'bad';
    return { t: 'hello', v: f.v, room: f.room, member: f.member, access: f.access as string | undefined };
  };
  const accessOk = (given: string | undefined): boolean => !accessCode || timingSafeEqual(digest(given ?? ''), accessCode);

  const onConnection = (ws: WebSocket, ip: string) => {
    ws.on('error', () => ws.terminate());
    const pendingHere = pendingByIp.get(ip) ?? 0;
    if (pendingHere >= PENDING_PER_IP || pendingTotal >= PENDING_TOTAL) return fail(ws, 'rate');
    pendingByIp.set(ip, pendingHere + 1);
    pendingTotal++;
    let pending = true;
    /** The socket said hello or went away: it no longer holds a pre-hello slot. */
    const settle = () => {
      if (!pending) return;
      pending = false;
      pendingTotal--;
      const n = (pendingByIp.get(ip) ?? 1) - 1;
      if (n > 0) pendingByIp.set(ip, n);
      else pendingByIp.delete(ip);
    };
    sockets.add(ws);
    let room: Room | undefined;
    let member = '';
    const helloTimer = setTimeout(() => {
      if (!room) fail(ws, 'bad');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    const onHello = (raw: unknown) => {
      if (!helloAllowed(ip)) return fail(ws, 'rate');
      const hello = parseHello(raw);
      if (typeof hello === 'string') return fail(ws, hello);
      if (!accessOk(hello.access)) return fail(ws, 'access');
      let r = rooms.get(hello.room);
      if (!r) {
        if (rooms.size >= maxRooms) return fail(ws, 'full');
        r = { id: hello.room, members: new Map(), buffer: [], bytes: 0, lastSeen: now(), buckets: new Map(), saving: false, dirty: false };
        rooms.set(r.id, r);
      }
      let set = r.members.get(hello.member);
      if (!set && r.members.size >= maxMembers) return fail(ws, 'full');
      // welcome says who is *already* here, so the joiner is left out whether
      // this is its first device or another one
      const others = memberIds(r).filter((m) => m !== hello.member);
      trim(r);
      if (set) set.add(ws);
      else r.members.set(hello.member, (set = new Set([ws])));
      room = r;
      member = hello.member;
      settle();
      r.lastSeen = now();
      scheduleSave(r);
      send(ws, { t: 'welcome', v: PROTOCOL_VERSION, members: others, buffer: r.buffer });
      broadcast(r, { t: 'presence', members: memberIds(r) }, ws);
    };

    const onMsg = (raw: unknown) => {
      const r = room!;
      const f = raw as Record<string, unknown>;
      if (!f || typeof f !== 'object' || f.t !== 'msg') return fail(ws, 'bad');
      if (typeof f.body !== 'string' || !BODY_RE.test(f.body)) return fail(ws, 'bad');
      if (!take(bucketIn(r.buckets, member, msgBurst), msgPerSec, msgBurst)) return fail(ws, 'rate');
      const entry: Buffered = { from: member, body: f.body, ts: now() };
      r.buffer.push(entry);
      r.bytes += entry.body.length;
      trim(r);
      r.lastSeen = entry.ts;
      scheduleSave(r);
      broadcast(r, { t: 'msg', ...entry }, ws);
    };

    ws.on('message', (data, isBinary) => {
      if (dead.has(ws)) return;
      if (isBinary) return fail(ws, 'bad');
      const text = data.toString();
      if (Buffer.byteLength(text) > maxMessageBytes) return fail(ws, 'bad');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail(ws, 'bad');
      }
      if (room) onMsg(raw);
      else onHello(raw);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      settle();
      sockets.delete(ws);
      if (room) leave(room, member, ws);
    });
  };

  // --- http ------------------------------------------------------------------
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const header = (req: http.IncomingMessage, name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const clientIp = (req: http.IncomingMessage): string => {
    const own = req.socket.remoteAddress || 'unknown';
    if (!trustProxy) return own;
    // Fly sets fly-client-ip itself. In x-forwarded-for only the LAST entry is
    // the proxy's own observation; the earlier ones are whatever the client sent.
    const fly = header(req, 'fly-client-ip')?.trim();
    if (fly) return fly;
    const last = header(req, 'x-forwarded-for')?.split(',').pop()?.trim();
    return last || own;
  };
  // Only origin-form targets ("/path?query") can be ours. Absolute-form and
  // other shapes (which `new URL` would throw on) match nothing, so they fall
  // through to the 404 / socket close below instead of taking the process down.
  const pathOf = (req: http.IncomingMessage): string => {
    const u = req.url ?? '';
    return u.startsWith('/') ? u.split('?', 1)[0]! : '';
  };

  const attach = (server: http.Server) => {
    server.on('request', (req, res) => {
      const p = pathOf(req);
      if (p === '/') return json(res, 200, { name: 'opentrench-relay', v: PROTOCOL_VERSION, rooms: rooms.size });
      if (p === '/v1') return json(res, 426, { error: 'upgrade required' });
      // Other paths belong to whoever else listens on this server; only answer when nobody does.
      if (server.listenerCount('request') === 1) json(res, 404, { error: 'not found' });
    });
    server.on('upgrade', (req, socket: Duplex, head) => {
      if (pathOf(req) !== '/v1') {
        if (server.listenerCount('upgrade') === 1) socket.destroy();
        return;
      }
      const ip = clientIp(req);
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
    });
  };

  const close = () => {
    clearInterval(sweeper);
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const room of rooms.values()) flushSave(room);
    wss.close();
  };

  return { attach, rooms: () => rooms.size, close };
}
