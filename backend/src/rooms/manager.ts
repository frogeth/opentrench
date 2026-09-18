import { MAX_ROOMS, type ConfigStore, type Room } from '../config.js';
import type { MessageHub } from '../hub.js';
import { shareable } from '../together.js';
import type { ServerEvent, TokenInfo } from '../types.js';
import { RoomClient, type RoomClientOptions, type RoomState } from './client.js';
import { decodeInvite, encodeInvite, newRoomKey, relayHostOf, relayUrlOf, roomIdOf } from './crypto.js';

/**
 * The rooms this install is in (spec §4, §5): one RoomClient per configured room, kept in step
 * with the config by sync(); the hub's own calls go out to every connected room, and what comes
 * in is applied to the hub exactly like a LAN friend's calls.
 *
 * Only calls travel. Every app prices what is on its own screen from the chain, so market numbers
 * are never sent and `hub.remoteLive` is left alone for room peers. A token that reached this hub
 * `via` someone else is never re-sent: rooms overlap, and the loop would never end.
 */

/** The relay new rooms land on when the user has no preference. The only place this URL is spelled. */
export const DEFAULT_RELAY = 'wss://relay.opentrench.app';

/** Same window as the LAN share (together.ts keeps its copy private): a day of calls on join. */
const SHARE_WINDOW_MS = 24 * 3600e3;
/** Calls replayed into a room on connect; the relay buffers 2000 per room, so a few members' worth fits. */
const REPLAY_MAX = 200;
/** One message per token per this long: a busy token is a stream of calls, not of messages. */
const SEND_GAP_MS = 30_000;
/** Tokens remembered for throttling; a day's calls fit with room to spare. */
const LAST_SENT_MAX = 5000;
const NAME_MAX = 40;
const ACCESS_MAX = 100;

export interface RoomStatus {
  id: string;
  name: string;
  relay: string;
  state: RoomState;
  /** other members online right now */
  members: number;
  error?: string;
  /** messages accepted but not yet on the wire (a join replay draining) */
  pending: number;
}

export interface RoomsManagerDeps {
  cfg: ConfigStore;
  hub: MessageHub;
  version: string;
  /** read at hello time, so a rename shows on the next connect */
  name: () => string;
  log?: (m: string) => void;
  now?: () => number;
  /** tests: build clients with fast backoff and pacing */
  clientFactory?: (opts: RoomClientOptions) => RoomClient;
  /** something the settings screen shows changed (state, members) */
  onStatus?: () => void;
}

/** A client plus the config it was built from, so sync() can tell a changed room from an unchanged one. */
type Running = { client: RoomClient; key: string; relay: string; access?: string };

export class RoomsManager {
  private readonly running = new Map<string, Running>();
  /** address → the newest call ts sent and when, for the per-token throttle. */
  private readonly lastSent = new Map<string, { ts: number; at: number }>();
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly onEvent = (ev: ServerEvent) => {
    if (ev.type === 'token') this.share(ev.token);
  };

  constructor(private readonly deps: RoomsManagerDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    deps.hub.on('event', this.onEvent);
  }

  /** Start a client for every configured room, restart the ones whose secrets changed, stop the ones that are gone. Safe to call repeatedly. */
  sync(): void {
    const { rooms, memberId } = this.deps.cfg.get().together;
    const want = new Map(rooms.map((r) => [r.id, r]));
    for (const [id, run] of this.running) {
      const r = want.get(id);
      // the access code is sent at hello time, so a changed one needs a fresh dial too
      if (r && r.key === run.key && r.relay === run.relay && r.access === run.access) continue;
      run.client.stop();
      this.running.delete(id);
    }
    for (const r of rooms) {
      if (this.running.has(r.id)) continue;
      const client = this.build(r, memberId);
      // in the map before the first dial, so the status callback its 'connecting' fires can see it
      this.running.set(r.id, { client, key: r.key, relay: r.relay, access: r.access });
      client.start();
    }
  }

  private build(r: Room, memberId: string): RoomClient {
    const opts: RoomClientOptions = {
      relay: r.relay,
      key: r.key,
      memberId,
      name: this.deps.name,
      version: this.deps.version,
      access: r.access,
      onToken: (peer, token) => this.deps.hub.applyRemoteToken(peer, token),
      log: this.log,
    };
    const client = this.deps.clientFactory ? this.deps.clientFactory(opts) : new RoomClient(opts);
    client.on('state', (s: RoomState) => {
      // setState only emits on change, so 'connected' here is always a fresh connection: catch the room up
      if (s === 'connected') this.replay(client);
      this.deps.onStatus?.();
    });
    client.on('members', () => this.deps.onStatus?.());
    return client;
  }

  status(): RoomStatus[] {
    return this.deps.cfg.get().together.rooms.map((r) => {
      const c = this.running.get(r.id)?.client;
      return { id: r.id, name: r.name, relay: r.relay, state: c?.state ?? 'disconnected', members: c?.members ?? 0, error: c?.lastError, pending: c?.pending ?? 0 };
    });
  }

