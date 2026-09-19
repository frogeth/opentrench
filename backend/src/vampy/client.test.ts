import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VampyClient } from './client.js';
import type { PusherOptions } from './pusher.js';

/** A PusherClient stand-in: records subscriptions, lets a test open the line and push events. */
class FakePusher extends EventEmitter {
  state = 'disconnected';
  socketId?: string;
  wanted: string[] = [];
  started = 0;
  stopped = 0;
  constructor(readonly opts: PusherOptions) {
    super();
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.state = 'disconnected';
  }
  subscribe(ch: string) {
    if (!this.wanted.includes(ch)) this.wanted.push(ch);
  }
  unsubscribe(ch: string) {
    this.wanted = this.wanted.filter((c) => c !== ch);
  }
  channels() {
    return this.wanted;
  }
  open(id = '1.1') {
    this.state = 'connected';
    this.socketId = id;
    this.emit('open', id);
  }
  push(channel: string, name: string, data: unknown) {
    this.emit('event', channel, name, data);
  }
}

const ME = { user_id: 'u1', plan: 'pro_monthly', plan_display_name: 'Pro Monthly', is_active: true, days_remaining: 27, expires_at: '2026-10-16T14:02:11.000Z', expired_at: null };
const FEEDS = {
  data: [
    { id: 'fa', title: 'Alpha calls', type: 'call', channels: [{ channel_external_id: '1', server_external_id: '2', channel_name: 'calls', server_name: 'Alpha' }] },
    { id: 'fb', title: 'Alpha chat', type: 'message', channels: [] },
  ],
};
const call = (n: number) => ({ id: n, platform: 'discord', server_external_id: '2', channel_external_id: '1', caller_external_id: '9', message_external_id: String(1000 + n), chain: 'solana', token_address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', token_symbol: 'BONK', market_cap_at_call: 1000 * n, timestamp: `2026-09-19T14:0${n}:00.000Z`, caller_display_name: 'Dave' });
const message = (n: number) => ({ id: n, external_id: String(2000 + n), platform: 'discord', server_external_id: '2', channel_external_id: '3', caller_external_id: '9', content: `msg ${n}`, timestamp: `2026-09-19T14:0${n}:00.000Z`, author_display_name: 'Alice', is_bot: false });

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** fetch over a route table; every call is logged with its auth header */
function fakeFetch(routes: Record<string, Route>) {
  const calls: { path: string; auth?: string; body?: string }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname + url.search, auth: headers.get('authorization') ?? undefined, body: typeof init?.body === 'string' ? init.body : undefined });
    const route = routes[url.pathname];
    if (!route) return new Response('nope', { status: 404 });
    return route(url, init);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let client: VampyClient | undefined;
afterEach(() => {
  client?.stop();
  client = undefined;
  vi.useRealTimers();
});

const make = (fetch: typeof fetch, extra: Partial<ConstructorParameters<typeof VampyClient>[0]> = {}) => {
  let pusher: FakePusher | undefined;
  const c = new VampyClient({ apiKey: 'vmp_test', base: 'https://vampy.test/api/v1', fetch, pusher: (o) => (pusher = new FakePusher(o)), retryMs: 20, recheckMs: 50, ...extra });
  const states: [string, string | undefined][] = [];
  const rows: any[] = [];
  const plans: any[] = [];
  c.on('state', (s, e) => states.push([s, e]));
  c.on('row', (r) => rows.push(r));
  c.on('plan', (p) => plans.push(p));
  return { c, states, rows, plans, pusher: () => pusher! };
};

describe('VampyClient', () => {
  it('boots: /me, /feeds, history oldest first, then the socket with one channel per feed', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json(FEEDS),
      '/api/v1/feeds/fa/calls': () => json({ data: [call(2), call(1)], has_more: false }),
      '/api/v1/feeds/fb/messages': () => json({ data: [message(3)], has_more: true }),
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/me', '/api/v1/feeds', '/api/v1/feeds/fa/calls?limit=100', '/api/v1/feeds/fb/messages?limit=100']);
    expect(calls.every((c) => c.auth === 'Bearer vmp_test')).toBe(true);
    expect(t.rows.map((r) => r.msg.text.split('\n')[0])).toEqual(['$BONK DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', '$BONK DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'msg 3']);
    expect(t.rows[0].marketCap).toBe(1000); // call(1) first: oldest first
    expect(t.plans.at(-1)).toEqual({ name: 'Pro Monthly', expiresAt: Date.parse(ME.expires_at), daysRemaining: 27, feeds: 2, feedIds: ['fa', 'fb'] });
    expect(t.c.feeds.map((f) => f.id)).toEqual(['fa', 'fb']);
    expect(t.pusher().wanted).toEqual(['private-user-u1-feed-fa', 'private-user-u1-feed-fb']);
    expect(t.pusher().opts.url).toBe('wss://ws.vampy.app');
    expect(t.pusher().opts.key).toBe('vampy-key');
    expect(t.states.at(-1)).toEqual(['connecting', undefined]);
    t.pusher().open();
    expect(t.c.state).toBe('connected');
    // live rows: only the event that matches the feed's type
    t.pusher().push('private-user-u1-feed-fa', 'new-call', call(5));
    t.pusher().push('private-user-u1-feed-fa', 'new-message', message(6)); // wrong event for a call feed
    t.pusher().push('private-user-u1-feed-fb', 'new-message', JSON.stringify(message(7)) as any); // already parsed by the socket in reality; a string is a message that will not parse into a row
    t.pusher().push('private-user-u1-feed-fb', 'new-message', message(8));
    t.pusher().push('private-user-u1-feed-zz', 'new-message', message(9)); // not ours
    expect(t.rows.slice(3).map((r) => r.msg.id)).toEqual(['vampy:fa:1:1005:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'vampy:fb:3:2008']);
  });

  it('authorizes private channels through the API with the socket id and channel, form-encoded', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json({ data: [FEEDS.data[1]] }),
      '/api/v1/feeds/fb/messages': () => json({ data: [] }),
      '/api/v1/pusher/auth': () => json({ auth: 'vampy-key:deadbeef' }),
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    await expect(t.pusher().opts.authorize('4.2', 'private-user-u1-feed-fb')).resolves.toBe('vampy-key:deadbeef');
    const auth = calls.find((c) => c.path === '/api/v1/pusher/auth')!;
    expect(auth.auth).toBe('Bearer vmp_test');
    expect(auth.body).toBe('socket_id=4.2&channel_name=private-user-u1-feed-fb');
  });

  it('reads recent rows again after the socket reconnects', async () => {
    let page = 0;
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json({ data: [FEEDS.data[0]] }),
      '/api/v1/feeds/fa/calls': () => json({ data: [call(++page)] }),
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    t.pusher().open('1.1');
    expect(calls.filter((c) => c.path.startsWith('/api/v1/feeds/fa/calls')).map((c) => c.path)).toEqual(['/api/v1/feeds/fa/calls?limit=100']);
    t.pusher().emit('close', 1006, '');
    expect(t.c.state).toBe('connecting');
    t.pusher().open('2.1');
    await until(() => calls.filter((c) => c.path.startsWith('/api/v1/feeds/fa/calls')).length === 2);
    expect(calls.at(-1)!.path).toBe('/api/v1/feeds/fa/calls?limit=50');
    expect(t.c.state).toBe('connected');
    await until(() => t.rows.length === 2);
  });

  it('a wrong key is an auth error; a lapsed plan too, and it disconnects the socket', async () => {
    const t1 = make(fakeFetch({ '/api/v1/me': () => json({ error: 'unauthorized' }, 401) }).fetch);
    client = t1.c;
    t1.c.start();
    await until(() => t1.c.state === 'auth_error');
    expect(t1.states.at(-1)![1]).toMatch(/rejected the API key/);
    t1.c.stop();

    let meStatus = 200;
    const { fetch } = fakeFetch({
      '/api/v1/me': () => (meStatus === 200 ? json(ME) : json({ error: 'subscription_required' }, 403)),
      '/api/v1/feeds': () => json({ data: [FEEDS.data[0]] }),
      '/api/v1/feeds/fa/calls': () => json({ data: [] }),
    });
    const t = make(fetch, { recheckMs: 30 });
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    t.pusher().open();
    expect(t.c.state).toBe('connected');
    meStatus = 403;
    await until(() => t.c.state === 'auth_error');
    expect(t.states.at(-1)![1]).toMatch(/subscription .* not active/);
    expect(t.pusher().stopped).toBe(1);
    expect(t.plans.at(-1)).toBeUndefined();
    // the plan comes back: the hourly look boots again with the same key
    meStatus = 200;
    await until(() => t.c.state === 'connected' || t.pusher().started === 2 || t.c.state === 'connecting');
    await until(() => t.c.feeds.length === 1 && t.c.state !== 'auth_error');
  });

  it('waits out a 429 and retries a network failure at boot', async () => {
    let hits = 0;
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => (++hits === 1 ? json({}, 429, { 'retry-after': '0.01' }) : json(ME)),
      '/api/v1/feeds': () => json({ data: [] }),
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    expect(calls.filter((c) => c.path === '/api/v1/me')).toHaveLength(2);
    t.c.stop();

    let down = true;
    const f2 = fakeFetch({
      '/api/v1/me': () => {
        if (down) throw new TypeError('fetch failed');
        return json(ME);
      },
      '/api/v1/feeds': () => json({ data: [] }),
    });
    const t2 = make(f2.fetch, { retryMs: 10 });
    client = t2.c;
    t2.c.start();
    await until(() => t2.states.some(([s, e]) => s === 'connecting' && /unreachable/.test(e ?? '')));
    down = false;
    await until(() => t2.pusher()?.started === 1);
    expect(t2.c.state).toBe('connecting');
  });

  it('the hourly recheck subscribes feeds added on vampy.app and drops removed ones', async () => {
    let feeds = { data: [FEEDS.data[0]] };
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json(feeds),
      '/api/v1/feeds/fa/calls': () => json({ data: [] }),
      '/api/v1/feeds/fb/messages': () => json({ data: [message(1)] }),
    });
    const t = make(fetch, { recheckMs: 30 });
    client = t.c;
    t.c.start();
    await until(() => t.pusher()?.started === 1);
    t.pusher().open();
    feeds = { data: [FEEDS.data[1]] };
    await until(() => t.pusher().wanted.includes('private-user-u1-feed-fb'));
    expect(t.pusher().wanted).toEqual(['private-user-u1-feed-fb']);
    expect(calls.some((c) => c.path === '/api/v1/feeds/fb/messages?limit=100')).toBe(true);
    expect(t.rows.map((r) => r.msg.id)).toEqual(['vampy:fb:3:2001']);
    expect(t.plans.at(-1)).toMatchObject({ feeds: 1 });
    expect(t.c.feeds.map((f) => f.id)).toEqual(['fb']);
  });

  it('stop() ends the run: a boot still in flight changes nothing afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch } = fakeFetch({
      '/api/v1/me': async () => {
        await gate;
        return json(ME);
      },
      '/api/v1/feeds': () => json(FEEDS),
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    t.c.stop();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.c.feeds).toEqual([]);
    expect(t.c.state).toBe('disconnected');
  });
});

