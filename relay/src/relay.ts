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
  /** ...and none older than this. */
  bufferHours?: number;
  /** A room nobody has been in for this long is forgotten, buffer included. */
  idleDays?: number;
  /** Directory for one JSON file per room; omitted = memory only. */
  dataDir?: string;
  maxMessageBytes?: number;
  msgPerSec?: number;
  msgBurst?: number;
  helloPerMin?: number;
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
  lastSeen: number;
  buckets: Map<string, Bucket>;
  saveTimer?: NodeJS.Timeout;
};

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const BODY_RE = /^[A-Za-z0-9_-]+$/;
const SWEEP_MS = 10 * 60_000;
const SAVE_DEBOUNCE_MS = 2000;
const HELLO_TIMEOUT_MS = 10_000;

export function createRelay(opts: RelayOptions = {}): Relay {
  const maxRooms = opts.maxRooms ?? 1000;
  const maxMembers = opts.maxMembers ?? 50;
  const bufferMax = opts.bufferMax ?? 2000;
  const bufferMs = (opts.bufferHours ?? 24) * 3_600_000;
  const idleMs = (opts.idleDays ?? 7) * 86_400_000;
  const maxMessageBytes = opts.maxMessageBytes ?? 65_536;
  const msgPerSec = opts.msgPerSec ?? 30;
  const msgBurst = opts.msgBurst ?? 60;
  const helloPerMin = opts.helloPerMin ?? 10;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  // Compared as digests: equal lengths for timingSafeEqual whatever the client sends.
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const accessCode = opts.accessCode ? digest(opts.accessCode) : undefined;

  const rooms = new Map<string, Room>();
  const helloBuckets = new Map<string, Bucket>();
  const sockets = new Set<WebSocket>();
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

  // --- persistence -----------------------------------------------------------
  const fileFor = (id: string) => path.join(opts.dataDir!, `${id}.json`);
  const writeRoom = (room: Room) => {
    if (!opts.dataDir) return;
    const file = fileFor(room.id);
    try {
      // Write-then-rename so a crash mid-write never leaves a half file to be skipped as corrupt.
      fs.writeFileSync(file + '.tmp', JSON.stringify({ buffer: room.buffer, lastSeen: room.lastSeen }));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      log(`relay: could not write ${file}: ${(e as Error).message}`);
    }
  };
  const scheduleSave = (room: Room) => {
    if (!opts.dataDir || room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = undefined;
      writeRoom(room);
    }, SAVE_DEBOUNCE_MS);
    room.saveTimer.unref();
  };
  const flushSave = (room: Room) => {
    if (!room.saveTimer) return;
    clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    writeRoom(room);
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
        rooms.set(id, { id, members: new Map(), buffer, lastSeen: raw.lastSeen, buckets: new Map() });
      } catch (e) {
        log(`relay: skipping corrupt room file ${file}: ${(e as Error).message}`);
      }
    }
  };
  load();

  // --- rooms -----------------------------------------------------------------
  const trim = (room: Room) => {
    const cutoff = now() - bufferMs;
    let drop = 0;
    while (drop < room.buffer.length && room.buffer[drop]!.ts < cutoff) drop++;
    if (room.buffer.length - drop > bufferMax) drop = room.buffer.length - bufferMax;
    if (drop) room.buffer.splice(0, drop);
  };
  const memberIds = (room: Room) => [...room.members.keys()];
  const send = (ws: WebSocket, frame: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const broadcast = (room: Room, frame: unknown, except?: WebSocket) => {
    const text = JSON.stringify(frame);
    for (const set of room.members.values()) for (const ws of set) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(text);
  };
  const fail = (ws: WebSocket, code: ErrorCode) => {
    send(ws, { t: 'error', code });
    ws.close(CLOSE_CODES[code]);
  };
  const dropRoom = (room: Room) => {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    rooms.delete(room.id);
    if (opts.dataDir) fs.rmSync(fileFor(room.id), { force: true });
  };
  const sweep = () => {
    const t = now();
    for (const room of rooms.values()) if (room.members.size === 0 && t - room.lastSeen > idleMs) dropRoom(room);
    // hello buckets for IPs we have not seen in a while are dead weight
    for (const [ip, b] of helloBuckets) if (t - b.last > 60_000) helloBuckets.delete(ip);
  };
  const sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref();

  const leave = (room: Room, member: string, ws: WebSocket) => {
    const set = room.members.get(member);
    if (!set) return;
    set.delete(ws);
    if (set.size) return; // another device of the same member is still here
    room.members.delete(member);
    room.buckets.delete(member);
    room.lastSeen = now();
    scheduleSave(room);
    broadcast(room, { t: 'presence', members: memberIds(room) });
  };

  type Hello = { t: 'hello'; v: number; room: string; member: string; access?: string };
  const parseHello = (raw: unknown): Hello | ErrorCode => {
    if (!raw || typeof raw !== 'object') return 'bad';
    const f = raw as Record<string, unknown>;
    if (f.t !== 'hello' || typeof f.v !== 'number') return 'bad';
    if (f.v < PROTOCOL_VERSION) return 'too-old';
    if (f.v > PROTOCOL_VERSION) return 'too-new';
    if (typeof f.room !== 'string' || !ID_RE.test(f.room) || typeof f.member !== 'string' || !ID_RE.test(f.member)) return 'bad';
    if (f.access !== undefined && typeof f.access !== 'string') return 'bad';
    return { t: 'hello', v: f.v, room: f.room, member: f.member, access: f.access as string | undefined };
  };
  const accessOk = (given: string | undefined): boolean => !accessCode || timingSafeEqual(digest(given ?? ''), accessCode);

  const onConnection = (ws: WebSocket, ip: string) => {
    sockets.add(ws);
    let room: Room | undefined;
    let member = '';
    const helloTimer = setTimeout(() => {
      if (!room) fail(ws, 'bad');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    const onHello = (raw: unknown) => {
      if (!take(bucketIn(helloBuckets, ip, helloPerMin), helloPerMin / 60, helloPerMin)) return fail(ws, 'rate');
      const hello = parseHello(raw);
      if (typeof hello === 'string') return fail(ws, hello);
      if (!accessOk(hello.access)) return fail(ws, 'access');
      let r = rooms.get(hello.room);
      if (!r) {
        if (rooms.size >= maxRooms) return fail(ws, 'full');
        r = { id: hello.room, members: new Map(), buffer: [], lastSeen: now(), buckets: new Map() };
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
      trim(r);
      r.lastSeen = entry.ts;
      scheduleSave(r);
      broadcast(r, { t: 'msg', ...entry }, ws);
    };

    ws.on('message', (data, isBinary) => {
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
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(ws);
      if (room) leave(room, member, ws);
    });
  };

  // --- http ------------------------------------------------------------------
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  const clientIp = (req: http.IncomingMessage): string => {
    // Behind Fly's (or any) proxy the socket address is the proxy; the first
    // x-forwarded-for entry is the client. Without a proxy the header is absent.
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    return first || req.socket.remoteAddress || 'unknown';
  };
  const pathOf = (req: http.IncomingMessage) => new URL(req.url ?? '/', 'http://relay').pathname;

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
