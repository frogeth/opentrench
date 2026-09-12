import { gql, OPENSEA, OpenSeaError } from './gql.js';
import type { OpenSeaSession } from './session.js';

export interface DropStage { kind: string; type: string; index: number; startTime?: string; endTime?: string; maxPerWallet?: number }
export interface DropCollection { slug: string; name: string; image?: string; address: string; chain: string; networkId: number; drop?: { kind: string; address: string; stages: DropStage[] } }
export interface StageEligibility { type: string; index: number; eligible: boolean; maxPerWallet?: number; eligibleMax?: number; priceUnit?: number; priceUsd?: number; priceSymbol?: string }
export interface Eligibility { kind: string; minted: number; stages: StageEligibility[] }
export interface MintTx { to: string; data: string; value: string; networkId: number; chain: string }

/** Returns `undefined` for null/undefined/non-finite, unlike `Number()` which coerces null to 0. */
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const int = num;

export function parseLocator(s: string): { slug: string } | { address: string } | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { address: t.toLowerCase() };
  if (/^[A-Za-z0-9_-]{1,200}$/.test(t)) return { slug: t };
  try {
    const u = new URL(t);
    if (u.hostname !== 'opensea.io' && u.hostname !== 'www.opensea.io') return undefined;
    const m = /^\/collection\/([A-Za-z0-9_-]{1,200})/.exec(u.pathname);
    return m ? { slug: m[1] } : undefined;
  } catch {
    return undefined;
  }
}

