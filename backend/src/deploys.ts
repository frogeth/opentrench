import type { J7Deploy, J7Tweet } from './types.js';

/**
 * "Which tokens were launched off this tweet?" — launchpads put the tweet URL in the token's
 * social links, so we read their newest-first lists and keep the ones that link the tweet
 * (strong) or the account (weak). Two sources, both unofficial:
 *  - pump.fun's frontend API (Solana): the list carries the twitter link.
 *  - Pons on Robinhood Chain (ponsfamily.com): the list has no socials, so each new token's
 *    detail page (React Server Components payload) is read once for its twitter link.
 */
const PUMP = 'https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=true&limit=70&offset=';
const PONS = 'https://www.ponsfamily.com/api/pons-launches?explore=1&sort=newest&age=all&pageSize=100&graduatedPage=1&graduatedPageSize=1&includeGraduated=0&version=all&v=22&page=';
const PONS_PAGE = 'https://www.ponsfamily.com/launchpad/';
const PUMP_PAGES = 30; // 70 per page: ~2,100 launches, a couple of hours on a busy day
const PONS_PAGES = 12; // 100 per page, ~15 minutes each
const PONS_DETAIL_CAP = 80; // detail reads per on-demand scan
const PONS_DETAIL_WINDOW_MS = 60 * 60_000; // a launch "off a tweet" lands soon after it
const SLACK_MS = 10 * 60_000; // clocks disagree a little; look slightly past the tweet
const HEADERS = { 'user-agent': 'Mozilla/5.0 (opentrench)', accept: 'application/json' };

export interface DeployQuery {
  tweetId: string;
  handle: string;
  /** when the tweet was posted (ms) */
  since: number;
}
export interface DeployResult {
  deploys: J7Deploy[];
  /** oldest launch time we looked at per launchpad; undefined when the launchpad was unreachable */
  scanned: { pump?: number; pons?: number };
}

