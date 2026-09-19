import { EventEmitter } from 'node:events';
import type { VampyPlan, VampyState } from '../types.js';
import { PusherClient, type PusherOptions } from './pusher.js';
import { channelFor, parseFeeds, rowToFeed, type VampyFeed, type VampyRow } from './normalize.js';

/**
 * Vampy's read-only API for the feeds the user built on vampy.app: the plan behind the key, the
 * feeds, each feed's recent rows, and the live stream over Soketi. Needs an active subscription:
 * 401 = the key is wrong or revoked, 403 = the plan lapsed. 120 requests a minute per key.
 *
 * Lifetime: start() reads /me and /feeds, loads every feed's history (oldest first, so the buffer
 * reads in order), opens the socket and subscribes each feed's channel. There is no replay on the
 * socket, so a reconnect loads the recent rows again (the hub dedupes by id). Every hour /me and
 * /feeds are read again: a lapsed plan disconnects, feeds added on vampy.app join, removed ones leave.
 *
 * Events: 'state' (VampyState, error?), 'plan' (VampyPlan | undefined), 'feeds' (VampyFeed[]), 'row' (VampyRow).
 */
export interface VampyClientOptions {
  apiKey: string;
  base?: string;
  wsUrl?: string;
  pusherKey?: string;
  /** rows loaded per feed at start, and after a socket reconnect */
  historyLimit?: number;
  reconnectHistory?: number;
  /** how often /me and /feeds are read again (ms) */
  recheckMs?: number;
  /** how long to wait before the boot is tried again after a network failure (ms) */
  retryMs?: number;
  fetch?: typeof fetch;
  /** tests: build the socket client */
  pusher?: (opts: PusherOptions) => PusherClient;
  log?: (m: string) => void;
}

export const VAMPY_BASE = 'https://vampy.app/api/v1';
export const VAMPY_WS = 'wss://ws.vampy.app';
export const VAMPY_PUSHER_KEY = 'vampy-key';
const HISTORY = 100;
const RECONNECT_HISTORY = 50;
const RECHECK_MS = 60 * 60_000;
const RETRY_MS = 30_000;
const RETRY_AFTER_MAX_MS = 60_000;
const TIMEOUT_MS = 15_000;

export class VampyError extends Error {
  constructor(
    readonly kind: 'auth' | 'subscription' | 'http' | 'network',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class VampyClient extends EventEmitter {
  state: VampyState = 'disconnected';
  userId?: string;
  plan?: VampyPlan;
  feeds: VampyFeed[] = [];
  private pusher?: PusherClient;
  private stopped = true;
  private booted = false;
  private timer?: NodeJS.Timeout;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;
  /** a generation counter: a boot that outlives a stop()/start() must not touch the new run */
  private run = 0;

  constructor(private readonly opts: VampyClientOptions) {
    super();
    this.base = (opts.base ?? VAMPY_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.booted = false;
    const run = ++this.run;
    this.setState('connecting');
    void this.boot(run);
  }

  stop(): void {
    this.stopped = true;
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pusher?.stop();
    this.pusher = undefined;
    if (this.state !== 'auth_error') this.setState('disconnected');
  }

  private setState(s: VampyState, error?: string): void {
    this.state = s;
    this.emit('state', s, error);
  }

  private setPlan(p?: VampyPlan): void {
    this.plan = p;
    this.emit('plan', p);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}` };
  }

  /** GET one route as JSON, with the API's own status codes turned into typed errors; one retry on 429. */
  private async api(path: string, retried = false): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new VampyError('network', `vampy.app unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401) throw new VampyError('auth', 'Vampy rejected the API key (missing, revoked or rotated)', 401);
    if (res.status === 403) throw new VampyError('subscription', 'the Vampy subscription behind this key is not active', 403);
    if (res.status === 429 && !retried) {
      const after = Number(res.headers.get('retry-after'));
      const wait = Math.min(RETRY_AFTER_MAX_MS, (Number.isFinite(after) && after > 0 ? after : 5) * 1000);
      this.log(`rate limited on ${path}; waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.api(path, true);
    }
    if (!res.ok) throw new VampyError('http', `vampy.app answered ${res.status} on ${path}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new VampyError('http', `vampy.app sent no JSON on ${path}`, res.status);
    }
  }

  /** The `auth` string for a private channel, from the API's Pusher auth route. */
  private async authorize(socketId: string, channel: string): Promise<string> {
    const body = new URLSearchParams({ socket_id: socketId, channel_name: channel });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/pusher/auth`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`auth endpoint unreachable: ${(e as Error).message}`);
    }
    if (res.status === 403 || res.status === 401) {
      // the plan may have lapsed since boot: /me says so, and the state follows
      void this.recheck(this.run);
      throw new Error(`auth endpoint refused (${res.status})`);
    }
    if (!res.ok) throw new Error(`auth endpoint answered ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as any;
    if (typeof data?.auth !== 'string' || !data.auth) throw new Error('auth endpoint sent no auth string');
    return data.auth;
  }

  private planOf(me: any): VampyPlan {
    const expires = typeof me?.expires_at === 'string' ? Date.parse(me.expires_at) : NaN;
    const days = Number(me?.days_remaining);
    return {
      name: String(me?.plan_display_name ?? me?.plan ?? 'Vampy').slice(0, 40),
      ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
      ...(Number.isFinite(days) ? { daysRemaining: days } : {}),
      feeds: this.feeds.length,
      feedIds: this.feeds.map((f) => f.id),
    };
  }

  private async boot(run: number): Promise<void> {
    try {
      const me = await this.api('/me');
      if (run !== this.run) return;
      this.userId = String(me?.user_id ?? '');
      if (!this.userId) throw new VampyError('http', '/me answered without a user id');
      this.feeds = parseFeeds(await this.api('/feeds'));
      if (run !== this.run) return;
      this.setPlan(this.planOf(me));
      this.emit('feeds', this.feeds);
      for (const f of this.feeds) {
        await this.history(f, this.opts.historyLimit ?? HISTORY, run);
        if (run !== this.run) return;
      }
      this.openSocket(run);
      this.booted = true;
      this.scheduleRecheck(run);
    } catch (e) {
      if (run !== this.run) return;
      this.fail(e, run);
    }
  }

  /** What an API failure means for the state; auth failures stop the socket, the rest retry. */
  private fail(e: unknown, run: number): void {
    const err = e instanceof VampyError ? e : new VampyError('network', (e as Error)?.message ?? String(e));
    this.log(err.message);
    if (err.kind === 'auth' || err.kind === 'subscription') {
      this.pusher?.stop();
      this.pusher = undefined;
      this.booted = false;
      this.setPlan(undefined);
      this.setState('auth_error', err.message);
      // a renewed plan works with the same key: look again in a while rather than never
      this.scheduleRecheck(run);
      return;
    }
    if (!this.booted) {
      this.setState('connecting', err.message);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (run === this.run && !this.stopped) void this.boot(run);
      }, this.opts.retryMs ?? RETRY_MS);
      this.timer.unref?.();
    } else this.scheduleRecheck(run);
  }

