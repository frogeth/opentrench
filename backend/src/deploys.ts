import type { J7Deploy } from './types.js';

/**
 * "Which tokens were launched off this tweet?" — the launchpads put the tweet URL in the
 * token's twitter/website metadata, so we walk their newest-first lists back to the tweet's
 * time and keep the ones that link the tweet (strong) or the account (weak).
 * Unofficial endpoints: pump.fun's frontend API and Raydium LaunchLab (letsbonk.fun).
 */
const PUMP = 'https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&includeNsfw=true&limit=70&offset=';
const BONK = 'https://launch-mint-v1.raydium.io/get/list?platformId=FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1&sort=new&size=100&mintType=default&includeNsfw=true';
const PUMP_PAGES = 30; // 70 per page: ~2,100 launches, a couple of hours on a busy day
const BONK_PAGES = 10;
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
  scanned: { pump?: number; bonk?: number };
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

export function mapPump(c: any, match: J7Deploy['match']): J7Deploy {
  return {
    source: 'pump',
    mint: String(c.mint),
    name: String(c.name ?? ''),
    symbol: String(c.symbol ?? ''),
    image: typeof c.image_uri === 'string' ? c.image_uri : undefined,
    createdAt: num(c.created_timestamp) ?? Date.now(),
    marketCap: num(c.usd_market_cap ?? c.market_cap_usd),
    twitter: String(c.twitter ?? ''),
    match,
    url: `https://pump.fun/coin/${c.mint}`,
  };
}

export function mapBonk(c: any, match: J7Deploy['match']): J7Deploy {
  return {
    source: 'bonk',
    mint: String(c.mint),
    name: String(c.name ?? ''),
    symbol: String(c.symbol ?? ''),
    image: typeof c.imgUrl === 'string' ? c.imgUrl : undefined,
    createdAt: num(c.createAt) ?? Date.now(),
    marketCap: num(c.marketCap),
    twitter: String(c.twitter ?? ''),
    match,
    url: `https://letsbonk.fun/token/${c.mint}`,
  };
}

export function createDeployFinder(fetchImpl: typeof fetch = fetch, ttlMs = 60_000) {
  const cache = new Map<string, { at: number; p: Promise<DeployResult> }>();
  const getJson = async (url: string) => {
    const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
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
          const created = num(c.created_timestamp) ?? 0;
          oldest = oldest === undefined ? created : Math.min(oldest, created);
          const m = matchLink([c.twitter, c.website, c.telegram, c.description], q.tweetId, q.handle);
          if (m) out.push(mapPump(c, m));
        }
        if (rows.length < 70 || (oldest !== undefined && oldest < floor)) done = true;
      }
      if (done) break;
    }
    return oldest;
  }

  async function scanBonk(q: DeployQuery, out: J7Deploy[]): Promise<number | undefined> {
    const floor = q.since - SLACK_MS;
    let oldest: number | undefined;
    let next: string | undefined;
    for (let page = 0; page < BONK_PAGES; page++) {
      let data: any;
      try {
        data = (await getJson(BONK + (next ? `&nextPageId=${encodeURIComponent(next)}` : ''))).data;
      } catch {
        return oldest;
      }
      const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
      for (const c of rows) {
        const created = num(c.createAt) ?? 0;
        oldest = oldest === undefined ? created : Math.min(oldest, created);
        const m = matchLink([c.twitter, c.website, c.description], q.tweetId, q.handle);
        if (m) out.push(mapBonk(c, m));
      }
      next = typeof data?.nextPageId === 'string' ? data.nextPageId : undefined;
      if (!next || rows.length === 0 || (oldest !== undefined && oldest < floor)) break;
    }
    return oldest;
  }

  return {
    async find(q: DeployQuery): Promise<DeployResult> {
      const key = `${q.tweetId}:${q.handle.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.p;
      const p = (async () => {
        const deploys: J7Deploy[] = [];
        const [pump, bonk] = await Promise.all([scanPump(q, deploys), scanBonk(q, deploys)]);
        // exact-tweet links first, then newest
        deploys.sort((a, b) => (a.match === b.match ? b.createdAt - a.createdAt : a.match === 'tweet' ? -1 : 1));
        const seen = new Set<string>();
        return { deploys: deploys.filter((d) => !seen.has(d.mint) && seen.add(d.mint)), scanned: { pump, bonk } };
      })();
      cache.set(key, { at: Date.now(), p });
      p.catch(() => cache.delete(key));
      return p;
    },
  };
}