  invite(id: string): string | undefined {
    const r = this.room(id);
    return r && encodeInvite({ relay: r.relay, key: r.key });
  }

  /** A new room on `relay` (or the preferred one, or the default); the invite is what friends paste. */
  create(name: string, relay?: string): Room & { invite: string } {
    const url = relayUrlOf(relayHostOf(relay?.trim() || this.deps.cfg.get().together.relay || DEFAULT_RELAY));
    this.checkRoom();
    const key = newRoomKey();
    return this.add({ id: roomIdOf(key), key, relay: url, name: cleanName(name) || 'room', joinedAt: this.now() });
  }

  join(invite: string, name?: string, access?: string): Room & { invite: string } {
    const inv = decodeInvite(invite);
    if (!inv) throw new Error('that is not a room invite (opentrench://room/…)');
    if (this.room(inv.id)) throw new Error('you are already in that room');
    this.checkRoom();
    const code = cleanAccess(access);
    return this.add({ id: inv.id, key: inv.key, relay: inv.relay, name: cleanName(name) || relayHostOf(inv.relay), joinedAt: this.now(), ...(code ? { access: code } : {}) });
  }

  leave(id: string): void {
    this.require(id);
    this.deps.cfg.update((c) => (c.together.rooms = c.together.rooms.filter((r) => r.id !== id)));
    this.sync();
  }

  /** A fresh key (so a fresh id and invite) under the same name, relay and access code; whoever has the old invite is out. */
  rotate(id: string): Room & { invite: string } {
    const old = this.require(id);
    const key = newRoomKey();
    const next: Room = { ...old, id: roomIdOf(key), key, joinedAt: this.now() };
    this.deps.cfg.update((c) => (c.together.rooms = c.together.rooms.map((r) => (r.id === id ? next : r))));
    this.sync();
    this.log(`rooms: rotated "${old.name}" ${old.id} → ${next.id}`);
    return { ...next, invite: encodeInvite({ relay: next.relay, key: next.key }) };
  }

  /** The relay's access code for one room; empty clears it. The client dials again with the new one. */
  setAccess(id: string, code: string): void {
    this.require(id);
    const access = cleanAccess(code);
    this.deps.cfg.update((c) => {
      const r = c.together.rooms.find((r) => r.id === id)!;
      if (access) r.access = access;
      else delete r.access;
    });
    this.sync();
  }

  /** For shutdown: every client leaves, nothing more goes out. */
  stop(): void {
    this.deps.hub.off('event', this.onEvent);
    for (const run of this.running.values()) run.client.stop();
    this.running.clear();
  }

  // --- outbound -----------------------------------------------------------------

  /** One of this hub's tokens changed: send it when it has a call of our own that is newer than the last one sent. */
  private share(t: TokenInfo): void {
    if (t.via || !t.calls.length) return;
    const newest = t.calls[t.calls.length - 1]!.ts;
    const last = this.lastSent.get(t.address);
    const now = this.now();
    if (last && (newest <= last.ts || now - last.at < SEND_GAP_MS)) return;
    let sent = false;
    for (const { client } of this.running.values()) if (client.send({ k: 'token', name: this.deps.name(), token: shareable(t) })) sent = true;
    if (!sent) return;
    // re-insert so the map stays in send order and the oldest is what a full map drops
    this.lastSent.delete(t.address);
    this.lastSent.set(t.address, { ts: newest, at: now });
    if (this.lastSent.size > LAST_SENT_MAX) this.lastSent.delete(this.lastSent.keys().next().value!);
  }

  /** A room just connected: the last day of this hub's own calls, newest first, so its members see what they missed. */
  private replay(client: RoomClient): void {
    const own = this.deps.hub
      .activeTokens(SHARE_WINDOW_MS, this.now())
      .filter((t) => !t.via && t.calls.length)
      .sort((a, b) => b.lastCallTs - a.lastCallTs)
      .slice(0, REPLAY_MAX);
    const name = this.deps.name();
    for (const t of own) client.send({ k: 'token', name, token: shareable(t) });
    if (own.length) this.log(`rooms: ${client.id} replaying ${own.length} calls`);
  }

  // --- helpers ---------------------------------------------------------------------

  private room(id: string): Room | undefined {
    return this.deps.cfg.get().together.rooms.find((r) => r.id === id);
  }

  private require(id: string): Room {
    const r = this.room(id);
    if (!r) throw new Error('you are not in that room');
    return r;
  }

  private checkRoom(): void {
    if (this.deps.cfg.get().together.rooms.length >= MAX_ROOMS) throw new Error(`you are in ${MAX_ROOMS} rooms already; leave one first`);
  }

  private add(room: Room): Room & { invite: string } {
    this.deps.cfg.update((c) => c.together.rooms.push(room));
    this.sync();
    return { ...room, invite: encodeInvite({ relay: room.relay, key: room.key }) };
  }
}

const cleanName = (s: string | undefined): string => (s ?? '').trim().slice(0, NAME_MAX);
const cleanAccess = (s: string | undefined): string => (s ?? '').trim().slice(0, ACCESS_MAX);