describe('VampyClient after the review', () => {
  it('starts over from /me after a fatal socket error', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json({ data: [FEEDS.data[0]] }),
      '/api/v1/feeds/fa/calls': () => json({ data: [] }),
    });
    const pushers: FakePusher[] = [];
    const c = new VampyClient({ apiKey: 'vmp_test', base: 'https://vampy.test/api/v1', fetch, pusher: (o) => { const p = new FakePusher(o); pushers.push(p); return p; }, retryMs: 10, recheckMs: 10_000 });
    client = c;
    const states: [string, string | undefined][] = [];
    c.on('state', (s, e) => states.push([s, e]));
    c.start();
    await until(() => pushers.length === 1);
    pushers[0].open();
    pushers[0].emit('fatal', 'App key does not exist');
    expect(states.at(-1)).toEqual(['connecting', 'realtime refused: App key does not exist']);
    expect(pushers[0].stopped).toBe(1);
    await until(() => pushers.length === 2);
    expect(calls.filter((x) => x.path === '/api/v1/me')).toHaveLength(2);
    expect(pushers[1].wanted).toEqual(['private-user-u1-feed-fa']);
  });

  it('a history read that outlives stop() emits nothing, and history rows are marked as such', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch } = fakeFetch({
      '/api/v1/me': () => json(ME),
      '/api/v1/feeds': () => json({ data: [FEEDS.data[0]] }),
      '/api/v1/feeds/fa/calls': async () => {
        await gate;
        return json({ data: [call(1)] });
      },
    });
    const t = make(fetch);
    client = t.c;
    t.c.start();
    await new Promise((r) => setTimeout(r, 20)); // /me and /feeds answered; the history GET is waiting
    t.c.stop();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.rows).toEqual([]);

    const t2 = make(fakeFetch({ '/api/v1/me': () => json(ME), '/api/v1/feeds': () => json({ data: [FEEDS.data[0]] }), '/api/v1/feeds/fa/calls': () => json({ data: [call(1)] }) }).fetch);
    client = t2.c;
    t2.c.start();
    await until(() => t2.rows.length === 1);
    expect(t2.rows[0].history).toBe(true);
    t2.pusher().open();
    t2.pusher().push('private-user-u1-feed-fa', 'new-call', call(2));
    expect(t2.rows[1].history).toBeUndefined();
    expect(t2.plans.at(-1)).toMatchObject({ feedIds: ['fa'] });
  });
});
