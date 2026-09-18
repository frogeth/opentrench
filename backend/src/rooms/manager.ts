import { MAX_ROOMS, type ConfigStore, type Room } from '../config.js';
import type { MessageHub } from '../hub.js';
import type { ServerEvent, TokenInfo } from '../types.js';
import { RoomClient, type RoomClientOptions, type RoomState } from './client.js';
import { decodeInvite, encodeInvite, newRoomKey, relayHostOf, relayUrlOf, roomIdOf } from './crypto.js';

/**
 * The rooms this install is in (spec §4, §5): one RoomClient per configured room, kept in step
 * with the config by sync(); the hub's own calls go out to every connected room, and what comes
 * in is applied to the hub exactly like a LAN friend's calls.
 *
 * Only calls travel (`roomShareable`). Every app prices what is on its own screen from the chain,
 * so market numbers are never sent and `hub.remoteLive` is left alone for room peers. Only this
 * machine's own calls (those without `via`) ever trigger a send: rooms overlap, and re-sending a
 * friend's call under this name would loop for ever. The message still carries the token's full
 * call list; peers dedupe by message id.
 */

/** The relay new rooms land on when the user has no preference. The only place this URL is spelled. */
/** There is no official relay: a room needs the address of one you host or a friend hosts. */
export const NO_RELAY_MESSAGE = 'enter a relay address (wss://…): host one or use a friend\'s';

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
  /** tests: a shorter per-token send gap */
  sendGapMs?: number;
  /** tests: build clients with fast backoff and pacing */
  clientFactory?: (opts: RoomClientOptions) => RoomClient;
  /** something the settings screen shows changed (state, members) */
  onStatus?: () => void;
}

/** A client plus the config it was built from, so sync() can tell a changed room from an unchanged one. */
type Running = { client: RoomClient; key: string; relay: string; access?: string };

export class RoomsManager {
  private readonly running = new Map<string, Running>();
  /** address → the newest own call ts sent and when, for the per-token throttle. */
  /** per token: the newest own call sent, when, and whether it went out bare (no ticker or chain yet) */
  private readonly lastSent = new Map<string, { ts: number; at: number; bare: boolean }>();
  /** address → the send booked for when its gap ends, so a call inside the gap is delayed, not lost. */
  private readonly deferred = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly sendGapMs: number;
  private readonly onEvent = (ev: ServerEvent) => {
    if (ev.type === 'token') this.share(ev.token);
  };

  constructor(private readonly deps: RoomsManagerDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.sendGapMs = deps.sendGapMs ?? SEND_GAP_MS;
    deps.hub.on('event', this.onEvent);
  }