  /** The recent rows of one feed, oldest first, marked as history. One page. Nothing is emitted once the run is over. */
  private async history(feed: VampyFeed, limit: number, run: number): Promise<void> {
    const route = feed.type === 'call' ? 'calls' : 'messages';
    let raw: any;
    try {
      raw = await this.api(`/feeds/${encodeURIComponent(feed.id)}/${route}?limit=${limit}`);
    } catch (e) {
      if (e instanceof VampyError && (e.kind === 'auth' || e.kind === 'subscription')) throw e;
      this.log(`history of ${feed.title}: ${(e as Error).message}`);
      return;
    }
    if (run !== this.run) return;
    const rows = Array.isArray(raw?.data) ? raw.data : [];
    for (const r of [...rows].reverse()) {
      const row = rowToFeed(feed, r);
      if (row) this.emit('row', { ...row, history: true } satisfies VampyRow);
    }
  }

  private openSocket(run: number): void {
    this.pusher?.stop();
    const make = this.opts.pusher ?? ((o: PusherOptions) => new PusherClient(o));
    const p = make({ url: this.opts.wsUrl ?? VAMPY_WS, key: this.opts.pusherKey ?? VAMPY_PUSHER_KEY, authorize: (s, c) => this.authorize(s, c) });
    this.pusher = p;
    let opens = 0;
    p.on('open', () => {
      if (run !== this.run) return;
      this.setState('connected');
      // no replay on the socket: after a reconnect, whatever landed while it was down is read back
      if (opens++ > 0) for (const f of this.feeds) void this.history(f, this.opts.reconnectHistory ?? RECONNECT_HISTORY, run).catch((e) => this.fail(e, run));
    });
    p.on('close', () => {
      if (run !== this.run || this.state === 'auth_error') return;
      this.setState('connecting', 'realtime socket closed; reconnecting');
    });
    p.on('fatal', (m: string) => {
      if (run !== this.run) return;
      // the socket will not have us back as we are: start over from /me after the retry delay
      this.pusher?.stop();
      this.pusher = undefined;
      this.booted = false;
      this.fail(new VampyError('network', `realtime refused: ${m}`), run);
    });
    p.on('log', (m: string) => this.log(`socket: ${m}`));
    p.on('subscription_error', (ch: string, d: any) => this.log(`subscribe ${ch}: ${d?.error ?? d?.message ?? JSON.stringify(d)}`));
    p.on('event', (channel: string, name: string, data: unknown) => {
      if (run !== this.run) return;
      const feed = this.feeds.find((f) => channelFor(this.userId!, f.id) === channel);
      if (!feed) return;
      if ((feed.type === 'call' && name !== 'new-call') || (feed.type === 'message' && name !== 'new-message')) return;
      const row = rowToFeed(feed, data);
      if (row) this.emit('row', row);
    });
    for (const f of this.feeds) p.subscribe(channelFor(this.userId!, f.id));
    p.start();
  }

  private scheduleRecheck(run: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recheck(run);
    }, this.opts.recheckMs ?? RECHECK_MS);
    this.timer.unref?.();
  }

  /** /me and /feeds again: the plan, and feeds that came or went since. Public so a refused auth can trigger it. */
  async recheck(run = this.run): Promise<void> {
    if (this.stopped || run !== this.run) return;
    try {
      const me = await this.api('/me');
      if (run !== this.run) return;
      if (!this.booted) {
        // back from an auth error (renewed plan) or a realtime refusal: start over
        this.setState('connecting');
        await this.boot(run);
        return;
      }
      const next = parseFeeds(await this.api('/feeds'));
      if (run !== this.run) return;
      const before = new Map(this.feeds.map((f) => [f.id, f]));
      const after = new Map(next.map((f) => [f.id, f]));
      this.feeds = next;
      this.setPlan(this.planOf(me));
      this.emit('feeds', this.feeds);
      for (const [id, f] of before) if (!after.has(id)) this.pusher?.unsubscribe(channelFor(this.userId!, f.id));
      for (const [id, f] of after) {
        if (before.has(id)) continue;
        await this.history(f, this.opts.historyLimit ?? HISTORY, run);
        if (run !== this.run) return;
        this.pusher?.subscribe(channelFor(this.userId!, f.id));
      }
      this.scheduleRecheck(run);
    } catch (e) {
      if (run !== this.run) return;
      this.fail(e, run);
    }
  }
}
