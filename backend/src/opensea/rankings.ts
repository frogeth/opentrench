import { EventEmitter } from 'node:events';
import { gql, OPENSEA } from './gql.js';
import type { NftRanking, RankingKey, RankingSlug, RankingTimeframe } from '../types.js';

export const RANKINGS_QUERY = `query CollectionRankingsQuery($slug: CollectionRankingSlug!, $timeframe: Timeframe!, $limit: Int!) {
  collectionRankings(slug: $slug, timeframe: $timeframe, limit: $limit) {
    items { score collection { id slug name imageUrl isVerified chain { identifier }
      stats { oneHour { volume { usd native { unit symbol } } sales floorPriceChange } oneDay { volume { usd native { unit symbol } } sales floorPriceChange } ownerCount totalSupply listedItemCount }
      floorPrice { pricePerItem { usd token { unit symbol } } }
      topOffer { pricePerItem { usd token { unit symbol } } }
      drop { __typename stages { stageType startTime endTime } } } }
  }
}`;

const price = (p: any) => (p?.pricePerItem && Number.isFinite(Number(p.pricePerItem.usd)) ? { usd: Number(p.pricePerItem.usd), unit: Number(p.pricePerItem.token?.unit ?? 0), symbol: String(p.pricePerItem.token?.symbol ?? '') } : undefined);

/** Returns `undefined` for null/undefined/non-finite, unlike `Number()` which coerces null to 0. */
const int = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** GraphQL items → rows for one timeframe. Pure. */
export function normalizeRankings(items: any[], timeframe: RankingTimeframe, now: number): NftRanking[] {
  const out: NftRanking[] = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 100)) {
    const c = it?.collection;
    if (!c || typeof c.slug !== 'string' || !c.slug) continue;
    const w = timeframe === 'ONE_DAY' ? c.stats?.oneDay : c.stats?.oneHour;
    const open = (c.drop?.stages ?? []).find((s: any) => {
      const a = Date.parse(s?.startTime ?? '');
      const b = Date.parse(s?.endTime ?? '');
      return Number.isFinite(a) && a <= now && (!Number.isFinite(b) || now < b);
    });
    out.push({
      rank: out.length + 1,
      slug: c.slug,
      name: String(c.name ?? c.slug).slice(0, 120),
      image: typeof c.imageUrl === 'string' && c.imageUrl ? c.imageUrl : undefined,
      verified: !!c.isVerified,
      chain: String(c.chain?.identifier ?? ''),
      floor: price(c.floorPrice),
      topOffer: price(c.topOffer),
      volume: { usd: Number(w?.volume?.usd ?? 0) || 0, unit: Number(w?.volume?.native?.unit ?? 0) || 0, symbol: String(w?.volume?.native?.symbol ?? '') },
      sales: Number(w?.sales ?? 0) || 0,
      floorChange: Number.isFinite(Number(w?.floorPriceChange)) && w?.floorPriceChange !== null ? Number(w.floorPriceChange) : undefined,
      owners: int(c.stats?.ownerCount),
      supply: int(c.stats?.totalSupply),
      listed: int(c.stats?.listedItemCount),
      minting: open ? { stageType: String(open.stageType ?? ''), endTime: open.endTime ?? undefined } : undefined,
    });
  }
  return out;
}

const KEY_RE = /^(TRENDING|TOP):(ONE_HOUR|ONE_DAY)$/;

export const parseKey = (key: RankingKey): { slug: RankingSlug; timeframe: RankingTimeframe } => {
  if (!KEY_RE.test(key)) throw new Error('bad ranking key: ' + key);
  const [slug, timeframe] = key.split(':') as [RankingSlug, RankingTimeframe];
  return { slug, timeframe };
};

export async function fetchRankings(key: RankingKey, fetchImpl?: typeof fetch): Promise<NftRanking[]> {
  const { slug, timeframe } = parseKey(key);
  const data = await gql<{ collectionRankings: { items: any[] } }>('CollectionRankingsQuery', RANKINGS_QUERY, { slug, timeframe, limit: 50 }, { referer: `${OPENSEA}/collections`, fetchImpl });
  return normalizeRankings(data.collectionRankings?.items ?? [], timeframe, Date.now());
}

const POLL_MS = 60_000;

/**
 * Polls collectionRankings once a minute for every key a column wants; emits 'rankings' (key, rows, at).
 * `stop()` is used by tests only — production relies on unref'd timers and never calls it.
 */
export class RankingsPoller extends EventEmitter {
  readonly latest: Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>> = {};
  private wanted = new Set<RankingKey>();
  private timers = new Map<RankingKey, NodeJS.Timeout>();
  private firstPolls = new Map<RankingKey, NodeJS.Timeout>();
  private inFlight = new Set<RankingKey>();
  private failing = new Set<RankingKey>();
  constructor(private fetchImpl?: typeof fetch) {
    super();
  }
  want(keys: RankingKey[]): void {
    const next = new Set(keys);
    for (const k of this.timers.keys()) if (!next.has(k)) {
      clearInterval(this.timers.get(k));
      this.timers.delete(k);
    }
    for (const k of this.firstPolls.keys()) if (!next.has(k)) {
      clearTimeout(this.firstPolls.get(k));
      this.firstPolls.delete(k);
    }
    for (const k of Object.keys(this.latest) as RankingKey[]) if (!next.has(k)) {
      delete this.latest[k];
      this.failing.delete(k);
    }
    this.wanted = next;
    let i = 0;
    for (const k of next) {
      if (this.timers.has(k)) continue;
      const t = setInterval(() => void this.poll(k), POLL_MS);
      t.unref();
      this.timers.set(k, t);
      const ft = setTimeout(() => {
        this.firstPolls.delete(k);
        void this.poll(k);
      }, 2000 * i++); // stagger the first fetches
      ft.unref();
      this.firstPolls.set(k, ft);
    }
  }
  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    for (const t of this.firstPolls.values()) clearTimeout(t);
    this.firstPolls.clear();
    this.wanted.clear();
    this.failing.clear();
  }
  async poll(key: RankingKey): Promise<void> {
    if (!this.wanted.has(key)) return;
    if (this.inFlight.has(key)) return;
    if (!KEY_RE.test(key)) return;
    this.inFlight.add(key);
    try {
      const rows = await fetchRankings(key, this.fetchImpl);
      const at = Date.now();
      this.latest[key] = { rows, at };
      this.failing.delete(key);
      this.emit('rankings', key, rows, at);
    } catch (e: any) {
      if (!this.failing.has(key)) console.warn('[opensea] rankings', key, e?.message ?? e);
      this.failing.add(key);
    } finally {
      this.inFlight.delete(key);
    }
  }
}

export const keyFor = (c: { ranking?: 'trending' | 'top'; timeframe?: '1h' | '1d' }): RankingKey => `${c.ranking === 'top' ? 'TOP' : 'TRENDING'}:${c.timeframe === '1d' ? 'ONE_DAY' : 'ONE_HOUR'}`;