const COLLECTION_QUERY = `query MintCollectionMetadata($slug: String!) { collectionBySlug(slug: $slug) { __typename ... on Collection { slug name imageUrl address chain { identifier networkId } drop { __typename identifier { contractAddress chain { identifier } } stages { __typename stageType stageIndex startTime endTime maxTotalMintableByWallet } } } } }`;
const SEARCH_QUERY = `query MintCollectionSearch($query: String!) { collectionsByQuery(query: $query, limit: 50) { __typename slug address chain { identifier networkId } } }`;
const ELIGIBILITY_QUERY = `query DropEligibilityQuery($collectionSlug: String!, $address: Address!) { dropBySlug(slug: $collectionSlug) { __typename ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) } stages { __typename stageType stageIndex isEligible eligibleMinterAddress maxTotalMintableByWallet eligibleMaxTotalMintableByWallet eligiblePrice { usd token { unit symbol contractAddress chain { identifier } } } } } }`;
const MINT_ACTION_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address) { swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } } }`;

export function decodeCollection(c: any): DropCollection | undefined {
  if (!c || c.__typename !== 'Collection' || typeof c.slug !== 'string') return undefined;
  const stages: DropStage[] = (c.drop?.stages ?? []).map((s: any) => ({
    kind: String(s.__typename ?? ''),
    type: String(s.stageType ?? ''),
    index: int(s.stageIndex) ?? 0,
    startTime: s.startTime ?? undefined,
    endTime: s.endTime ?? undefined,
    maxPerWallet: int(s.maxTotalMintableByWallet),
  }));
  return {
    slug: c.slug,
    name: String(c.name ?? c.slug),
    image: c.imageUrl || undefined,
    address: String(c.address ?? '').toLowerCase(),
    chain: String(c.chain?.identifier ?? ''),
    networkId: Number(c.chain?.networkId ?? 0),
    drop: c.drop?.identifier?.contractAddress ? { kind: String(c.drop.__typename ?? ''), address: String(c.drop.identifier.contractAddress).toLowerCase(), stages } : undefined,
  };
}

/** A slug, an opensea.io collection URL or a 0x address (preferring `chain` when several chains share it) → the collection. */
export async function resolveCollection(locator: string, chain?: string, fetchImpl?: typeof fetch): Promise<DropCollection> {
  const p = parseLocator(locator);
  if (!p) throw new OpenSeaError('compat', 'Paste an OpenSea collection slug, link or contract address.');
  let slug: string;
  if ('slug' in p) slug = p.slug;
  else {
    const d = await gql<{ collectionsByQuery: any[] }>('MintCollectionSearch', SEARCH_QUERY, { query: p.address }, { referer: `${OPENSEA}/`, fetchImpl });
    const hits = (d.collectionsByQuery ?? []).filter((c) => String(c?.address ?? '').toLowerCase() === p.address && c.slug && c.slug.toLowerCase() !== p.address);
    // Stable default when no chain is requested and several hits exist: ethereum first.
    hits.sort((a, b) => (a.chain?.identifier === 'ethereum' ? -1 : 0) - (b.chain?.identifier === 'ethereum' ? -1 : 0));
    const hit = (chain ? hits.find((c) => c.chain?.identifier === chain) : undefined) ?? hits[0];
    if (!hit) throw new OpenSeaError('compat', 'OpenSea has no collection at that address.');
    slug = hit.slug;
  }
  const d = await gql<{ collectionBySlug: any }>('MintCollectionMetadata', COLLECTION_QUERY, { slug }, { referer: `${OPENSEA}/collection/${slug}/overview`, fetchImpl });
  const col = decodeCollection(d.collectionBySlug);
  if (!col) throw new OpenSeaError('compat', `OpenSea has no collection called ${slug}.`);
  return col;
}

export async function eligibility(session: OpenSeaSession, col: DropCollection): Promise<Eligibility> {
  const d = await session.gql<{ dropBySlug: any }>(col.networkId, col.slug, 'DropEligibilityQuery', ELIGIBILITY_QUERY, { collectionSlug: col.slug, address: session.address.toLowerCase() });
  const drop = d.dropBySlug;
  if (!drop) throw new OpenSeaError('compat', 'This collection is not an OpenSea drop.');
  return {
    kind: String(drop.__typename ?? ''),
    minted: int(drop.minterQuantityMinted) ?? 0,
    stages: (drop.stages ?? []).map((s: any) => ({
      type: String(s.stageType ?? ''),
      index: int(s.stageIndex) ?? 0,
      eligible: s.isEligible === true,
      maxPerWallet: int(s.maxTotalMintableByWallet),
      eligibleMax: int(s.eligibleMaxTotalMintableByWallet),
      priceUnit: num(s.eligiblePrice?.token?.unit),
      priceUsd: num(s.eligiblePrice?.usd),
      priceSymbol: s.eligiblePrice?.token?.symbol ?? undefined,
    })),
  };
}

const ERROR_SENTENCES: Record<string, string> = {
  InsufficientFundError: "the wallet can't cover the mint price plus gas",
  MintStageNotOpenError: 'the stage is not open right now',
  IneligibleMinterError: 'this wallet is not eligible for the stage',
  MintLimitExceededError: 'that quantity is over the wallet or supply limit',
};
export function mintErrorSentence(types: string[]): string | undefined {
  if (!types.length) return undefined;
  return types.map((t) => ERROR_SENTENCES[t] ?? `OpenSea refused the mint (${t})`).join('; ');
}

/** OpenSea's raw tx.value may be a decimal string or hex; normalise to a decimal string, or undefined if neither. */
function normaliseValue(v: unknown): string | undefined {
  const s = String(v ?? '');
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s).toString();
  if (/^\d+$/.test(s)) return s;
  return undefined;
}

/** OpenSea's transaction for minting `quantity` of the drop to the session wallet. Read-only; nothing is signed here. */
export async function mintAction(session: OpenSeaSession, col: DropCollection, quantity: number): Promise<{ actionTypes: string[]; errors: string[]; tx?: MintTx }> {
  if (!col.drop) throw new OpenSeaError('compat', 'not a drop');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) throw new OpenSeaError('compat', 'quantity must be a positive integer no greater than 10000');
  const d = await session.gql<{ swap: any }>(col.networkId, col.slug, 'MintActionTimelineQuery', MINT_ACTION_QUERY, {
    address: session.address,
    fromAssets: [{ asset: { contractAddress: '0x0000000000000000000000000000000000000000', chain: col.chain }, quantity: null }],
    toAssets: [{ asset: { contractAddress: col.drop.address, chain: col.chain, tokenId: '0' }, quantity: String(quantity) }],
    recipient: null,
  });
  const actions: any[] = d.swap?.actions ?? [];
  const txs = actions.map((a) => a?.transactionSubmissionData).filter(Boolean);
  const t = txs[0];
  const value = t ? normaliseValue(t.value) : undefined;
  return {
    actionTypes: actions.map((a) => String(a?.__typename ?? '')),
    errors: (d.swap?.errors ?? []).map((e: any) => String(e?.__typename ?? '')),
    tx: txs.length === 1 && t && value !== undefined ? { to: String(t.to ?? ''), data: String(t.data ?? ''), value, networkId: Number(t.chain?.networkId ?? 0), chain: String(t.chain?.identifier ?? '') } : undefined,
  };
}