/** 'tweet' when a metadata link points at this exact tweet, 'account' when it points at the author, else undefined. */
export function matchLink(fields: (string | undefined | null)[], tweetId: string, handle: string): J7Deploy['match'] | undefined {
  const h = handle.replace(/^@/, '').toLowerCase();
  let acct = false;
  for (const raw of fields) {
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    if (s.includes(`/status/${tweetId}`) || s.includes(`/statuses/${tweetId}`) || s.trim() === tweetId) return 'tweet';
    if (h && new RegExp(`(?:x|twitter)\\.com/@?${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`).test(s)) acct = true;
  }
  return acct ? 'account' : undefined;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

export function mapPump(c: any): Omit<J7Deploy, 'match'> & { links: string[] } {
  return {
    source: 'pump',
    mint: String(c.mint),
    name: String(c.name ?? ''),
    symbol: String(c.symbol ?? ''),
    image: typeof c.image_uri === 'string' ? c.image_uri : undefined,
    createdAt: num(c.created_timestamp) ?? Date.now(),
    marketCap: num(c.usd_market_cap ?? c.market_cap_usd),
    twitter: String(c.twitter ?? ''),
    url: `https://pump.fun/coin/${c.mint}`,
    links: [c.twitter, c.website, c.telegram, c.description].filter((x) => typeof x === 'string'),
  };
}

export function mapPons(c: any, twitter = ''): Omit<J7Deploy, 'match'> & { links: string[] } {
  return {
    source: 'pons',
    mint: String(c.token),
    name: String(c.name ?? ''),
    symbol: String(c.symbol ?? ''),
    image: typeof c.logo === 'string' ? c.logo : undefined,
    createdAt: Date.parse(String(c.launchedAt)) || Date.now(),
    marketCap: num(c.marketCapUsd),
    twitter,
    url: PONS_PAGE + c.token,
    links: [twitter, c.description].filter((x) => typeof x === 'string'),
  };
}

/** Pull the socials block out of a Pons token page's RSC payload. */
export function parsePonsSocials(payload: string): { twitter?: string; telegram?: string; website?: string } {
  const m = /"socials":(\{[^{}]*\})/.exec(payload);
  if (!m) return {};
  try {
    const s = JSON.parse(m[1]);
    return { twitter: s.twitter || undefined, telegram: s.telegram || undefined, website: s.website || undefined };
  } catch {
    return {};
  }
}

type Launch = Omit<J7Deploy, 'match'> & { links: string[] };

export function createDeployFinder(fetchImpl: typeof fetch = fetch, ttlMs = 60_000) {
  const cache = new Map<string, { at: number; p: Promise<DeployResult> }>();
  const ponsSocials = new Map<string, Promise<string>>(); // token → twitter link ('' when none)
  const getJson = async (url: string) => {
    const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };
  const ponsTwitter = (token: string): Promise<string> => {
    const key = token.toLowerCase();
    let p = ponsSocials.get(key);
    if (!p) {
      p = fetchImpl(PONS_PAGE + token, { headers: { ...HEADERS, accept: 'text/x-component', RSC: '1' }, signal: AbortSignal.timeout(12_000) })
        .then(async (r) => (r.ok ? parsePonsSocials(await r.text()).twitter ?? '' : ''))
        .catch(() => '');
      ponsSocials.set(key, p);
      if (ponsSocials.size > 5000) ponsSocials.delete(ponsSocials.keys().next().value!);
    }
    return p;
  };

  async function scanPump(q: DeployQuery, out: J7Deploy[]): Promise<number | undefined> {
    const floor = q.since - SLACK_MS;
    let oldest: number | undefined;
    for (let page = 0; page < PUMP_PAGES; page += 3) {
      const pages = await Promise.all([0, 1, 2].map((k) => (page + k < PUMP_PAGES ? getJson(PUMP + (page + k) * 70).catch(() => null) : null)));
      let done = false;
      for (const rows of pages) {
        if (!Array.isArray(rows)) {
          if (rows === null && oldest === undefined) return undefined;
          done = true;
          break;
        }
        for (const c of rows) {
          const l = mapPump(c);
          oldest = oldest === undefined ? l.createdAt : Math.min(oldest, l.createdAt);
          const m = matchLink(l.links, q.tweetId, q.handle);
          if (m) out.push({ ...l, match: m });
        }
        if (rows.length < 70 || (oldest !== undefined && oldest < floor)) done = true;
      }
      if (done) break;
    }
    return oldest;
  }

  async function scanPons(q: DeployQuery, out: J7Deploy[]): Promise<number | undefined> {
    const floor = q.since - SLACK_MS;
    let oldest: number | undefined;
    const candidates: Launch[] = [];
    // deep pages are slow on their side (3-5s each): read three at a time
    for (let page = 1; page <= PONS_PAGES; page += 3) {
      const pages = await Promise.all([0, 1, 2].map((k) => (page + k <= PONS_PAGES ? getJson(PONS + (page + k)).catch(() => null) : null)));
      let done = false;
      for (const d of pages) {
        if (d === null) {
          if (oldest === undefined) return undefined;
          done = true;
          break;
        }
        const rows: any[] = Array.isArray(d?.active?.items) ? d.active.items : [];
        for (const c of rows) {
          const l = mapPons(c);
          oldest = oldest === undefined ? l.createdAt : Math.min(oldest, l.createdAt);
          if (l.createdAt >= floor && l.createdAt <= q.since + PONS_DETAIL_WINDOW_MS) candidates.push(l);
        }
        if (rows.length < 100 || (oldest !== undefined && oldest < floor)) done = true;
      }
      if (done) break;
    }
    // socials live on the token page: read them for launches in the window after the tweet, a few at a time
    const picked = candidates.slice(0, PONS_DETAIL_CAP);
    for (let i = 0; i < picked.length; i += 5) {
      const batch = picked.slice(i, i + 5);
      const tws = await Promise.all(batch.map((l) => ponsTwitter(l.mint)));
      batch.forEach((l, k) => {
        const m = matchLink([tws[k], ...l.links], q.tweetId, q.handle);
        if (m) out.push({ ...l, twitter: tws[k], match: m });
      });
    }
    return oldest;
  }

  return {
    ponsTwitter,
    async find(q: DeployQuery): Promise<DeployResult> {
      const key = `${q.tweetId}:${q.handle.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.p;
      const p = (async () => {
        const deploys: J7Deploy[] = [];
        const [pump, pons] = await Promise.all([scanPump(q, deploys), scanPons(q, deploys)]);
        // exact-tweet links first, then newest
        deploys.sort((a, b) => (a.match === b.match ? b.createdAt - a.createdAt : a.match === 'tweet' ? -1 : 1));
        const seen = new Set<string>();
        return { deploys: deploys.filter((d) => !seen.has(d.mint) && seen.add(d.mint)), scanned: { pump, pons } };
      })();
      cache.set(key, { at: Date.now(), p });
      p.catch(() => cache.delete(key));
      return p;
    },
  };
}

/**
 * Live watcher: while the J7 column is open, poll both launchpads' newest page every few
 * seconds and pair each new launch with the tweet it links (or the account, weakly), both
 * ways — a launch that arrives before J7 relays the tweet is matched when the tweet lands.
 */
export interface LaunchWatcherOpts {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** how long a launch stays matchable against tweets that arrive later */
  ringMs?: number;
  tweets: () => J7Tweet[];
  onMatch: (tweetId: string, deploy: J7Deploy) => void;
}

export function createLaunchWatcher(opts: LaunchWatcherOpts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const finder = createDeployFinder(fetchImpl);
  const intervalMs = opts.intervalMs ?? 5000;
  const ringMs = opts.ringMs ?? 30 * 60_000;
  const seen = new Set<string>();
  const ring: Launch[] = [];
  let timer: NodeJS.Timeout | undefined;
  let primed = false;
  let busy = false;

  const getJson = async (url: string) => {
    const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };

  const tweetIdOf = (t: J7Tweet) => t.id.replace(/^deleted:/, '');
  const pair = (l: Launch, tweets: J7Tweet[]) => {
    for (const t of tweets) {
      if (t.deleted) continue; // the original entry carries the launches; the deleted copy mirrors it
      const m = matchLink(l.links, tweetIdOf(t), t.author.handle);
      if (m) opts.onMatch(t.id, { ...l, match: m });
    }
  };

  const admit = (l: Launch) => {
    const key = `${l.source}:${l.mint}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 20_000) seen.delete(seen.keys().next().value!);
    if (!primed) return; // first poll only learns what already exists
    ring.push(l);
    pair(l, opts.tweets());
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cutoff = Date.now() - ringMs;
      while (ring.length && ring[0].createdAt < cutoff) ring.shift();
      const [pump, pons] = await Promise.all([getJson(PUMP + 0).catch(() => null), getJson(PONS + 1).catch(() => null)]);
      if (Array.isArray(pump)) for (const c of pump) admit(mapPump(c));
      const rows: any[] = Array.isArray(pons?.active?.items) ? pons.active.items : [];
      // socials need one page read per token; do them newest first, sequentially, to stay polite
      for (const c of rows) {
        const key = `pons:${c.token}`;
        if (seen.has(key)) continue;
        const tw = primed ? await finder.ponsTwitter(String(c.token)) : '';
        const l = mapPons(c, tw);
        admit(l);
      }
      primed = true;
    } finally {
      busy = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** a tweet just arrived: pair it with launches we already saw */
    matchTweet(t: J7Tweet) {
      if (t.deleted) return;
      for (const l of ring) {
        const m = matchLink(l.links, tweetIdOf(t), t.author.handle);
        if (m) opts.onMatch(t.id, { ...l, match: m });
      }
    },
    /** for tests */
    _tick: tick,
    ringSize: () => ring.length,
  };
}