  /** Start a client for every configured room, restart the ones whose secrets changed, stop the ones that are gone. Safe to call repeatedly. */
  sync(): void {
    if (this.stopped) return;
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

  /** A new room on `relay` (or the last relay this machine used); the invite is what friends paste. */
  create(name: string, relay?: string): Room & { invite: string } {
    const chosen = relay?.trim() || this.deps.cfg.get().together.relay;
    if (!chosen) throw new Error(NO_RELAY_MESSAGE);
    const url = relayUrlOf(relayHostOf(chosen));
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
    // the card shows the relay host anyway, so an unnamed room is just 'room' like a created one
    return this.add({ id: inv.id, key: inv.key, relay: inv.relay, name: cleanName(name) || 'room', joinedAt: this.now(), ...(code ? { access: code } : {}) });
  }

  leave(id: string): void {
    this.require(id);
    this.deps.cfg.update((c) => (c.together.rooms = c.together.rooms.filter((r) => r.id !== id)));
    this.sync();
  }

  /**
   * A fresh key (so a fresh id and invite) under the same name, relay and access code; whoever has
   * the old invite is out. The old room hears about it first (best effort), so members still in it
   * show "invite changed" instead of a room that went quiet.
   */
  rotate(id: string): Room & { invite: string } {
    const old = this.require(id);
    this.running.get(id)?.client.announceRotation();
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

  /** For shutdown: every client leaves, nothing more goes out, and sync() stays a no-op. */
  stop(): void {
    this.stopped = true;
    this.deps.hub.off('event', this.onEvent);
    for (const t of this.deferred.values()) clearTimeout(t);
    this.deferred.clear();
    for (const run of this.running.values()) run.client.stop();
    this.running.clear();
  }

  // --- outbound -----------------------------------------------------------------

  /**
   * One of this hub's tokens changed: send it when it has an own call newer than the last one sent,
   * or once more when it went out bare (the call lands before enrichment answers) and now has its
   * ticker and chain, so peers never keep a bare address for a token called only once.
   * Inside the gap the send is booked for when the gap ends (`fromTimer` is that booking firing), so
   * a second caller within 30 s reaches the room 30 s late rather than on some later market tick.
   */
  private share(t: TokenInfo | undefined, fromTimer = false): void {
    if (this.stopped || !t) return;
    const newest = newestOwnCall(t);
    if (newest === undefined) return;
    const last = this.lastSent.get(t.address);
    const identity = hasIdentity(t);
    const catchUp = !!last && last.bare && identity;
    if (last && newest <= last.ts && !catchUp) return;
    const now = this.now();
    if (last && !fromTimer && now - last.at < this.sendGapMs) {
      this.defer(t.address, last.at + this.sendGapMs - now);
      return;
    }
    let sent = false;
    for (const { client } of this.running.values()) if (client.send({ k: 'token', name: this.deps.name(), token: roomShareable(t) })) sent = true;
    if (sent) this.record(t.address, newest, now, !identity);
  }

  private defer(address: string, ms: number): void {
    if (this.deferred.has(address)) return;
    const timer = setTimeout(() => {
      this.deferred.delete(address);
      this.share(this.deps.hub.getToken(address), true);
    }, ms);
    timer.unref?.();
    this.deferred.set(address, timer);
  }

  /** A room just connected: the last day of this hub's own calls, newest first, so its members see what they missed. */
  private replay(client: RoomClient): void {
    const now = this.now();
    const own = this.deps.hub
      .activeTokens(SHARE_WINDOW_MS, now)
      .map((t) => ({ t, newest: newestOwnCall(t) }))
      .filter((x): x is { t: TokenInfo; newest: number } => x.newest !== undefined)
      .sort((a, b) => b.newest - a.newest)
      .slice(0, REPLAY_MAX);
    const name = this.deps.name();
    for (const { t, newest } of own) {
      // counts as sent: the first market tick after a reconnect must not send it all over again
      if (client.send({ k: 'token', name, token: roomShareable(t) })) this.record(t.address, newest, now, !hasIdentity(t));
    }
    if (own.length) this.log(`rooms: ${client.id} replaying ${own.length} calls`);
  }

  private record(address: string, ts: number, at: number, bare: boolean): void {
    // re-insert so the map stays in send order and the oldest is what a full map drops
    this.lastSent.delete(address);
    this.lastSent.set(address, { ts, at, bare });
    if (this.lastSent.size > LAST_SENT_MAX) this.lastSent.delete(this.lastSent.keys().next().value!);
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

/** What a room message carries of a token: who it is and who called it. */
const ROOM_KEYS = [
  'address',
  'chain',
  'network',
  'name',
  'symbol',
  'imageUrl',
  'pairAddress',
  'quoteSymbol',
  'quoteAddress',
  'dex',
  'launchpad',
  'launchpadUrl',
  'launchpadNote',
  'chartUrl',
  'embedUrl',
  'explorerUrl',
  'website',
  'twitter',
  'telegram',
  'firstSeenTs',
  'lastCallTs',
  'calls',
  'firstCaller',
  'firstCallMarketCap',
  'athMarketCap',
] as const satisfies readonly (keyof TokenInfo)[];

export type RoomToken = Pick<TokenInfo, (typeof ROOM_KEYS)[number]>;

/**
 * The room's projection of a token: identity, links and calls, nothing that moves. Price, cap,
 * liquidity, volume and the like are what every app reads from the chain for itself; sending them
 * would have `applyRemoteToken` overwrite a peer's own numbers on every call. `via` stays home too
 * (the receiver tags the token with the sender's name), as does `security`.
 */
export function roomShareable(t: TokenInfo): RoomToken {
  const out: Partial<TokenInfo> = {};
  for (const k of ROOM_KEYS) if (t[k] !== undefined) (out as Record<string, unknown>)[k] = t[k];
  return out as RoomToken;
}

/** a ticker and a chain: what a peer's card needs to be more than an address */
const hasIdentity = (t: TokenInfo): boolean => !!t.symbol && !!t.network;

/** The ts of the newest call from this machine's own chats, or undefined when every call came via a friend. Calls are not kept sorted, so a max, not the tail. */
function newestOwnCall(t: TokenInfo): number | undefined {
  let newest: number | undefined;
  for (const c of t.calls) if (!c.via && (newest === undefined || c.ts > newest)) newest = c.ts;
  return newest;
}

const cleanName = (s: string | undefined): string => (s ?? '').trim().slice(0, NAME_MAX);
const cleanAccess = (s: string | undefined): string => (s ?? '').trim().slice(0, ACCESS_MAX);
