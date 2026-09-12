# NFT Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new column types: a live MintGo mint feed, an OpenSea trending/top volume table with a 1H/1D switch, and an OpenSea mint window that quotes and sends SeaDrop mints with a locally stored wallet.

**Architecture:** The backend gains a MintGo socket client (like `j7.ts`), an OpenSea GraphQL layer (rankings poller, SIWE session, drop lookups, calldata validator ported from osnm-z) and a Minter that signs with viem and broadcasts to a per-chain RPC. Each pushes typed events through the existing hub → `/ws` → `useFeed` path; the frontend adds one body component per column type and reuses the Column / ColumnEditor / Settings patterns.

**Tech Stack:** Node 22 + TypeScript ESM, express 4, ws 8, viem 2 (new), vitest 5; Vite 6 + React 18.

Spec: `docs/superpowers/specs/2026-09-12-nft-columns-design.md`. Wire formats: `docs/research/2026-09-12-nft-columns-research.md`.

The plan is in three parts after shared groundwork. Part A (MintGo) and Part B (volume) each ship on their own; Part C (mint window) depends on Part B's `opensea/gql.ts` only.

---

## File map

```
backend/package.json                       + viem
backend/src/types.ts                       MintEvent, NftRanking, MintJob, ServerEvent, Status.mintgo
backend/src/config.ts                      column types, ranking/timeframe, opensea config, masked()
backend/src/config.test.ts                 parseColumn for the new types
backend/src/mintgo.ts                      decodeBatch(), MintGoClient
backend/src/mintgo.test.ts
backend/src/opensea/gql.ts                 gql(), OpenSeaError
backend/src/opensea/rankings.ts            normalizeRankings(), RankingsPoller
backend/src/opensea/rankings.test.ts
backend/src/opensea/chains.ts              chain table + RPC defaults
backend/src/opensea/session.ts             buildSiweMessage(), OpenSeaSession
backend/src/opensea/session.test.ts
backend/src/opensea/drops.ts               resolveCollection(), eligibility(), mintAction()
backend/src/opensea/validate.ts            validateMintTransaction()
backend/src/opensea/validate.test.ts
backend/src/opensea/minter.ts              Minter (quote/send/receipt, MintJob log)
backend/src/opensea/minter.test.ts
backend/src/hub.ts                         setMintGo(), hello() extras
backend/src/services.ts                    startMintGo(), rankings, minter
backend/src/api.ts                         routes
frontend/src/types.ts                      mirror of the new types
frontend/src/api.ts                        ColumnDef + MaskedConfig + calls
frontend/src/useFeed.ts                    mints, rankings, mintJobs
frontend/src/components/Icon.tsx           'mint' | 'sea' | 'wallet'
frontend/src/components/Column.tsx         kind icons
frontend/src/components/ColumnEditor.tsx   cards + options
frontend/src/components/MintFeed.tsx
frontend/src/components/NftRankings.tsx
frontend/src/components/OsMintView.tsx
frontend/src/components/Settings.tsx       OpenSea wallet + RPC section
frontend/src/App.tsx                       render switch, ensureMintPane, onMint
frontend/src/index.css
CHANGELOG.md, README.md
```

Commands used throughout (run from the repo root):

```bash
npm test -w backend                       # vitest, all backend tests
npx vitest run src/mintgo.test.ts -w backend   # one file (or: cd backend && npx vitest run src/mintgo.test.ts)
npm run typecheck                         # backend + frontend tsc
npm run dev                               # api on :3210, web on :5173
```

---

## Part 0: Shared groundwork

### Task 1: Types, column types and config

**Files:**
- Modify: `backend/src/types.ts` (append after `J7Tweet` / before `Status`; edit `Status` and `ServerEvent`)
- Modify: `backend/src/config.ts:6-60` (ColumnDef, TYPES, DEFAULT_TITLE, parseColumn) and `:86-116` (Config, DEFAULT), `masked()`
- Test: `backend/src/config.test.ts` (exists; add cases)

- [ ] **Step 1: Add the new types to `backend/src/types.ts`**

Append before `export interface Status`:

```ts
// ---- NFT columns ----
export type MintChain = 'ethereum' | 'robinhood' | 'ink' | 'stable' | 'arc';

/** One mint (one tx) seen by MintGo. `preview` rows are replaced by the confirmed row under the same id. */
export interface MintEvent {
  id: string;
  chain: MintChain;
  ts: number;
  txHash: string;
  blockNumber: number;
  contract: {
    address: string;
    name: string;
    symbol?: string;
    image?: string;
    slug?: string;
    openSeaUrl?: string;
    projectUrl?: string;
    twitterUrl?: string;
    standard?: string;
    deployer?: { address: string; createdAgo?: string; projects?: number };
  };
  quantity: number;
  tokenIds: string[];
  tokenIdsTotal?: number;
  minter: string;
  valueEth?: number;
  unitPriceEth?: number;
  priceConfirmed: boolean;
  preview: boolean;
  airdrop: boolean;
  thirdParty: boolean;
  functionName?: string;
  mintedSupply?: number;
  maxSupply?: number;
  surge?: { mints: number; events: number; minters: number; startedAt: number };
}

export type RankingSlug = 'TRENDING' | 'TOP';
export type RankingTimeframe = 'ONE_HOUR' | 'ONE_DAY';
export type RankingKey = `${RankingSlug}:${RankingTimeframe}`;

export interface NftRanking {
  rank: number;
  slug: string;
  name: string;
  image?: string;
  verified: boolean;
  chain: string;
  floor?: { usd: number; unit: number; symbol: string };
  topOffer?: { usd: number; unit: number; symbol: string };
  volume: { usd: number; unit: number; symbol: string };
  sales: number;
  floorChange?: number;
  owners?: number;
  supply?: number;
  listed?: number;
  minting?: { stageType: string; endTime?: string };
}

export type MintJobState = 'quoting' | 'ready' | 'sending' | 'pending' | 'confirmed' | 'failed';

export interface MintJob {
  id: string;
  ts: number;
  updatedAt: number;
  state: MintJobState;
  collection: { slug: string; name: string; image?: string; address: string; chain: string; networkId: number; dropKind: string };
  stage?: { type: string; index: number; startTime?: string; endTime?: string; maxPerWallet?: number; alreadyMinted?: number };
  quantity: number;
  wallet: string;
  price?: { unitWei: string; totalWei: string; symbol: string; usd?: number };
  gas?: { limit: number; maxFeeWei: string; maxPriorityWei: string; estimateWei: string };
  balanceWei?: string;
  txHash?: string;
  blockNumber?: number;
  tokenIds?: string[];
  error?: string;
}
```

In `Status` add:

```ts
  error: { discord?: string; telegram?: string; j7?: string; mintgo?: string };
  /** MintGo realtime socket */
  mintgo?: 'disconnected' | 'connecting' | 'connected' | 'error';
```

In `ServerEvent` extend the `hello` member with `mints: MintEvent[]; rankings: Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>>; mintJobs: MintJob[]` and add three members:

```ts
  | { type: 'mint'; mint: MintEvent }
  | { type: 'nftRankings'; key: RankingKey; rows: NftRanking[]; at: number }
  | { type: 'mintJob'; job: MintJob }
```

- [ ] **Step 2: Write the failing config tests**

Append to `backend/src/config.test.ts` (it already imports `sanitizeColumns` from `./config.js`; if not, add the import):

```ts
describe('nft column types', () => {
  it('accepts the three new types with their options', () => {
    const cols = sanitizeColumns([
      { id: 'a', type: 'mints', title: '', chats: [], filters: { chains: ['ethereum', 'bogus'], minQty: 2 } },
      { id: 'b', type: 'nftvol', title: '', chats: [], ranking: 'top', timeframe: '1d' },
      { id: 'c', type: 'osmint', title: '', chats: [] },
    ]);
    expect(cols.map((c) => c.type)).toEqual(['mints', 'nftvol', 'osmint']);
    expect(cols.map((c) => c.title)).toEqual(['MintGo', 'OpenSea Volume', 'OpenSea Mint']);
    expect(cols[0].filters).toEqual({ chains: ['ethereum'], minQty: 2 });
    expect(cols[1].ranking).toBe('top');
    expect(cols[1].timeframe).toBe('1d');
  });
  it('defaults a volume column to trending · 1h', () => {
    const [c] = sanitizeColumns([{ id: 'b', type: 'nftvol', title: 'V', chats: [], ranking: 'nope', timeframe: '7d' }]);
    expect(c.ranking).toBe('trending');
    expect(c.timeframe).toBe('1h');
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: FAIL — types fall back to `chat`, titles are `Chats`.

- [ ] **Step 4: Implement in `backend/src/config.ts`**

Replace the `type` line of `ColumnDef` and add two fields:

```ts
  type: 'calls' | 'chat' | 'callers' | 'cove' | 'salpha' | 'j7' | 'web' | 'mints' | 'nftvol' | 'osmint';
  /** nftvol: which OpenSea list, and which rolling window */
  ranking?: 'trending' | 'top';
  timeframe?: '1h' | '1d';
```

Update the constants:

```ts
const TYPES = ['calls', 'callers', 'cove', 'salpha', 'j7', 'web', 'chat', 'mints', 'nftvol', 'osmint'] as const;
const DEFAULT_TITLE: Record<ColumnDef['type'], string> = { calls: 'Calls', callers: 'Top Callers', cove: 'Cove', salpha: 'Salpha', j7: 'J7', web: 'Web', chat: 'Chats', mints: 'MintGo', nftvol: 'OpenSea Volume', osmint: 'OpenSea Mint' };
export const MINT_CHAINS = ['ethereum', 'robinhood', 'ink'] as const;
```

In `parseColumn`, after the `if (type === 'web') {...}` block:

```ts
  if (type === 'nftvol') {
    col.ranking = raw.ranking === 'top' ? 'top' : 'trending';
    col.timeframe = raw.timeframe === '1d' ? '1d' : '1h';
  }
```

and after the generic `filters` loop (inside `if (f && ...)`, after building `out`), narrow the mints filter:

```ts
    if (type === 'mints') {
      if (Array.isArray(out.chains)) out.chains = (out.chains as string[]).filter((c) => (MINT_CHAINS as readonly string[]).includes(c));
      if (Array.isArray(out.chains) && out.chains.length === 0) delete out.chains;
      if (typeof out.minQty === 'number' && out.minQty < 1) delete out.minQty;
    }
```

Add to `Config`:

```ts
  /** OpenSea mint window: one wallet key (0x + 64 hex) and RPC overrides by OpenSea chain identifier */
  opensea: { walletKey?: string; rpc: Record<string, string> };
```

Add `opensea: { rpc: {} }` to `DEFAULT`; in `load()` where other blocks are normalised add:

```ts
        opensea: {
          walletKey: /^0x[0-9a-fA-F]{64}$/.test(String(raw.opensea?.walletKey ?? '')) ? String(raw.opensea.walletKey) : undefined,
          rpc: Object.fromEntries(Object.entries(raw.opensea?.rpc ?? {}).filter(([k, v]) => /^[a-z_]{1,30}$/.test(k) && /^https?:\/\//i.test(String(v))).map(([k, v]) => [k, String(v)])),
        },
```

In `masked()` add (the address is derived in Task 12 by the Minter; here only the flag):

```ts
      opensea: { hasWallet: !!this.cfg.opensea.walletKey, rpc: this.cfg.opensea.rpc },
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Mirror types in the frontend**

`frontend/src/types.ts`: paste the same `MintChain`, `MintEvent`, `RankingSlug`, `RankingTimeframe`, `RankingKey`, `NftRanking`, `MintJobState`, `MintJob` blocks, the `Status` edits, and the `ServerEvent` additions (the frontend file is a hand-kept copy).

`frontend/src/api.ts`: in `ColumnDef` change `type` to the ten-member union and add `ranking?: 'trending' | 'top'; timeframe?: '1h' | '1d';`. In `MaskedConfig` add `opensea: { hasWallet: boolean; walletAddress?: string; rpc: Record<string, string>; chains: { id: string; name: string; defaultRpc: string; symbol: string }[] };`. In `ColumnFilters` (search for `interface ColumnFilters`) add `chains?: string[]; minQty?: number;`.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: errors only in `App.tsx` / `ColumnEditor.tsx` where `col.type` switches are not exhaustive — none expected, since those use `if` chains; if `Column.tsx`'s `kind` prop complains, widen its union to `ColumnDef['type']` by importing the type from `../api`.

```bash
git add backend/src/types.ts backend/src/config.ts backend/src/config.test.ts frontend/src/types.ts frontend/src/api.ts
git commit -m "NFT columns: types, column types and OpenSea config" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part A: MintGo feed

### Task 2: `decodeBatch` (pure decoder) with a captured fixture

**Files:**
- Create: `backend/src/mintgo.ts`
- Test: `backend/src/mintgo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { decodeBatch, upsertMint } from './mintgo.js';
import type { MintEvent } from './types.js';

// A real frame captured from wss://mintgo.fun/api/realtime?scope=all on 2026-09-12 (two contracts, two rows).
const FRAME = [1, 1789121431284737, 2,
  [
    ['0x7986e0720706e0ed054a110d68067c78c1f1c235', 'FYSH', 'fyshverse', 'https://i2c.seadn.io/collection/fyshverse/logo.png', 'fyshverse', 'https://opensea.io/collection/fyshverse', 'https://fysh.xyz/', 'https://x.com/fyshverse', '', '', null, 'erc721'],
    ['0x9d2a003322874163cbb18f7f538a1aaea49b75d1', 'Chump NFT', 'chump-nft-310989788', 'https://i2c.seadn.io/collection/chump/logo.png', 'chump-nft-310989788', 'https://opensea.io/collection/chump-nft-310989788', '', '', '', '', null, 'erc721'],
  ],
  [
    ['0x44d7…e607-0x7986e0720706e0ed054a110d68067c78c1f1c235-47', '0x44d7e607', 61364140, 1789242409000, 0, ['558', '559', '560', '561', '562'], 5, '0xdbe88b310e5d121875f353421a33866adf34a111', '', '', '0', 2, 'mint', null, null, '', '', 'robinhood:mint:…', 1789242409763000, 5, 1, 0],
    ['0x6947…752f-0x9d2a003322874163cbb18f7f538a1aaea49b75d1-174', '0x6947752f', 61364140, 1789242409000, 1, ['462'], 1, '0xfa2e3c21af8ba3b7170fdbb796190685e00e6e8d', '0xfa2e3c21af8ba3b7170fdbb796190685e00e6e8d', '', '0.005', 19, 'mint', 120, 1000, '0.005', 'seadrop-wss', 'robinhood:mint:…', 1789242409763001, 1, 1, 0],
  ],
];

describe('decodeBatch', () => {
  it('expands the compact frame into MintEvents', () => {
    const out = decodeBatch(FRAME);
    expect(out).toHaveLength(2);
    const [a, b] = out;
    expect(a.chain).toBe('robinhood');
    expect(a.contract).toMatchObject({ address: '0x7986e0720706e0ed054a110d68067c78c1f1c235', name: 'FYSH', slug: 'fyshverse', twitterUrl: 'https://x.com/fyshverse', projectUrl: 'https://fysh.xyz/', standard: 'erc721' });
    expect(a.quantity).toBe(5);
    expect(a.tokenIds).toEqual(['558', '559', '560', '561', '562']);
    expect(a.preview).toBe(true); // flags 2
    expect(a.priceConfirmed).toBe(false);
    expect(a.valueEth).toBe(0);
    expect(b.contract.name).toBe('Chump NFT');
    expect(b.priceConfirmed).toBe(true); // flags 19 = 1 | 2 | 16
    expect(b.preview).toBe(true);
    expect(b.unitPriceEth).toBe(0.005);
    expect(b.mintedSupply).toBe(120);
    expect(b.maxSupply).toBe(1000);
    expect(b.ts).toBe(1789242409000);
    expect(b.blockNumber).toBe(61364140);
  });
  it('maps chain codes and drops rows without id or contract', () => {
    expect(decodeBatch([1, 0, 4, [['0xabc', 'X']], [['id1', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0]]])[0].chain).toBe('ink');
    expect(decodeBatch([1, 0, 99, [['0xabc', 'X']], [['id1', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0]]])[0].chain).toBe('ethereum');
    expect(decodeBatch([1, 0, 1, [], [['id1', '0xt', 1, 2, 0, [], 1, '0xm']]])).toEqual([]);
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [['', '0xt', 1, 2, 0, [], 1, '0xm']]])).toEqual([]);
    expect(decodeBatch('garbage')).toEqual([]);
  });
  it('reads airdrop, third-party and surge flags', () => {
    const row = ['id', '0xt', 1, 2, 0, ['1'], 1, '0xm', '', '', '0', 4 | 8 | 128, 'mint', null, null, '', '', '', 0, 0, 0, 0, 7, 9, 3, 0, 0, 0, [], 1789000000000];
    const [e] = decodeBatch([1, 0, 1, [['0xabc', 'X']], [row]]);
    expect(e.airdrop).toBe(true);
    expect(e.thirdParty).toBe(true);
    expect(e.surge).toEqual({ mints: 7, events: 9, minters: 3, startedAt: 1789000000000 });
  });
});

describe('upsertMint', () => {
  const mk = (id: string, preview: boolean): MintEvent => ({ id, chain: 'ethereum', ts: 1, txHash: 't', blockNumber: 1, contract: { address: '0xa', name: 'A' }, quantity: 1, tokenIds: [], minter: '0xm', priceConfirmed: !preview, preview, airdrop: false, thirdParty: false });
  it('replaces a preview with its confirmed row and keeps newest first', () => {
    const list: MintEvent[] = [];
    upsertMint(list, mk('1', true), 300);
    upsertMint(list, mk('2', true), 300);
    upsertMint(list, mk('1', false), 300);
    expect(list.map((e) => e.id)).toEqual(['2', '1']);
    expect(list[1].preview).toBe(false);
  });
  it('caps the list', () => {
    const list: MintEvent[] = [];
    for (let i = 0; i < 5; i++) upsertMint(list, mk(String(i), false), 3);
    expect(list.map((e) => e.id)).toEqual(['4', '3', '2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/mintgo.test.ts`
Expected: FAIL — cannot find module `./mintgo.js`.

- [ ] **Step 3: Write `backend/src/mintgo.ts` (decoder + upsert only)**

```ts
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { MintChain, MintEvent } from './types.js';

/**
 * MintGo (mintgo.fun): live NFT mints on Ethereum, Robinhood Chain and Ink, read the way its
 * own page reads them: a browser-session cookie, then the realtime socket. Unofficial, so
 * every field access is defensive. Read-only.
 */
export const MINTGO = 'https://mintgo.fun';
const MAX = 300;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
/** MintGo checks these to decide a request came from its own page. */
export const SAME_ORIGIN_HEADERS: Record<string, string> = {
  'user-agent': UA,
  origin: MINTGO,
  referer: `${MINTGO}/`,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  accept: '*/*',
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function chainFromCode(code: unknown): MintChain {
  const n = Number(code);
  return n === 2 ? 'robinhood' : n === 3 ? 'stable' : n === 4 ? 'ink' : n === 5 ? 'arc' : 'ethereum';
}

/** `[1, cursor, chainCode, contracts[], rows[]]` → events. Mirrors MintGo's expandCompactRealtimeBatch. */
export function decodeBatch(packet: unknown): MintEvent[] {
  if (!Array.isArray(packet) || Number(packet[0]) !== 1) return [];
  const chain = chainFromCode(packet[2]);
  const contracts: unknown[][] = Array.isArray(packet[3]) ? packet[3] : [];
  const rows: unknown[][] = Array.isArray(packet[4]) ? packet[4] : [];
  const out: MintEvent[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const c = contracts[Number(row[4] ?? 0)];
    const id = str(row[0]);
    const address = str(c?.[0])?.toLowerCase();
    if (!id || !address || !Array.isArray(c)) continue;
    const flags = Number(row[11] ?? 0) || 0;
    const tokenIds = Array.isArray(row[5]) ? row[5].filter((v) => v !== null && v !== undefined && v !== '').map(String) : [];
    const slug = str(c[4]);
    const deployer = str(c[8]);
    const surge = !!(flags & 128);
    out.push({
      id,
      chain,
      ts: num(row[3]) ?? Date.now(),
      txHash: str(row[1]) ?? '',
      blockNumber: num(row[2]) ?? 0,
      contract: {
        address,
        name: str(c[1]) ?? address.slice(0, 10),
        symbol: str(c[2]),
        image: str(c[3]),
        slug,
        openSeaUrl: str(c[12]) ?? (slug ? `https://opensea.io/collection/${slug}` : undefined),
        projectUrl: str(c[6]),
        twitterUrl: str(c[7]),
        standard: str(c[11]),
        deployer: deployer ? { address: deployer, createdAgo: str(c[9]), projects: num(c[10]) } : undefined,
      },
      quantity: num(row[6]) ?? (tokenIds.length || 1),
      tokenIds,
      tokenIdsTotal: flags & 64 ? num(row[21]) : undefined,
      minter: str(row[7]) ?? '',
      valueEth: num(row[10]),
      unitPriceEth: num(row[15]),
      priceConfirmed: !!(flags & 1),
      preview: !!(flags & 2),
      airdrop: !!(flags & 4),
      thirdParty: !!(flags & 8),
      functionName: str(row[12]),
      mintedSupply: num(row[13]),
      maxSupply: num(row[14]),
      surge: surge ? { mints: num(row[22]) ?? 0, events: num(row[23]) ?? 0, minters: num(row[24]) ?? 0, startedAt: num(row[29]) ?? 0 } : undefined,
    });
  }
  return out;
}

/** Replace by id (a preview row becomes its confirmed row in place), else newest first; capped. */
export function upsertMint(list: MintEvent[], e: MintEvent, max = MAX): 'new' | 'update' {
  const i = list.findIndex((x) => x.id === e.id);
  if (i >= 0) {
    list[i] = e;
    return 'update';
  }
  list.unshift(e);
  if (list.length > max) list.length = max;
  return 'new';
}
```

(The `EventEmitter` / `WebSocket` imports are used by Task 3; leaving them now keeps the file's header final.)

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/mintgo.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/mintgo.ts backend/src/mintgo.test.ts
git commit -m "MintGo: decode realtime mint batches" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `MintGoClient` (session + socket) wired into services, hub and API

**Files:**
- Modify: `backend/src/mintgo.ts` (append the client)
- Modify: `backend/src/hub.ts` (next to `setJ7`, and `hello()`)
- Modify: `backend/src/services.ts` (next to `startJ7`)
- Modify: `backend/src/api.ts` (next to `/j7/recent`)
- Modify: `backend/src/index.ts:66` (after `svc.startJ7();`)

- [ ] **Step 1: Append the client to `backend/src/mintgo.ts`**

```ts
export type MintGoState = NonNullable<import('./types.js').Status['mintgo']>;

export class MintGoClient extends EventEmitter {
  state: MintGoState = 'disconnected';
  readonly recent: MintEvent[] = [];
  private cookie = '';
  private renewAt = 0;
  private cursor = '';
  private socket?: WebSocket;
  private attempts = 0;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private readonly clientId = Math.random().toString(36).slice(2, 12);

  constructor(private fetchImpl: typeof fetch = fetch) {
    super();
  }

  /** A browser session cookie; MintGo hands one to any request that looks same-origin. */
  async session(force = false): Promise<string> {
    if (!force && this.cookie && Date.now() < this.renewAt) return this.cookie;
    const r = await this.fetchImpl(`${MINTGO}/api/session`, { method: 'POST', headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`MintGo session refused (${r.status})`);
    const j: any = await r.json().catch(() => ({}));
    const cookies = (r.headers as any).getSetCookie?.() as string[] | undefined;
    const jar = (cookies ?? []).map((c) => c.split(';')[0]).filter((c) => /^mg_/.test(c));
    if (!j.ok || jar.length === 0) throw new Error('MintGo session response had no cookie');
    this.cookie = jar.join('; ');
    this.renewAt = Number(j.renewAfter) > Date.now() ? Number(j.renewAfter) : Date.now() + 20 * 60_000;
    return this.cookie;
  }

  /** GET one of MintGo's JSON endpoints with the session (used by the mint window later). */
  async get<T>(path: string): Promise<T> {
    const go = async () => this.fetchImpl(`${MINTGO}${path}`, { headers: { ...SAME_ORIGIN_HEADERS, cookie: await this.session() } });
    let r = await go();
    if (r.status === 401) {
      await this.session(true);
      r = await go();
    }
    if (!r.ok) throw new Error(`MintGo ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close(1000, 'stopped');
    this.socket = undefined;
    this.setState('disconnected');
  }

  private setState(s: MintGoState, err?: string) {
    if (this.state === s && !err) return;
    this.state = s;
    this.emit('state', s, err);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    let cookie: string;
    try {
      cookie = await this.session(this.attempts > 0);
    } catch (e: any) {
      this.setState('error', e?.message ?? String(e));
      return this.retry();
    }
    const url = new URL(`${MINTGO.replace('https', 'wss')}/api/realtime`);
    url.searchParams.set('scope', 'all');
    url.searchParams.set('client', this.clientId);
    if (/^\d+$/.test(this.cursor)) url.searchParams.set('since', this.cursor);
    const ws = new WebSocket(url, { headers: { ...SAME_ORIGIN_HEADERS, cookie } });
    this.socket = ws;
    ws.on('open', () => {
      this.attempts = 0;
    });
    ws.on('message', (data) => {
      let packet: unknown;
      try {
        packet = JSON.parse(Buffer.isBuffer(data) || Array.isArray(data) ? Buffer.concat(Array.isArray(data) ? data : [data]).toString('utf8') : String(data));
      } catch {
        return;
      }
      if (!Array.isArray(packet)) return;
      const type = Number(packet[0]);
      if (type === 0) return;
      const cursor = String(packet[1] ?? '');
      if (/^\d+$/.test(cursor)) this.cursor = cursor;
      if (type === 1) {
        for (const e of decodeBatch(packet)) {
          upsertMint(this.recent, e);
          this.emit('mint', e);
        }
      } else if (type === 2) {
        const name = String(packet[3] ?? '');
        if (name === 'ready') this.setState('connected');
      }
    });
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      if (this.stopped) return;
      this.setState('error', `socket closed (${code}${reason?.length ? ` ${reason.toString()}` : ''})`);
      this.retry();
    });
    ws.on('error', (e) => {
      console.warn('[mintgo] socket error', e?.message ?? e);
    });
  }

  private retry() {
    if (this.stopped) return;
    this.attempts++;
    const delay = Math.min(5000, 250 * 2 ** Math.min(5, this.attempts - 1));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref();
  }
}
```

- [ ] **Step 2: Hub: state setter and hello**

In `backend/src/hub.ts` after `setJ7(...)`:

```ts
  setMintGo(state: NonNullable<Status['mintgo']>, error?: string): void {
    this.status.mintgo = state;
    if (error) this.status.error.mintgo = error;
    else delete this.status.error.mintgo;
    this.emit('event', { type: 'status', status: this.getStatus() } satisfies ServerEvent);
  }
```

Give the hub three providers it does not own, set by `Services` (add fields near the top of the class and a setter):

```ts
  /** filled by Services: what the NFT columns need in `hello` */
  nftState: { mints: () => MintEvent[]; rankings: () => Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>>; mintJobs: () => MintJob[] } = { mints: () => [], rankings: () => ({}), mintJobs: () => [] };
```

(import `MintEvent, NftRanking, RankingKey, MintJob` from `./types.js`). In `hello()` add:

```ts
      mints: this.nftState.mints(),
      rankings: this.nftState.rankings(),
      mintJobs: this.nftState.mintJobs(),
```

Also initialise `mintgo: 'disconnected'` wherever the initial `status` object is built (search `j7: 'disconnected'` or the `status` initialiser and add `mintgo: 'disconnected'`).

- [ ] **Step 3: Services**

In `backend/src/services.ts` add the import `import { MintGoClient } from './mintgo.js';`, a field `mintgo?: MintGoClient;`, and after `j7Recent()`:

```ts
  /** MintGo live mints (no account needed). Started when a MintGo column exists, stopped when none does. */
  startMintGo(): void {
    const wanted = this.cfg.get().columns.flatMap((c) => (c.split ? [c, c.split.bottom] : [c])).some((c) => c.type === 'mints' || c.type === 'osmint');
    if (!wanted) {
      this.mintgo?.stop();
      this.mintgo = undefined;
      this.hub.setMintGo('disconnected');
      return;
    }
    if (this.mintgo) return;
    const c = new MintGoClient();
    c.on('state', (s: any, err?: string) => this.hub.setMintGo(s, err));
    c.on('mint', (mint: import('./types.js').MintEvent) => this.hub.emit('event', { type: 'mint', mint }));
    this.mintgo = c;
    this.hub.nftState.mints = () => c.recent;
    c.start();
  }
  mintsRecent() {
    return this.mintgo?.recent ?? [];
  }
```

- [ ] **Step 4: API + boot**

In `backend/src/api.ts` next to `r.get('/j7/recent', …)`:

```ts
  r.get('/mints/recent', wrap(() => svc.mintsRecent()));
```

Find the `PUT /columns` handler (search `'/columns'`); after `cfg.update(...)` add `svc.startMintGo();`.

In `backend/src/index.ts` after `svc.startJ7();` add `svc.startMintGo();`.

- [ ] **Step 5: Prove it live**

Run: `npm run dev -w backend` in one terminal, then in another:

```bash
curl -s -X PUT localhost:3210/api/columns -H 'content-type: application/json' -d '{"columns":[{"id":"calls","type":"calls","title":"All Calls","chats":[]},{"id":"m","type":"mints","title":"MintGo","chats":[]}]}' >/dev/null; sleep 20; curl -s localhost:3210/api/mints/recent | head -c 600; echo; curl -s localhost:3210/api/status | grep -o '"mintgo":"[a-z]*"'
```

Expected: a JSON array with at least one mint and `"mintgo":"connected"`. Then run `npm test -w backend` — all green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/mintgo.ts backend/src/hub.ts backend/src/services.ts backend/src/api.ts backend/src/index.ts
git commit -m "MintGo: live socket client, hub state and /mints/recent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: MintGo column in the UI

**Files:**
- Create: `frontend/src/components/MintFeed.tsx`
- Modify: `frontend/src/useFeed.ts`, `frontend/src/api.ts`, `frontend/src/components/Icon.tsx`, `frontend/src/components/Column.tsx:96,140`, `frontend/src/components/ColumnEditor.tsx:22-30,160-170,247-260,310-330`, `frontend/src/App.tsx:79,907`, `frontend/src/index.css`

- [ ] **Step 1: Feed hook**

In `useFeed.ts` add state and handlers:

```ts
  /** MintGo mints, newest first; a confirmed row replaces its preview in place */
  const [mints, setMints] = useState<MintEvent[]>([]);
  const upsertMints = (incoming: MintEvent[]) =>
    setMints((cur) => {
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id)).slice(0, 300);
    });
  const [rankings, setRankings] = useState<Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>>>({});
  const [mintJobs, setMintJobs] = useState<MintJob[]>([]);
  const upsertJob = (job: MintJob) => setMintJobs((cur) => (cur.some((j) => j.id === job.id) ? cur.map((j) => (j.id === job.id ? job : j)) : [...cur, job].slice(-100)));
```

In the `hello` branch: `setMints(ev.mints ?? []); setRankings(ev.rankings ?? {}); setMintJobs(ev.mintJobs ?? []);`. Add branches:

```ts
        } else if (ev.type === 'mint') upsertMints([ev.mint]);
        else if (ev.type === 'nftRankings') setRankings((r) => ({ ...r, [ev.key]: { rows: ev.rows, at: ev.at } }));
        else if (ev.type === 'mintJob') upsertJob(ev.job);
```

Return `mints, rankings, mintJobs` too. Import the types from `./types`.

`api.ts`: add `mintsRecent: () => req<import('./types').MintEvent[]>('GET', '/mints/recent'),`.

- [ ] **Step 2: Icons and Column kind**

`Icon.tsx`: extend `IconName` with `'mint' | 'sea' | 'wallet'` and add paths (24-box, hand drawn):

```ts
  mint: 'M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3L18.6 8 12 11.7 5.4 8 12 4.3zM5 9.7l6 3.4v6.6l-6-3.3V9.7zm8 10V13l6-3.4v6.7l-6 3.4z',
  sea: 'M4 15c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1v2c-1.5 0-1.5 1-3 1s-1.5-1-3-1-1.5 1-3 1-1.5-1-3-1-1.5 1-3 1v-2zm8-11a5 5 0 0 1 5 5v2h-2V9a3 3 0 0 0-6 0v2H7V9a5 5 0 0 1 5-5z',
  wallet: 'M3 6a2 2 0 0 1 2-2h13v3H5a1 1 0 0 0 0 2h15a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zm13 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
```

`Column.tsx`: widen `kind` to `ColumnDef['type']` (`import type { ColumnDef } from '../api'`) and extend the icon expression: `kind === 'mints' ? 'mint' : kind === 'nftvol' ? 'sea' : kind === 'osmint' ? 'wallet' : …`.

- [ ] **Step 3: `MintFeed.tsx`**

```tsx
import { useState } from 'react';
import type { MintEvent } from '../types';
import type { ColumnFilters } from '../api';
import { timeAgo } from '../format';
import { Icon } from './Icon';
import { VirtualItem } from './Virtual';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', robinhood: 'https://robinhoodchain.blockscout.com/tx/', ink: 'https://explorer.inkonchain.com/tx/' };
const CHAIN_LABEL: Record<string, string> = { ethereum: 'ETH', robinhood: 'RH', ink: 'INK', stable: 'STB', arc: 'ARC' };
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const eth = (n?: number) => (n === undefined ? '' : n === 0 ? 'free' : `Ξ${n < 0.001 ? n.toPrecision(2) : n.toFixed(n < 0.1 ? 4 : 3)}`);

export function mintPasses(e: MintEvent, f?: ColumnFilters): boolean {
  if (f?.chains?.length && !f.chains.includes(e.chain)) return false;
  if (f?.minQty && e.quantity < f.minQty) return false;
  return true;
}

function MintCard({ e, now, open, onToggle, onMint }: { e: MintEvent; now: number; open: boolean; onToggle: () => void; onMint?: (e: MintEvent) => void }) {
  const c = e.contract;
  const copy = (t: string) => void navigator.clipboard?.writeText(t);
  return (
    <div className={`mint${open ? ' mint-open' : ''}${e.preview ? ' mint-preview' : ''}`} onClick={onToggle}>
      <div className="mint-row">
        {c.image ? <img className="mint-img" src={c.image} alt="" loading="lazy" /> : <span className="mint-img mint-noimg" />}
        <div className="mint-main">
          <div className="mint-name">
            <b>{c.name}</b>
            <span className={`mint-chain mint-chain-${e.chain}`}>{CHAIN_LABEL[e.chain] ?? e.chain}</span>
            {e.preview && <span className="mint-tag">preview</span>}
            {e.airdrop && <span className="mint-tag">airdrop</span>}
            {e.thirdParty && <span className="mint-tag">3rd party</span>}
            {e.surge && <span className="mint-tag mint-surge">🔥 {e.surge.mints} in a burst</span>}
          </div>
          <div className="mint-meta muted">
            ×{e.quantity} · {eth(e.unitPriceEth ?? (e.quantity ? (e.valueEth ?? 0) / e.quantity : undefined))}
            {e.valueEth ? ` (${eth(e.valueEth)} total)` : ''} · {short(e.minter)} · {timeAgo(e.ts, now)}
            {e.maxSupply ? ` · ${e.mintedSupply ?? '?'}/${e.maxSupply}` : ''}
          </div>
        </div>
      </div>
      {open && (
        <div className="mint-links" onClick={(ev) => ev.stopPropagation()}>
          {c.twitterUrl && <a href={c.twitterUrl} target="_blank" rel="noreferrer" title="X"><Icon name="x" size={12} /> X</a>}
          {c.openSeaUrl && <a href={c.openSeaUrl} target="_blank" rel="noreferrer" title="OpenSea"><Icon name="sea" size={12} /> OpenSea</a>}
          {c.projectUrl && <a href={c.projectUrl} target="_blank" rel="noreferrer" title="website"><Icon name="globe" size={12} /> site</a>}
          {e.txHash && EXPLORER[e.chain] && <a href={`${EXPLORER[e.chain]}${e.txHash}`} target="_blank" rel="noreferrer" title="transaction"><Icon name="explorer" size={12} /> tx</a>}
          <button className="mint-copy" onClick={() => copy(c.address)} title="copy contract"><Icon name="copy" size={12} /> {short(c.address)}</button>
          {c.deployer && <span className="muted">deployer {short(c.deployer.address)}{c.deployer.createdAgo ? ` · ${c.deployer.createdAgo}` : ''}{c.deployer.projects ? ` · ${c.deployer.projects} projects` : ''}</span>}
          {onMint && c.slug && <button className="mint-go" onClick={() => onMint(e)}>Mint</button>}
        </div>
      )}
    </div>
  );
}

/** The MintGo column body: one card per mint, newest first; click a card for its links and a Mint button. */
export function MintFeed({ mints, now, state, error, filters, onMint }: { mints: MintEvent[]; now: number; state?: string; error?: string; filters?: ColumnFilters; onMint?: (e: MintEvent) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = mints.filter((e) => mintPasses(e, filters));
  return (
    <>
      {state === 'error' && <div className="empty err">MintGo unavailable: {error ?? 'connection lost'} — retrying.</div>}
      {state !== 'error' && list.length === 0 && <div className="empty">{state === 'connected' ? 'Waiting for the first mint…' : 'Connecting to MintGo…'}</div>}
      {list.map((e) => (
        <VirtualItem key={e.id} id={`mint:${e.id}`} estimate={open === e.id ? 110 : 58}>
          <MintCard e={e} now={now} open={open === e.id} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} onMint={onMint} />
        </VirtualItem>
      ))}
    </>
  );
}
```

- [ ] **Step 4: ColumnEditor**

Add to `TYPE_CARDS`:

```ts
  { t: 'mints', icon: 'mint', name: 'MintGo', blurb: 'NFT mints as they happen' },
  { t: 'nftvol', icon: 'sea', name: 'OpenSea Volume', blurb: 'trending & top collections, 1H or 1D' },
  { t: 'osmint', icon: 'wallet', name: 'OpenSea Mint', blurb: 'mint a drop with your wallet' },
```

Add state + flags near the other `useState`s:

```ts
  const [ranking, setRanking] = useState<NonNullable<ColumnDef['ranking']>>(col?.ranking ?? 'trending');
  const [timeframe, setTimeframe] = useState<NonNullable<ColumnDef['timeframe']>>(col?.timeframe ?? '1h');
  const isNft = type === 'mints' || type === 'nftvol' || type === 'osmint';
```

Extend the two default-title expressions (in `save` and the `placeholder`) with `type === 'mints' ? 'MintGo' : type === 'nftvol' ? 'OpenSea Volume' : type === 'osmint' ? 'OpenSea Mint' :` before the `all ? 'All Chats'` tail. In `save()`'s `onSave({...})` add `...(type === 'nftvol' ? { ranking, timeframe } : {})` and make `chats: isWeb || isNft ? [] : chats`. Also guard the "No channels are selected" confirm with `!isNft`.

Left pane: change `{!isBot && !isWeb && (` to `{!isBot && !isWeb && !isNft && (` and add before it:

```tsx
            {isNft && (
              <div className="fed-bot-note hint">
                {type === 'mints' ? 'Every mint MintGo sees on Ethereum, Robinhood Chain and Ink. Click a mint for its X, OpenSea and website links, and a Mint button.' : type === 'nftvol' ? "OpenSea's trending or top collections with floor, volume and sales. Switch 1H / 1D in the column header." : 'Paste a collection (slug, OpenSea link or address), see the open stage and price, and mint with the wallet from ⚙ → Trading.'}
              </div>
            )}
```

Right pane, add before the `{type === 'j7' && (` block:

```tsx
            {type === 'mints' && (
              <>
                <Chips title="Chains" options={[['ethereum', 'Ethereum'], ['robinhood', 'Robinhood'], ['ink', 'Ink']]} value={f.chains ?? []} onChange={(v) => set('chains', v)} all="all chains" />
                <div className="fsec">
                  <div className="fsec-title">Minimum quantity</div>
                  <input className="fed-input" type="number" min={1} value={f.minQty ?? ''} onChange={(e) => set('minQty', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="any" />
                </div>
              </>
            )}
            {type === 'nftvol' && (
              <>
                <div className="fsec">
                  <div className="fsec-title">List</div>
                  <div className="fchips">
                    {(['trending', 'top'] as const).map((r) => <button key={r} className={`fchip${ranking === r ? ' on' : ''}`} onClick={() => setRanking(r)}>{r === 'trending' ? 'Trending' : 'Top'}</button>)}
                  </div>
                </div>
                <div className="fsec">
                  <div className="fsec-title">Window</div>
                  <div className="fchips">
                    {(['1h', '1d'] as const).map((t) => <button key={t} className={`fchip${timeframe === t ? ' on' : ''}`} onClick={() => setTimeframe(t)}>{t.toUpperCase()}</button>)}
                  </div>
                </div>
              </>
            )}
            {type === 'osmint' && <div className="hint">Nothing to filter here — this column is your mint window.</div>}
```

- [ ] **Step 5: App render**

`App.tsx:79`: destructure `mints, rankings, mintJobs` from `useFeed()`. In `renderColumn`, before `if (col.type === 'j7')`:

```tsx
    if (col.type === 'mints') {
      const shown = mints.filter((e) => mintPasses(e, col.filters));
      return (
        <Column key={col.id} title={col.title} subtitle={`mintgo.fun · ${status.mintgo ?? 'off'}`} kind="mints" count={shown.length} className="col-mints" {...actions}>
          <MintFeed mints={mints} now={now} state={status.mintgo} error={status.error.mintgo} filters={col.filters} onMint={(e) => mintFrom({ locator: e.contract.slug!, chain: e.chain })} />
        </Column>
      );
    }
```

`mintFrom` is defined in Task 13; until then use `onMint={undefined}` and add it there. Import `MintFeed, mintPasses` from `./components/MintFeed`.

- [ ] **Step 6: CSS**

Append to `index.css`:

```css
/* ---------- MintGo column ---------- */
.mint { padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
.mint:hover { background: var(--hover); }
.mint-preview .mint-name b { opacity: 0.75; }
.mint-row { display: flex; gap: 10px; align-items: center; min-width: 0; }
.mint-img { width: 36px; height: 36px; border-radius: 9px; object-fit: cover; flex: none; background: var(--panel-2); }
.mint-noimg { display: inline-block; }
.mint-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.mint-name { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; }
.mint-name b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mint-chain { font-size: 9px; padding: 1px 4px; border-radius: 4px; background: var(--chrome); color: var(--muted); letter-spacing: 0.04em; }
.mint-chain-robinhood { color: #c8f27a; } .mint-chain-ink { color: #b58cff; } .mint-chain-ethereum { color: var(--evm); }
.mint-tag { font-size: 10px; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 4px; padding: 0 4px; }
.mint-surge { color: var(--warn); border-color: rgba(242, 195, 102, 0.5); }
.mint-meta { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mint-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 8px; font-size: 11px; }
.mint-links a, .mint-copy { display: inline-flex; align-items: center; gap: 3px; color: var(--text); text-decoration: none; background: var(--chrome); border: 1px solid var(--line-strong); border-radius: 6px; padding: 3px 7px; cursor: pointer; }
.mint-links a:hover, .mint-copy:hover { border-color: var(--accent); color: var(--accent); }
.mint-go { margin-left: auto; background: var(--accent); color: #04140d; border: 0; border-radius: 6px; padding: 4px 12px; font-weight: 600; cursor: pointer; }
```

- [ ] **Step 7: Verify in the browser**

Run: `npm run dev`, open http://localhost:5173, + → MintGo. Expected: cards appear within seconds, chain tags, clicking a card shows links, the ⚙ chain filter narrows the list. Run `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "MintGo column: live mint cards with links" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part B: OpenSea volume

### Task 5: `gql()` wrapper and rankings normalizer

**Files:**
- Create: `backend/src/opensea/gql.ts`, `backend/src/opensea/rankings.ts`
- Test: `backend/src/opensea/rankings.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeRankings, RANKINGS_QUERY } from './rankings.js';

const item = (over: any = {}) => ({
  score: '1',
  collection: {
    slug: 'pudgypenguins', name: 'Pudgy Penguins', imageUrl: 'https://i/p.png', isVerified: true, chain: { identifier: 'ethereum' },
    stats: { oneHour: { volume: { usd: 27761.2, native: { unit: 11.01, symbol: 'ETH' } }, sales: 3, floorPriceChange: -0.0028 }, oneDay: { volume: { usd: 86449.5, native: { unit: 34.23, symbol: 'ETH' } }, sales: 9, floorPriceChange: -0.011 }, ownerCount: 5069, totalSupply: 8888, listedItemCount: 259 },
    floorPrice: { pricePerItem: { usd: 9026.4, token: { unit: 3.5889, symbol: 'ETH' } } },
    topOffer: null,
    drop: null,
    ...over,
  },
});

describe('normalizeRankings', () => {
  it('picks the timeframe window and ranks in order', () => {
    const rows = normalizeRankings([item(), item({ slug: 'b', name: 'B' })], 'ONE_DAY', Date.parse('2026-09-12T20:00:00Z'));
    expect(rows[0]).toMatchObject({ rank: 1, slug: 'pudgypenguins', verified: true, chain: 'ethereum', volume: { usd: 86449.5, unit: 34.23, symbol: 'ETH' }, sales: 9, floorChange: -0.011, floor: { usd: 9026.4, unit: 3.5889, symbol: 'ETH' }, owners: 5069, supply: 8888, listed: 259 });
    expect(rows[0].topOffer).toBeUndefined();
    expect(rows[1].rank).toBe(2);
    expect(normalizeRankings([item()], 'ONE_HOUR', 0)[0].volume.unit).toBe(11.01);
  });
  it('marks a drop with an open stage as minting', () => {
    const now = Date.parse('2026-09-12T20:30:00Z');
    const drop = { __typename: 'Erc721SeaDropV1', stages: [{ stageType: 'SIGNED_PRESALE', startTime: '2026-09-12T19:00:00Z', endTime: '2026-09-12T20:00:00Z' }, { stageType: 'PUBLIC_SALE', startTime: '2026-09-12T20:00:00Z', endTime: '2026-09-14T20:00:00Z' }] };
    expect(normalizeRankings([item({ drop })], 'ONE_HOUR', now)[0].minting).toEqual({ stageType: 'PUBLIC_SALE', endTime: '2026-09-14T20:00:00Z' });
    expect(normalizeRankings([item({ drop })], 'ONE_HOUR', Date.parse('2026-09-15T00:00:00Z'))[0].minting).toBeUndefined();
  });
  it('skips items without a slug and tolerates missing stats', () => {
    const rows = normalizeRankings([{ collection: null }, item({ stats: null, floorPrice: null })], 'ONE_HOUR', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].volume).toEqual({ usd: 0, unit: 0, symbol: '' });
    expect(rows[0].floor).toBeUndefined();
  });
  it('asks for both windows and the drop stages', () => {
    expect(RANKINGS_QUERY).toContain('oneHour');
    expect(RANKINGS_QUERY).toContain('oneDay');
    expect(RANKINGS_QUERY).toContain('stages');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/opensea/rankings.test.ts` → FAIL, module not found.

- [ ] **Step 3: `backend/src/opensea/gql.ts`**

```ts
/**
 * OpenSea's private web GraphQL (the one opensea.io itself uses), the way osnm-z talks to it:
 * `x-app-id: os2-web`, browser-like origin/referer, optional session cookie. Unofficial.
 */
export const OPENSEA = 'https://opensea.io';
export const GQL_URL = 'https://gql.opensea.io/graphql';
export const APP_ID = 'os2-web';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const BODY_LIMIT = 2 * 1024 * 1024;

export type OpenSeaErrorCode = 'rate_limited' | 'auth_required' | 'http' | 'graphql' | 'compat' | 'transport';
export class OpenSeaError extends Error {
  constructor(public code: OpenSeaErrorCode, message: string, public status?: number) {
    super(message);
  }
}

export interface GqlOptions {
  referer?: string;
  cookie?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function gql<T>(operationName: string, query: string, variables: Record<string, unknown>, opts: GqlOptions = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-app-id': APP_ID, origin: OPENSEA, referer: opts.referer ?? `${OPENSEA}/`, 'user-agent': UA, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (e: any) {
    throw new OpenSeaError('transport', e?.message ?? 'network error');
  }
  if (res.status === 401) throw new OpenSeaError('auth_required', 'OpenSea wants a signed-in wallet', 401);
  if (res.status === 429) throw new OpenSeaError('rate_limited', 'OpenSea rate limited the request', 429);
  if (!res.ok) throw new OpenSeaError('http', `OpenSea returned ${res.status}`, res.status);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > BODY_LIMIT) throw new OpenSeaError('compat', 'OpenSea response too large');
  let j: any;
  try {
    j = await res.json();
  } catch {
    throw new OpenSeaError('compat', 'OpenSea response was not JSON');
  }
  const authErr = j?.extensions?.auth?.error?.message;
  if (Array.isArray(j?.errors) && j.errors.length) {
    const first = j.errors[0];
    const code = String(first?.extensions?.code ?? '');
    if (/UNAUTHENTICATED|AUTH/.test(code)) throw new OpenSeaError('auth_required', String(first?.message ?? 'not signed in'));
    throw new OpenSeaError('graphql', String(first?.message ?? 'GraphQL error'));
  }
  if (authErr) throw new OpenSeaError('auth_required', String(authErr));
  if (!j || j.data === undefined || j.data === null) throw new OpenSeaError('compat', 'OpenSea response had no data');
  return j.data as T;
}
```

- [ ] **Step 4: `backend/src/opensea/rankings.ts` (normalizer + query; poller added in Task 6)**

```ts
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

/** GraphQL items → rows for one timeframe. Pure. */
export function normalizeRankings(items: any[], timeframe: RankingTimeframe, now: number): NftRanking[] {
  const out: NftRanking[] = [];
  for (const it of Array.isArray(items) ? items : []) {
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
      name: String(c.name ?? c.slug),
      image: typeof c.imageUrl === 'string' && c.imageUrl ? c.imageUrl : undefined,
      verified: !!c.isVerified,
      chain: String(c.chain?.identifier ?? ''),
      floor: price(c.floorPrice),
      topOffer: price(c.topOffer),
      volume: { usd: Number(w?.volume?.usd ?? 0) || 0, unit: Number(w?.volume?.native?.unit ?? 0) || 0, symbol: String(w?.volume?.native?.symbol ?? '') },
      sales: Number(w?.sales ?? 0) || 0,
      floorChange: Number.isFinite(Number(w?.floorPriceChange)) && w?.floorPriceChange !== null ? Number(w.floorPriceChange) : undefined,
      owners: Number.isFinite(Number(c.stats?.ownerCount)) ? Number(c.stats.ownerCount) : undefined,
      supply: Number.isFinite(Number(c.stats?.totalSupply)) ? Number(c.stats.totalSupply) : undefined,
      listed: Number.isFinite(Number(c.stats?.listedItemCount)) ? Number(c.stats.listedItemCount) : undefined,
      minting: open ? { stageType: String(open.stageType ?? ''), endTime: open.endTime ?? undefined } : undefined,
    });
  }
  return out;
}

export const parseKey = (key: RankingKey): { slug: RankingSlug; timeframe: RankingTimeframe } => {
  const [slug, timeframe] = key.split(':') as [RankingSlug, RankingTimeframe];
  return { slug, timeframe };
};

export async function fetchRankings(key: RankingKey, fetchImpl?: typeof fetch): Promise<NftRanking[]> {
  const { slug, timeframe } = parseKey(key);
  const data = await gql<{ collectionRankings: { items: any[] } }>('CollectionRankingsQuery', RANKINGS_QUERY, { slug, timeframe, limit: 50 }, { referer: `${OPENSEA}/collections`, fetchImpl });
  return normalizeRankings(data.collectionRankings?.items ?? [], timeframe, Date.now());
}
```

- [ ] **Step 5: Run the tests** → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/opensea/gql.ts backend/src/opensea/rankings.ts backend/src/opensea/rankings.test.ts
git commit -m "OpenSea: GraphQL wrapper and rankings normalizer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: `RankingsPoller` wired to columns

**Files:**
- Modify: `backend/src/opensea/rankings.ts` (append), `backend/src/services.ts`, `backend/src/api.ts`, `backend/src/index.ts`

- [ ] **Step 1: Append the poller**

```ts
const POLL_MS = 60_000;

/** Polls collectionRankings once a minute for every key a column wants; emits 'rankings' (key, rows, at). */
export class RankingsPoller extends EventEmitter {
  readonly latest: Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>> = {};
  private wanted = new Set<RankingKey>();
  private timers = new Map<RankingKey, NodeJS.Timeout>();
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
    let i = 0;
    for (const k of next) {
      if (this.timers.has(k)) continue;
      const t = setInterval(() => void this.poll(k), POLL_MS);
      t.unref();
      this.timers.set(k, t);
      setTimeout(() => void this.poll(k), 2000 * i++).unref(); // stagger the first fetches
    }
    this.wanted = next;
  }
  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
  async poll(key: RankingKey): Promise<void> {
    try {
      const rows = await fetchRankings(key, this.fetchImpl);
      const at = Date.now();
      this.latest[key] = { rows, at };
      this.failing.delete(key);
      this.emit('rankings', key, rows, at);
    } catch (e: any) {
      if (!this.failing.has(key)) console.warn('[opensea] rankings', key, e?.message ?? e);
      this.failing.add(key);
    }
  }
}

export const keyFor = (c: { ranking?: 'trending' | 'top'; timeframe?: '1h' | '1d' }): RankingKey => `${c.ranking === 'top' ? 'TOP' : 'TRENDING'}:${c.timeframe === '1d' ? 'ONE_DAY' : 'ONE_HOUR'}`;
```

- [ ] **Step 2: Services + API + boot**

`services.ts`: `import { RankingsPoller, keyFor } from './opensea/rankings.js';`, field `readonly rankings = new RankingsPoller();`. In the constructor (after `this.wireDiscord();`):

```ts
    this.rankings.on('rankings', (key, rows, at) => this.hub.emit('event', { type: 'nftRankings', key, rows, at }));
    this.hub.nftState.rankings = () => this.rankings.latest;
```

Add a method and call it from `startMintGo()`'s callers (rename the column hook to one method):

```ts
  /** Columns changed: start/stop the feeds that depend on which column types exist. */
  syncColumnFeeds(): void {
    this.startMintGo();
    const cols = this.cfg.get().columns.flatMap((c) => (c.split ? [c, c.split.bottom] : [c]));
    this.rankings.want([...new Set(cols.filter((c) => c.type === 'nftvol').map(keyFor))]);
  }
```

`api.ts`: replace the `svc.startMintGo()` call in `PUT /columns` with `svc.syncColumnFeeds()`, and add:

```ts
  r.get(
    '/nft/rankings',
    wrap((req) => {
      const key = String(req.query.key ?? '') as import('./types.js').RankingKey;
      const hit = svc.rankings.latest[key];
      if (!hit) throw new Error('no rankings yet for ' + key);
      return hit;
    }),
  );
```

`index.ts`: replace `svc.startMintGo();` with `svc.syncColumnFeeds();`.

- [ ] **Step 3: Prove it live**

With `npm run dev -w backend` running:

```bash
curl -s -X PUT localhost:3210/api/columns -H 'content-type: application/json' -d '{"columns":[{"id":"calls","type":"calls","title":"All Calls","chats":[]},{"id":"v","type":"nftvol","title":"Vol","chats":[],"ranking":"trending","timeframe":"1h"}]}' >/dev/null; sleep 6; curl -s 'localhost:3210/api/nft/rankings?key=TRENDING:ONE_HOUR' | head -c 500
```

Expected: `{"rows":[{"rank":1,…`. `npm test -w backend` green.

- [ ] **Step 4: Commit**

```bash
git add backend/src
git commit -m "OpenSea: rankings poller driven by volume columns" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Volume column UI with the 1H / 1D switch

**Files:**
- Create: `frontend/src/components/NftRankings.tsx`
- Modify: `frontend/src/App.tsx` (renderColumn), `frontend/src/index.css`

- [ ] **Step 1: `NftRankings.tsx`**

```tsx
import type { NftRanking } from '../types';
import { Icon } from './Icon';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2));
const usd = (n: number) => `$${fmt(n)}`;
const native = (p?: { unit: number; symbol: string }) => (p ? `${fmt(p.unit)} ${p.symbol}` : '—');

/** OpenSea's ranking table for one (list, window) pair. Rows open the collection; minting rows get a Mint pill. */
export function NftRankings({ rows, at, now, timeframe, onMint }: { rows?: NftRanking[]; at?: number; now: number; timeframe: '1h' | '1d'; onMint?: (r: NftRanking) => void }) {
  if (!rows) return <div className="empty">Loading OpenSea rankings…</div>;
  if (rows.length === 0) return <div className="empty">OpenSea returned no collections for this window.</div>;
  return (
    <div className="nftv">
      <div className="nftv-head muted">
        <span>#</span><span>collection</span><span>floor</span><span>vol {timeframe.toUpperCase()}</span><span>sales</span><span>Δ floor</span>
      </div>
      {rows.map((r) => (
        <a key={r.slug} className="nftv-row" href={`https://opensea.io/collection/${r.slug}`} target="_blank" rel="noreferrer">
          <span className="nftv-rank muted">{r.rank}</span>
          <span className="nftv-name">
            {r.image ? <img src={r.image} alt="" loading="lazy" /> : <span className="nftv-noimg" />}
            <b>{r.name}</b>
            {r.verified && <span className="nftv-verified" title="verified">✓</span>}
            <span className="nftv-chain">{r.chain}</span>
            {r.minting && onMint && (
              <button className="nftv-mint" onClick={(e) => { e.preventDefault(); onMint(r); }} title={`${r.minting.stageType} open`}>
                <Icon name="mint" size={10} /> Mint
              </button>
            )}
          </span>
          <span className="nftv-num">{native(r.floor)}</span>
          <span className="nftv-num"><b>{native(r.volume)}</b><small className="muted">{usd(r.volume.usd)}</small></span>
          <span className="nftv-num">{r.sales}</span>
          <span className={`nftv-num ${r.floorChange === undefined ? 'muted' : r.floorChange >= 0 ? 'up' : 'down'}`}>{r.floorChange === undefined ? '—' : `${r.floorChange >= 0 ? '+' : ''}${(r.floorChange * 100).toFixed(1)}%`}</span>
        </a>
      ))}
      {at && <div className="nftv-foot muted">updated {Math.max(0, Math.round((now - at) / 1000))}s ago · opensea.io</div>}
    </div>
  );
}
```

- [ ] **Step 2: App render with the header toggle**

In `renderColumn`, add:

```tsx
    if (col.type === 'nftvol') {
      const ranking = col.ranking ?? 'trending';
      const timeframe = col.timeframe ?? '1h';
      const key = `${ranking === 'top' ? 'TOP' : 'TRENDING'}:${timeframe === '1d' ? 'ONE_DAY' : 'ONE_HOUR'}` as RankingKey;
      const hit = rankings[key];
      const setTf = (tf: '1h' | '1d') => saveColumns(updateColumn(col.id, (c) => ({ ...c, timeframe: tf })));
      return (
        <Column
          key={col.id}
          title={col.title}
          subtitle={`${ranking === 'top' ? 'Top' : 'Trending'} · ${timeframe.toUpperCase()}`}
          kind="nftvol"
          className="col-nftvol"
          extra={
            <span className="seg seg-sm">
              {(['1h', '1d'] as const).map((tf) => (
                <button key={tf} className={timeframe === tf ? 'active' : ''} onClick={() => setTf(tf)}>{tf.toUpperCase()}</button>
              ))}
            </span>
          }
          {...actions}
        >
          <NftRankings rows={hit?.rows} at={hit?.at} now={now} timeframe={timeframe} onMint={(r) => mintFrom({ locator: r.slug, chain: r.chain })} />
        </Column>
      );
    }
```

(import `NftRankings`; `RankingKey` type from `./types`; `mintFrom` arrives in Task 13 — use `onMint={undefined}` until then.) `updateColumn` must also reach a stacked bottom; check it already maps `split.bottom` (it does for edit/remove).

- [ ] **Step 3: CSS**

```css
/* ---------- OpenSea volume column ---------- */
.nftv { font-size: 12px; }
.nftv-head, .nftv-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) 72px 88px 44px 56px; gap: 6px; align-items: center; padding: 6px 10px; }
.nftv-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); z-index: 1; }
.nftv-row { border-bottom: 1px solid var(--line); color: var(--text); text-decoration: none; }
.nftv-row:hover { background: var(--hover); }
.nftv-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.nftv-name img, .nftv-noimg { width: 26px; height: 26px; border-radius: 6px; object-fit: cover; flex: none; background: var(--panel-2); }
.nftv-name b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nftv-verified { color: var(--blue); font-size: 11px; }
.nftv-chain { font-size: 9px; color: var(--dim); text-transform: uppercase; }
.nftv-mint { display: inline-flex; align-items: center; gap: 3px; background: var(--accent); color: #04140d; border: 0; border-radius: 5px; padding: 1px 6px; font-size: 10px; font-weight: 600; cursor: pointer; }
.nftv-num { display: flex; flex-direction: column; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nftv-num small { font-size: 10px; }
.nftv-num.up { color: var(--good); } .nftv-num.down { color: var(--err); }
.nftv-foot { padding: 8px 10px; font-size: 10px; text-align: center; }
.seg-sm button { padding: 2px 7px; font-size: 10px; }
```

If `.seg` does not exist as a segmented control in `index.css`, copy the rule used by Settings' provider toggle (search `.seg {`).

- [ ] **Step 4: Verify** — `npm run dev`, add an OpenSea Volume column, toggle 1H/1D (subtitle and volume column change, new key polled within ~2s), click a row opens OpenSea. `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "OpenSea Volume column with 1H / 1D switch" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part C: OpenSea mint window

### Task 8: chains table and SIWE session

**Files:**
- Create: `backend/src/opensea/chains.ts`, `backend/src/opensea/session.ts`
- Test: `backend/src/opensea/session.test.ts`
- Modify: `backend/package.json` (`"viem": "^2.21.0"` in dependencies) then `npm install`

- [ ] **Step 1: Install viem**

Run: `npm i viem@2 -w backend` and confirm `node -e "import('viem').then(()=>console.log('ok'))"` from `backend/` prints `ok`.

- [ ] **Step 2: `chains.ts`**

```ts
/** OpenSea chain identifier → what the minter needs. RPCs are public defaults; ⚙ → Trading overrides them. */
export interface ChainInfo { id: string; name: string; chainId: number; symbol: string; defaultRpc: string; explorerTx: string }
export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', defaultRpc: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/' },
  base: { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', defaultRpc: 'https://mainnet.base.org', explorerTx: 'https://basescan.org/tx/' },
  robinhood: { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, symbol: 'ETH', defaultRpc: 'https://rpc.mainnet.chain.robinhood.com', explorerTx: 'https://robinhoodchain.blockscout.com/tx/' },
  ink: { id: 'ink', name: 'Ink', chainId: 57073, symbol: 'ETH', defaultRpc: 'https://rpc-qnd.inkonchain.com', explorerTx: 'https://explorer.inkonchain.com/tx/' },
};
export const rpcFor = (chain: string, overrides: Record<string, string>): string | undefined => overrides[chain] || CHAINS[chain]?.defaultRpc;
```

- [ ] **Step 3: Failing session test**

```ts
import { describe, it, expect } from 'vitest';
import { buildSiweMessage, checkVerifyResponse, SIWE_STATEMENT } from './session.js';

describe('siwe', () => {
  it('builds the exact text osnm-z signs', () => {
    const m = buildSiweMessage({ address: '0x7e6f846Efd40558042633c487ea6d9D67fA84178', uri: 'https://opensea.io/collection/x/overview', chainId: 4663, nonce: 'abcDEF123456', issuedAt: '2026-09-12T19:50:00.000Z' });
    expect(m).toBe(`opensea.io wants you to sign in with your Ethereum account:\n0x7e6f846Efd40558042633c487ea6d9D67fA84178\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io/collection/x/overview\nVersion: 1\nChain ID: 4663\nNonce: abcDEF123456\nIssued At: 2026-09-12T19:50:00.000Z`);
  });
  it('accepts a verify response for the same wallet only', () => {
    const body = { user: { address: '0x7e6f846efd40558042633c487ea6d9d67fa84178' } };
    expect(() => checkVerifyResponse(body, '0x7e6f846Efd40558042633c487ea6d9D67fA84178')).not.toThrow();
    expect(() => checkVerifyResponse(body, '0x0000000000000000000000000000000000000001')).toThrow(/different wallet/);
    expect(() => checkVerifyResponse({}, '0x7e6f846Efd40558042633c487ea6d9D67fA84178')).toThrow();
  });
});
```

- [ ] **Step 4: Run** → FAIL (module missing).

- [ ] **Step 5: `session.ts`**

```ts
import type { PrivateKeyAccount } from 'viem';
import { gql, OPENSEA, OpenSeaError, UA, type GqlOptions } from './gql.js';

export const SIWE_STATEMENT = 'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';

export function buildSiweMessage(p: { address: string; uri: string; chainId: number; nonce: string; issuedAt: string }): string {
  return `opensea.io wants you to sign in with your Ethereum account:\n${p.address}\n\n${SIWE_STATEMENT}\n\nURI: ${p.uri}\nVersion: 1\nChain ID: ${p.chainId}\nNonce: ${p.nonce}\nIssued At: ${p.issuedAt}`;
}

export function checkVerifyResponse(body: any, wallet: string): void {
  const got = String(body?.user?.address ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(got)) throw new OpenSeaError('compat', 'OpenSea sign-in response had no wallet');
  if (got !== wallet.toLowerCase()) throw new OpenSeaError('compat', 'OpenSea signed in a different wallet');
}

export const collectionUrl = (slug: string) => `${OPENSEA}/collection/${slug}/overview`;

/** A signed-in opensea.io session for one wallet: SIWE once, cookies kept in memory, re-signs on 401. */
export class OpenSeaSession {
  private jar = new Map<string, string>();
  private signedIn = false;
  constructor(private account: PrivateKeyAccount, private fetchImpl: typeof fetch = fetch) {}

  get address() {
    return this.account.address;
  }
  private cookie() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private take(res: Response) {
    for (const c of (res.headers as any).getSetCookie?.() ?? []) {
      const kv = String(c).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  private async post(url: string, body: unknown, referer: string) {
    const r = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: OPENSEA, referer, 'user-agent': UA, cookie: this.cookie() }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    this.take(r);
    return r;
  }

  async signIn(chainId: number, slug: string): Promise<void> {
    this.signedIn = false;
    this.jar.clear();
    this.jar.set('connected-account-server-hint', this.account.address.toLowerCase());
    const uri = collectionUrl(slug);
    const nr = await this.post(`${OPENSEA}/__api/auth/siwe/nonce`, {}, uri);
    if (!nr.ok) throw new OpenSeaError('http', `OpenSea nonce failed (${nr.status})`, nr.status);
    const nonce = String(((await nr.json().catch(() => ({}))) as any).nonce ?? '');
    if (!/^[A-Za-z0-9]{8,256}$/.test(nonce)) throw new OpenSeaError('compat', 'OpenSea nonce looked wrong');
    const issuedAt = new Date().toISOString();
    const message = buildSiweMessage({ address: this.account.address, uri, chainId, nonce, issuedAt });
    const signature = await this.account.signMessage({ message });
    const vr = await this.post(`${OPENSEA}/__api/auth/siwe/verify`, { message: { domain: 'opensea.io', address: this.account.address, statement: SIWE_STATEMENT, uri, version: '1', chainId: String(chainId), nonce, issuedAt, accountType: 'Ethereum' }, signature, chainArch: 'EVM' }, uri);
    if (!vr.ok) throw new OpenSeaError('http', `OpenSea sign-in failed (${vr.status})`, vr.status);
    checkVerifyResponse(await vr.json().catch(() => ({})), this.account.address);
    this.signedIn = true;
  }

  /** gql with the session; signs in first when needed and once more on a 401. */
  async gql<T>(chainId: number, slug: string, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.signedIn) await this.signIn(chainId, slug);
    const opts: GqlOptions = { referer: collectionUrl(slug), cookie: this.cookie(), fetchImpl: this.fetchImpl };
    try {
      return await gql<T>(operationName, query, variables, opts);
    } catch (e) {
      if (!(e instanceof OpenSeaError) || e.code !== 'auth_required') throw e;
      await this.signIn(chainId, slug);
      return gql<T>(operationName, query, variables, { ...opts, cookie: this.cookie() });
    }
  }
}
```

- [ ] **Step 6: Run** → PASS. Commit:

```bash
git add backend/package.json package-lock.json backend/src/opensea/chains.ts backend/src/opensea/session.ts backend/src/opensea/session.test.ts
git commit -m "OpenSea: chain table and SIWE wallet session" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Drops: resolve a collection, eligibility, mint action

**Files:**
- Create: `backend/src/opensea/drops.ts`
- Test: `backend/src/opensea/drops.test.ts`

- [ ] **Step 1: Failing test for the locator parser and error mapping**

```ts
import { describe, it, expect } from 'vitest';
import { parseLocator, mintErrorSentence } from './drops.js';

describe('drops', () => {
  it('parses slugs, OpenSea URLs and addresses', () => {
    expect(parseLocator('chump-nft-310989788')).toEqual({ slug: 'chump-nft-310989788' });
    expect(parseLocator('https://opensea.io/collection/r3ordr/overview')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('https://opensea.io/collection/r3ordr?tab=items')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('0x9D2A003322874163CBB18F7F538A1AAEA49B75D1')).toEqual({ address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1' });
    expect(parseLocator('https://example.com/x')).toBeUndefined();
    expect(parseLocator('')).toBeUndefined();
  });
  it('turns OpenSea error typenames into sentences', () => {
    expect(mintErrorSentence(['InsufficientFundError'])).toMatch(/can't cover/);
    expect(mintErrorSentence(['SomethingNewError'])).toMatch(/SomethingNewError/);
    expect(mintErrorSentence([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: `drops.ts`**

```ts
import { gql, OPENSEA, OpenSeaError } from './gql.js';
import type { OpenSeaSession } from './session.js';

export interface DropStage { kind: string; type: string; index: number; startTime?: string; endTime?: string; maxPerWallet?: number }
export interface DropCollection { slug: string; name: string; image?: string; address: string; chain: string; networkId: number; drop?: { kind: string; address: string; stages: DropStage[] } }
export interface StageEligibility { type: string; index: number; eligible: boolean; maxPerWallet?: number; eligibleMax?: number; priceUnit?: number; priceUsd?: number; priceSymbol?: string }
export interface Eligibility { kind: string; minted: number; stages: StageEligibility[] }
export interface MintTx { to: string; data: string; value: string; networkId: number; chain: string }

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

function decodeCollection(c: any): DropCollection | undefined {
  if (!c || c.__typename !== 'Collection' || typeof c.slug !== 'string') return undefined;
  const stages: DropStage[] = (c.drop?.stages ?? []).map((s: any) => ({ kind: String(s.__typename ?? ''), type: String(s.stageType ?? ''), index: Number(s.stageIndex ?? 0), startTime: s.startTime ?? undefined, endTime: s.endTime ?? undefined, maxPerWallet: Number.isFinite(Number(s.maxTotalMintableByWallet)) ? Number(s.maxTotalMintableByWallet) : undefined }));
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
    const hit = hits.find((c) => c.chain?.identifier === chain) ?? hits[0];
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
    minted: Number(drop.minterQuantityMinted ?? 0) || 0,
    stages: (drop.stages ?? []).map((s: any) => ({
      type: String(s.stageType ?? ''),
      index: Number(s.stageIndex ?? 0),
      eligible: s.isEligible === true,
      maxPerWallet: Number.isFinite(Number(s.maxTotalMintableByWallet)) ? Number(s.maxTotalMintableByWallet) : undefined,
      eligibleMax: Number.isFinite(Number(s.eligibleMaxTotalMintableByWallet)) ? Number(s.eligibleMaxTotalMintableByWallet) : undefined,
      priceUnit: Number.isFinite(Number(s.eligiblePrice?.token?.unit)) ? Number(s.eligiblePrice.token.unit) : undefined,
      priceUsd: Number.isFinite(Number(s.eligiblePrice?.usd)) ? Number(s.eligiblePrice.usd) : undefined,
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

/** OpenSea's transaction for minting `quantity` of the drop to the session wallet. Read-only; nothing is signed here. */
export async function mintAction(session: OpenSeaSession, col: DropCollection, quantity: number): Promise<{ actionTypes: string[]; errors: string[]; tx?: MintTx }> {
  if (!col.drop) throw new OpenSeaError('compat', 'not a drop');
  const d = await session.gql<{ swap: any }>(col.networkId, col.slug, 'MintActionTimelineQuery', MINT_ACTION_QUERY, {
    address: session.address,
    fromAssets: [{ asset: { contractAddress: '0x0000000000000000000000000000000000000000', chain: col.chain }, quantity: null }],
    toAssets: [{ asset: { contractAddress: col.drop.address, chain: col.chain, tokenId: '0' }, quantity: String(quantity) }],
    recipient: null,
  });
  const actions: any[] = d.swap?.actions ?? [];
  const txs = actions.map((a) => a?.transactionSubmissionData).filter(Boolean);
  const t = txs[0];
  return {
    actionTypes: actions.map((a) => String(a?.__typename ?? '')),
    errors: (d.swap?.errors ?? []).map((e: any) => String(e?.__typename ?? '')),
    tx: txs.length === 1 && t ? { to: String(t.to ?? ''), data: String(t.data ?? ''), value: String(t.value ?? '0'), networkId: Number(t.chain?.networkId ?? 0), chain: String(t.chain?.identifier ?? '') } : undefined,
  };
}
```

- [ ] **Step 4: Run** → PASS. Commit:

```bash
git add backend/src/opensea/drops.ts backend/src/opensea/drops.test.ts
git commit -m "OpenSea: collection lookup, eligibility and mint action queries" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: `validateMintTransaction` (osnm-z's safety net)

**Files:**
- Create: `backend/src/opensea/validate.ts`
- Test: `backend/src/opensea/validate.test.ts`

- [ ] **Step 1: Failing tests (fixtures built like osnm-z's)**

```ts
import { describe, it, expect } from 'vitest';
import { validateMintTransaction } from './validate.js';

const WALLET = '0x7e6f846efd40558042633c487ea6d9d67fa84178';
const NFT = '0x9d2a003322874163cbb18f7f538a1aaea49b75d1';
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const calldata = (selector: string, over: Partial<{ nft: string; minter: string; qty: number; stage: number }> = {}) => {
  const w = [word(over.nft ?? NFT), word('0xfee'), word(over.minter ?? '0x0'), word((over.qty ?? 1).toString(16)), word('0'), word('0'), word('0'), word('0'), word((over.stage ?? 0).toString(16))];
  return '0x' + selector + w.join('');
};
const col = { slug: 's', name: 's', address: NFT, chain: 'robinhood', networkId: 4663, drop: { kind: 'Erc721SeaDropV1', address: NFT, stages: [] } };
const ok = (data: string) => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data, value: '0', networkId: 4663, chain: 'robinhood' } });

describe('validateMintTransaction', () => {
  it('passes a public mint for the wallet', () => {
    expect(() => validateMintTransaction(ok(calldata('161ac21f')), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { minter: WALLET })), col, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
  });
  it('passes a signed presale on its stage index', () => {
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f', { stage: 2 })), col, WALLET, { type: 'SIGNED_PRESALE', index: 2 }, 1, 4663)).not.toThrow();
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f', { stage: 1 })), col, WALLET, { type: 'SIGNED_PRESALE', index: 2 }, 1, 4663)).toThrow(/stage index/);
  });
  it('rejects everything osnm-z rejects', () => {
    const pub = { type: 'PUBLIC_SALE', index: 0 };
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), errors: ['InsufficientFundError'] }, col, WALLET, pub, 1, 4663)).toThrow(/can't cover/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), actionTypes: ['ApproveAction', 'MintAction'] }, col, WALLET, pub, 1, 4663)).toThrow(/action sequence/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: undefined }, col, WALLET, pub, 1, 4663)).toThrow(/exactly one/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok('').tx!, to: '0x0000000000000000000000000000000000000000', data: calldata('161ac21f') } }, col, WALLET, pub, 1, 4663)).toThrow(/zero/);
    expect(() => validateMintTransaction({ ...ok(calldata('161ac21f')), tx: { ...ok(calldata('161ac21f')).tx!, networkId: 1 } }, col, WALLET, pub, 1, 4663)).toThrow(/network/);
    expect(() => validateMintTransaction(ok('0x16'), col, WALLET, pub, 1, 4663)).toThrow(/selector/);
    expect(() => validateMintTransaction(ok(calldata('4b61cd6f')), col, WALLET, pub, 1, 4663)).toThrow(/selector/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { nft: '0x1111111111111111111111111111111111111111' })), col, WALLET, pub, 1, 4663)).toThrow(/contract/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { minter: '0x2222222222222222222222222222222222222222' })), col, WALLET, pub, 1, 4663)).toThrow(/minter/);
    expect(() => validateMintTransaction(ok(calldata('161ac21f', { qty: 2 })), col, WALLET, pub, 1, 4663)).toThrow(/quantity/);
  });
  it('only decodes calldata for ERC-721 SeaDrop v1', () => {
    const c1155 = { ...col, drop: { ...col.drop, kind: 'Erc1155SeaDropV2' } };
    expect(() => validateMintTransaction(ok('0xdeadbeef00'), c1155, WALLET, { type: 'PUBLIC_SALE', index: 0 }, 1, 4663)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: `validate.ts`**

```ts
import { mintErrorSentence, type DropCollection, type MintTx } from './drops.js';

export class UnsafeMintAction extends Error {}
const SELECTOR: Record<string, string> = { PUBLIC_SALE: '161ac21f', SIGNED_PRESALE: '4b61cd6f', MERKLE_PRESALE: '4300a4e6' };

const wordAt = (data: string, i: number): bigint => {
  const hex = data.slice(2 + 8 + i * 64, 2 + 8 + (i + 1) * 64);
  if (hex.length !== 64) throw new UnsafeMintAction('calldata is shorter than expected');
  return BigInt('0x' + hex);
};
const addrAt = (data: string, i: number): string => {
  const w = wordAt(data, i);
  if (w >> 160n !== 0n) throw new UnsafeMintAction('calldata address word has high bits set');
  return '0x' + w.toString(16).padStart(40, '0');
};

/**
 * osnm-z's checks before anything is signed: one MintAction, one transaction on the expected
 * chain, and for ERC-721 SeaDrop v1 the calldata must be the expected selector for the stage,
 * for this collection, this wallet, this quantity and this stage index.
 */
export function validateMintTransaction(
  action: { actionTypes: string[]; errors: string[]; tx?: MintTx },
  col: DropCollection,
  wallet: string,
  stage: { type: string; index: number },
  quantity: number,
  chainId: number,
): MintTx {
  const err = mintErrorSentence(action.errors);
  if (err) throw new UnsafeMintAction(err);
  if (action.actionTypes.length !== 1 || action.actionTypes[0] !== 'MintAction') throw new UnsafeMintAction(`unexpected action sequence (${action.actionTypes.join(', ') || 'none'})`);
  const tx = action.tx;
  if (!tx) throw new UnsafeMintAction('expected exactly one transaction');
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to) || /^0x0{40}$/.test(tx.to)) throw new UnsafeMintAction('zero or invalid transaction target');
  if (tx.networkId !== chainId) throw new UnsafeMintAction(`network mismatch (${tx.networkId} vs ${chainId})`);
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.data.length < 10) throw new UnsafeMintAction('calldata is shorter than a selector');
  if (!/^\d+$/.test(tx.value)) throw new UnsafeMintAction('invalid value');
  if (col.drop?.kind !== 'Erc721SeaDropV1') return tx;
  const data = tx.data.toLowerCase();
  const want = SELECTOR[stage.type];
  if (!want) throw new UnsafeMintAction(`unknown stage type ${stage.type}`);
  if (data.slice(2, 10) !== want) throw new UnsafeMintAction('mint selector mismatch');
  if (addrAt(data, 0) !== col.address.toLowerCase()) throw new UnsafeMintAction('NFT contract mismatch');
  const minter = addrAt(data, 2);
  if (minter !== '0x' + '0'.repeat(40) && minter !== wallet.toLowerCase()) throw new UnsafeMintAction('minter mismatch');
  if (wordAt(data, 3) !== BigInt(quantity)) throw new UnsafeMintAction('mint quantity mismatch');
  if (stage.type === 'PUBLIC_SALE') {
    if (stage.index !== 0) throw new UnsafeMintAction('public stage index must be 0');
  } else if (wordAt(data, 8) !== BigInt(stage.index)) throw new UnsafeMintAction('mint stage index mismatch');
  return tx;
}
```

- [ ] **Step 4: Run** → PASS. Commit:

```bash
git add backend/src/opensea/validate.ts backend/src/opensea/validate.test.ts
git commit -m "OpenSea: validate mint calldata before signing (ported from osnm-z)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: `Minter`: quote, send, receipt

**Files:**
- Create: `backend/src/opensea/minter.ts`
- Test: `backend/src/opensea/minter.test.ts`

- [ ] **Step 1: Failing tests with fake dependencies**

```ts
import { describe, it, expect } from 'vitest';
import { Minter, toWei, type MinterDeps } from './minter.js';
import type { DropCollection } from './drops.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // hardhat #1, no funds anywhere
const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const col: DropCollection = { slug: 'chump', name: 'Chump', address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1', chain: 'robinhood', networkId: 4663, drop: { kind: 'Erc721SeaDropV1', address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1', stages: [{ kind: 'Erc721SeaDropV1Stage', type: 'PUBLIC_SALE', index: 0, startTime: '2026-09-12T20:00:48.000Z', endTime: '2026-09-14T20:00:48.000Z', maxPerWallet: 3 }] } };
const now = Date.parse('2026-09-13T00:00:00Z');

function deps(over: Partial<MinterDeps> = {}): MinterDeps {
  return {
    resolve: async () => col,
    eligibility: async () => ({ kind: 'Erc721SeaDropV1', minted: 1, stages: [{ type: 'PUBLIC_SALE', index: 0, eligible: true, maxPerWallet: 3, eligibleMax: 3, priceUnit: 0.002, priceUsd: 5, priceSymbol: 'ETH' }] }),
    mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data: '0x161ac21f' + ['9d2a003322874163cbb18f7f538a1aaea49b75d1', 'fee', '0', '2', '0', '0', '0', '0', '0'].map((h) => h.padStart(64, '0')).join(''), value: '4000000000000000', networkId: 4663, chain: 'robinhood' } }),
    rpc: () => ({
      getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      getTransactionCount: async () => 7,
      sendRawTransaction: async () => '0xhash',
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 99n, logs: [{ address: col.address, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + WALLET.slice(2).padStart(64, '0'), '0x' + (462).toString(16).padStart(64, '0')] }] }),
    }),
    now: () => now,
    ...over,
  };
}

describe('Minter', () => {
  it('quotes an open, eligible stage', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const job = await m.quote({ locator: 'chump', quantity: 2 });
    expect(job.state).toBe('ready');
    expect(job.wallet.toLowerCase()).toBe(WALLET);
    expect(job.stage).toMatchObject({ type: 'PUBLIC_SALE', index: 0, maxPerWallet: 3, alreadyMinted: 1 });
    expect(job.price).toEqual({ unitWei: '2000000000000000', totalWei: '4000000000000000', symbol: 'ETH', usd: 10 });
    expect(job.gas).toMatchObject({ limit: 300000, maxFeeWei: '2000000000', estimateWei: '600000000000000' });
    expect(job.balanceWei).toBe('1000000000000000000');
  });
  it('fails without a wallet, without an RPC, or when nothing is open', async () => {
    expect((await new Minter(() => undefined, () => ({}), deps()).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/wallet/);
    expect((await new Minter(() => KEY, () => ({}), deps({ resolve: async () => ({ ...col, chain: 'zora', networkId: 7777777 }) })).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/RPC/);
    const closed = deps({ now: () => Date.parse('2026-09-15T00:00:00Z') });
    expect((await new Minter(() => KEY, () => ({}), closed).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/no open stage/);
  });
  it('fails on quantity over the remaining allowance and on a poor balance', async () => {
    expect((await new Minter(() => KEY, () => ({}), deps()).quote({ locator: 'chump', quantity: 3 })).error).toMatch(/2 left/);
    const poor = deps({ rpc: () => ({ ...deps().rpc('x'), getBalance: async () => 1n }) });
    expect((await new Minter(() => KEY, () => ({}), poor).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/needs/);
  });
  it('sends a validated mint and reads the minted ids from the receipt', async () => {
    const sent: string[] = [];
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), sendRawTransaction: async ({ serializedTransaction }: any) => { sent.push(serializedTransaction); return '0xhash'; } }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const states: string[] = [];
    m.on('job', (j) => states.push(j.state));
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const done = await m.send(q.id);
    expect(done.state).toBe('confirmed');
    expect(done.txHash).toBe('0xhash');
    expect(done.blockNumber).toBe(99);
    expect(done.tokenIds).toEqual(['462']);
    expect(sent[0]).toMatch(/^0x02/); // EIP-1559 envelope
    expect(states).toEqual(['ready', 'sending', 'pending', 'confirmed']);
  });
  it('fails a send whose calldata does not validate', async () => {
    const bad = deps({ mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data: '0x4b61cd6f' + '0'.repeat(576), value: '0', networkId: 4663, chain: 'robinhood' } }) });
    const m = new Minter(() => KEY, () => ({}), bad);
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/selector/);
  });
  it('converts unit prices to wei exactly', () => {
    expect(toWei(0.002)).toBe(2000000000000000n);
    expect(toWei(0)).toBe(0n);
    expect(toWei(1.5)).toBe(1500000000000000000n);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: `minter.ts`**

```ts
import { EventEmitter } from 'node:events';
import { createPublicClient, http, parseEther, type PublicClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CHAINS, rpcFor } from './chains.js';
import { OpenSeaSession } from './session.js';
import { resolveCollection, eligibility as fetchEligibility, mintAction as fetchMintAction, type DropCollection, type Eligibility } from './drops.js';
import { validateMintTransaction } from './validate.js';
import type { MintJob } from '../types.js';

const GAS_LIMIT = 300_000;
const QUOTE_TTL_MS = 2 * 60_000;
const RECEIPT_TIMEOUT_MS = 3 * 60_000;
const MAX_JOBS = 100;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const toWei = (unit: number): bigint => parseEther(unit.toFixed(18).replace(/\.?0+$/, ''));

/** The slice of a viem PublicClient the minter uses; tests pass fakes. */
export interface Rpc {
  getBalance(a: { address: `0x${string}` }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionCount(a: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  sendRawTransaction(a: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
  getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{ status: string; blockNumber: bigint; logs: { address: string; topics: readonly string[] }[] }>;
}
export interface MinterDeps {
  resolve: (locator: string, chain?: string) => Promise<DropCollection>;
  eligibility: (session: OpenSeaSession, col: DropCollection) => Promise<Eligibility>;
  mintAction: (session: OpenSeaSession, col: DropCollection, quantity: number) => ReturnType<typeof fetchMintAction>;
  rpc: (url: string) => Rpc;
  now: () => number;
}
const LIVE: MinterDeps = {
  resolve: (l, c) => resolveCollection(l, c),
  eligibility: fetchEligibility,
  mintAction: fetchMintAction,
  rpc: (url) => createPublicClient({ transport: http(url) }) as unknown as Rpc,
  now: () => Date.now(),
};

/**
 * Quote → send → receipt for one SeaDrop mint with the configured wallet. Every state change is
 * emitted as 'job'. Errors never throw out of quote()/send(): the job ends 'failed' with a sentence.
 */
export class Minter extends EventEmitter {
  readonly jobs: MintJob[] = [];
  private sessions = new Map<string, OpenSeaSession>();
  constructor(
    private walletKey: () => string | undefined,
    private rpcOverrides: () => Record<string, string>,
    private deps: MinterDeps = LIVE,
  ) {
    super();
  }

  /** the wallet's address, for the UI (undefined without a key) */
  address(): string | undefined {
    const k = this.walletKey();
    return k ? privateKeyToAccount(k as `0x${string}`).address : undefined;
  }
  private account(): PrivateKeyAccount | undefined {
    const k = this.walletKey();
    return k ? privateKeyToAccount(k as `0x${string}`) : undefined;
  }
  private session(acct: PrivateKeyAccount): OpenSeaSession {
    let s = this.sessions.get(acct.address);
    if (!s) this.sessions.set(acct.address, (s = new OpenSeaSession(acct)));
    return s;
  }
  private put(job: MintJob, patch: Partial<MintJob>): MintJob {
    Object.assign(job, patch, { updatedAt: this.deps.now() });
    this.emit('job', { ...job });
    return job;
  }
  private fail(job: MintJob, error: string): MintJob {
    return this.put(job, { state: 'failed', error });
  }

  async quote(req: { locator: string; chain?: string; quantity: number }): Promise<MintJob> {
    const quantity = Math.max(1, Math.floor(Number(req.quantity) || 1));
    const job: MintJob = { id: `m${this.deps.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: this.deps.now(), updatedAt: this.deps.now(), state: 'quoting', collection: { slug: '', name: req.locator, address: '', chain: req.chain ?? '', networkId: 0, dropKind: '' }, quantity, wallet: '' };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.shift();
    try {
      const acct = this.account();
      if (!acct) return this.fail(job, 'Add a wallet in ⚙ → Trading first.');
      job.wallet = acct.address;
      const col = await this.deps.resolve(req.locator, req.chain);
      job.collection = { slug: col.slug, name: col.name, image: col.image, address: col.address, chain: col.chain, networkId: col.networkId, dropKind: col.drop?.kind ?? '' };
      if (!col.drop) return this.fail(job, `${col.name} is not an OpenSea drop, so there is nothing to mint here.`);
      if (col.drop.kind !== 'Erc721SeaDropV1') return this.fail(job, `${col.drop.kind} drops are not supported yet (ERC-721 SeaDrop only).`);
      const rpc = rpcFor(col.chain, this.rpcOverrides());
      if (!rpc) return this.fail(job, `No RPC for ${col.chain}. Add one in ⚙ → Trading → OpenSea RPCs.`);
      const info = CHAINS[col.chain];
      const chainId = info?.chainId ?? col.networkId;
      const elig = await this.deps.eligibility(this.session(acct), col);
      const now = this.deps.now();
      const openIdx = col.drop.stages.filter((s) => Date.parse(s.startTime ?? '') <= now && (!s.endTime || now < Date.parse(s.endTime)));
      const open = openIdx.map((s) => ({ s, e: elig.stages.find((x) => x.type === s.type && x.index === s.index) })).find((p) => p.e?.eligible) ?? openIdx.map((s) => ({ s, e: elig.stages.find((x) => x.type === s.type && x.index === s.index) }))[0];
      if (!open) {
        const next = col.drop.stages.map((s) => Date.parse(s.startTime ?? '')).filter((t) => t > now).sort()[0];
        return this.fail(job, next ? `no open stage; the next one starts ${new Date(next).toLocaleString()}` : 'no open stage, the drop has ended');
      }
      if (!open.e?.eligible) return this.fail(job, `the open ${open.s.type.toLowerCase().replace('_', ' ')} stage is not open to this wallet (no open stage you're eligible for)`);
      const max = open.e.eligibleMax ?? open.e.maxPerWallet ?? open.s.maxPerWallet;
      const left = max === undefined ? Infinity : Math.max(0, max - elig.minted);
      job.stage = { type: open.s.type, index: open.s.index, startTime: open.s.startTime, endTime: open.s.endTime, maxPerWallet: max, alreadyMinted: elig.minted };
      if (quantity > left) return this.fail(job, `this wallet can mint ${left} more (${elig.minted} of ${max} used), not ${quantity}`);
      const unitWei = toWei(open.e.priceUnit ?? 0);
      const totalWei = unitWei * BigInt(quantity);
      job.price = { unitWei: unitWei.toString(), totalWei: totalWei.toString(), symbol: open.e.priceSymbol ?? info?.symbol ?? 'ETH', usd: open.e.priceUsd !== undefined ? open.e.priceUsd * quantity : undefined };
      const client = this.deps.rpc(rpc);
      const [balance, fees] = await Promise.all([client.getBalance({ address: acct.address }), client.estimateFeesPerGas()]);
      const estimate = fees.maxFeePerGas * BigInt(GAS_LIMIT);
      job.gas = { limit: GAS_LIMIT, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString(), estimateWei: estimate.toString() };
      job.balanceWei = balance.toString();
      if (balance < totalWei + estimate) return this.fail(job, `needs ${fmt(totalWei + estimate)} ${job.price.symbol} (price + gas), wallet has ${fmt(balance)}`);
      void chainId;
      return this.put(job, { state: 'ready' });
    } catch (e: any) {
      return this.fail(job, e?.message ?? String(e));
    }
  }

  async send(jobId: string): Promise<MintJob> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('no such quote');
    if (job.state !== 'ready') throw new Error(`quote is ${job.state}`);
    if (this.deps.now() - job.updatedAt > QUOTE_TTL_MS) return this.fail(job, 'the quote is older than two minutes; quote again');
    const acct = this.account();
    if (!acct || acct.address !== job.wallet) return this.fail(job, 'the wallet changed since the quote');
    this.put(job, { state: 'sending' });
    try {
      const col = await this.deps.resolve(job.collection.slug, job.collection.chain);
      const chainId = CHAINS[col.chain]?.chainId ?? col.networkId;
      const rpc = rpcFor(col.chain, this.rpcOverrides());
      if (!rpc) return this.fail(job, `No RPC for ${col.chain}.`);
      const client = this.deps.rpc(rpc);
      const action = await this.deps.mintAction(this.session(acct), col, job.quantity);
      const tx = validateMintTransaction(action, col, acct.address, job.stage!, job.quantity, chainId);
      const [nonce, fees] = await Promise.all([client.getTransactionCount({ address: acct.address, blockTag: 'pending' }), client.estimateFeesPerGas()]);
      const signed = await acct.signTransaction({ type: 'eip1559', chainId, nonce, gas: BigInt(GAS_LIMIT), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: tx.to as `0x${string}`, value: BigInt(tx.value), data: tx.data as `0x${string}` });
      const hash = await client.sendRawTransaction({ serializedTransaction: signed });
      this.put(job, { state: 'pending', txHash: hash, gas: { ...job.gas!, maxFeeWei: fees.maxFeePerGas.toString(), maxPriorityWei: fees.maxPriorityFeePerGas.toString() } });
      const started = this.deps.now();
      let delay = 250;
      while (this.deps.now() - started < RECEIPT_TIMEOUT_MS) {
        try {
          const r = await client.getTransactionReceipt({ hash });
          if (r) {
            if (r.status !== 'success') return this.fail(job, `the mint transaction reverted (${hash})`);
            const ids = r.logs.filter((l) => l.address.toLowerCase() === col.address && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 4 && ('0x' + l.topics[2].slice(-40)) === acct.address.toLowerCase() && /^0x0{64}$/.test(l.topics[1])).map((l) => BigInt(l.topics[3]).toString());
            return this.put(job, { state: 'confirmed', blockNumber: Number(r.blockNumber), tokenIds: ids });
          }
        } catch {
          /* not mined yet */
        }
        await new Promise((res) => setTimeout(res, delay));
        delay = Math.min(2000, delay * 2);
      }
      return this.fail(job, `no receipt after three minutes; check ${hash} on the explorer`);
    } catch (e: any) {
      return this.fail(job, e?.message ?? String(e));
    }
  }
}

const fmt = (wei: bigint) => (Number(wei) / 1e18).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
```

Note for the test's fake `getTransactionReceipt`: viem throws when the receipt is missing; the loop treats a throw and a `null` the same way. In tests `setTimeout` is real but the receipt comes back on the first poll.

- [ ] **Step 4: Run** → PASS (7 tests). If `acct.signTransaction` needs `chain`-typed fields, pass the object through `as any` rather than importing chain definitions; the raw hex must start with `0x02`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/opensea/minter.ts backend/src/opensea/minter.test.ts
git commit -m "OpenSea: Minter quotes, sends and confirms SeaDrop mints" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Mint window API and config routes

**Files:**
- Modify: `backend/src/services.ts`, `backend/src/api.ts`, `backend/src/config.ts` (`masked()`)

- [ ] **Step 1: Services**

```ts
import { Minter } from './opensea/minter.js';
import { CHAINS } from './opensea/chains.js';
// field:
readonly minter = new Minter(() => this.cfg.get().opensea.walletKey, () => this.cfg.get().opensea.rpc);
// constructor, after the rankings wiring:
this.minter.on('job', (job) => this.hub.emit('event', { type: 'mintJob', job }));
this.hub.nftState.mintJobs = () => this.minter.jobs;
// method:
openseaMasked() {
  const o = this.cfg.get().opensea;
  return { hasWallet: !!o.walletKey, walletAddress: this.minter.address(), rpc: o.rpc, chains: Object.values(CHAINS).map((c) => ({ id: c.id, name: c.name, defaultRpc: c.defaultRpc, symbol: c.symbol })) };
}
```

- [ ] **Step 2: API routes** (next to the J7 routes)

```ts
  // OpenSea mint window
  r.get('/osmint/jobs', wrap(() => svc.minter.jobs));
  r.post(
    '/osmint/quote',
    wrap((req) => {
      const locator = String(req.body?.locator ?? '').trim();
      if (!locator) throw new Error('locator required');
      const chain = req.body?.chain ? String(req.body.chain) : undefined;
      return svc.minter.quote({ locator, chain, quantity: Number(req.body?.quantity ?? 1) });
    }),
  );
  r.post(
    '/osmint/send',
    wrap((req) => {
      const jobId = String(req.body?.jobId ?? '');
      // the send runs on; the job's states arrive over the socket
      void svc.minter.send(jobId).catch((e) => console.warn('[osmint] send', e?.message ?? e));
      return { ok: true };
    }),
  );
  r.get('/opensea', wrap(() => svc.openseaMasked()));
  r.put(
    '/opensea/wallet',
    wrap((req) => {
      const key = String(req.body?.key ?? '').trim();
      if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('a private key is 0x followed by 64 hex characters');
      cfg.update((c) => {
        c.opensea.walletKey = key || undefined;
      });
      return svc.openseaMasked();
    }),
  );
  r.put(
    '/opensea/rpc',
    wrap((req) => {
      const chain = String(req.body?.chain ?? '');
      const url = String(req.body?.url ?? '').trim();
      if (!/^[a-z_]{1,30}$/.test(chain)) throw new Error('bad chain');
      if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(url)) throw new Error('RPC must be https:// (or a local http endpoint)');
      cfg.update((c) => {
        if (url) c.opensea.rpc[chain] = url;
        else delete c.opensea.rpc[chain];
      });
      return svc.openseaMasked();
    }),
  );
```

- [ ] **Step 3: Masked config carries the address**

`ConfigStore.masked()` is called without services; keep its `opensea: { hasWallet, rpc }` and have the frontend call `GET /opensea` for the address and chain table (Settings) — add `opensea: () => req<MaskedConfig['opensea']>('GET', '/opensea')`, `setOpenSeaWallet: (key: string) => req<MaskedConfig['opensea']>('PUT', '/opensea/wallet', { key })`, `setOpenSeaRpc: (chain: string, url: string) => req<MaskedConfig['opensea']>('PUT', '/opensea/rpc', { chain, url })`, `osQuote: (locator: string, quantity: number, chain?: string) => req<MintJob>('POST', '/osmint/quote', { locator, quantity, chain })`, `osSend: (jobId: string) => req<{ ok: true }>('POST', '/osmint/send', { jobId })` to `frontend/src/api.ts`. Make `MaskedConfig.opensea.walletAddress` and `.chains` optional (`?`) since `/config` omits them.

- [ ] **Step 4: Prove the read-only half live** (no wallet, so nothing can be sent)

```bash
curl -s -X POST localhost:3210/api/osmint/quote -H 'content-type: application/json' -d '{"locator":"chump-nft-310989788","quantity":1}'
```

Expected: a job with `state: "failed"` and `error: "Add a wallet in ⚙ → Trading first."`. Then set a throwaway key (generate one: `node -e "import('viem/accounts').then(m=>console.log(m.generatePrivateKey()))"` from `backend/`), PUT it to `/opensea/wallet`, quote again: `failed` with `needs 0.0006 ETH (price + gas), wallet has 0` (numbers vary) and a filled `stage` / `price` — that proves resolve, SIWE, eligibility and RPC. Remove the key afterwards (`PUT /opensea/wallet {"key":""}`).

- [ ] **Step 5: Commit**

```bash
git add backend/src frontend/src/api.ts
git commit -m "OpenSea mint window: quote/send API, wallet and RPC settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Mint window UI, wallet settings, Mint buttons

**Files:**
- Create: `frontend/src/components/OsMintView.tsx`
- Modify: `frontend/src/components/Settings.tsx` (Trading tab), `frontend/src/App.tsx`, `frontend/src/index.css`

- [ ] **Step 1: `OsMintView.tsx`**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MintJob } from '../types';
import { api } from '../api';
import { Icon } from './Icon';

const EXPLORER: Record<string, string> = { ethereum: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', robinhood: 'https://robinhoodchain.blockscout.com/tx/', ink: 'https://explorer.inkonchain.com/tx/' };
const eth = (wei?: string, sym = 'ETH') => (wei === undefined ? '—' : `${(Number(wei) / 1e18).toFixed(5).replace(/0+$/, '').replace(/\.$/, '') || '0'} ${sym}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const stageLabel = (t: string) => t.toLowerCase().replace(/_/g, ' ').replace('sale', '').trim() || 'stage';
const until = (iso?: string, now = Date.now()) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'ended';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${Math.floor((ms % 3600e3) / 60e3)}m` : `${Math.floor(ms / 60e3)}m`;
};

function JobCard({ j, now, onSend, busy }: { j: MintJob; now: number; onSend: (id: string) => void; busy: boolean }) {
  const sym = j.price?.symbol ?? 'ETH';
  const head = j.state === 'quoting' ? '… Quoting' : j.state === 'ready' ? '◎ Ready to mint' : j.state === 'sending' ? '⏳ Sending' : j.state === 'pending' ? '🔵 Pending' : j.state === 'confirmed' ? '✓ Mint confirmed' : '✗ Mint failed';
  const tx = j.txHash && EXPLORER[j.collection.chain] ? `${EXPLORER[j.collection.chain]}${j.txHash}` : undefined;
  return (
    <div className={`bmsg osj osj-${j.state}`}>
      <div className="osj-head"><b>{head}</b><span className="muted">{new Date(j.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
      <div className="osj-col">
        {j.collection.image && <img src={j.collection.image} alt="" />}
        <div>
          <b>{j.collection.name}</b> <span className="muted">· {j.collection.chain}</span>
          {j.stage && <div className="muted">{stageLabel(j.stage.type)} stage{j.stage.endTime ? ` · ends in ${until(j.stage.endTime, now)}` : ''}{j.stage.maxPerWallet !== undefined ? ` · ${j.stage.alreadyMinted ?? 0}/${j.stage.maxPerWallet} per wallet` : ''}</div>}
        </div>
      </div>
      {j.price && (
        <div className="osj-lines">
          <span>Quantity</span><b>{j.quantity}</b>
          <span>Price</span><b>{eth(j.price.totalWei, sym)}{j.price.usd !== undefined ? <small className="muted"> ≈ ${j.price.usd.toFixed(2)}</small> : null}</b>
          {j.gas && <><span>Gas (max)</span><b>{eth(j.gas.estimateWei, sym)}</b></>}
          {j.balanceWei && <><span>Wallet</span><b>{eth(j.balanceWei, sym)}</b></>}
        </div>
      )}
      {j.state === 'confirmed' && <div className="osj-ok">{j.tokenIds?.length ? `#${j.tokenIds.join(', #')}` : 'minted'}{j.blockNumber ? ` · block ${j.blockNumber}` : ''}</div>}
      {j.error && <div className="osj-err">{j.error}</div>}
      <div className="bkeys"><div className="bkey-row">
        {j.state === 'ready' && <button className="bkey osj-mint" disabled={busy} onClick={() => onSend(j.id)}>Mint {j.quantity} for {eth(j.price?.totalWei, sym)}</button>}
        {tx && <a className="bkey bkey-url" href={tx} target="_blank" rel="noreferrer">tx <Icon name="explorer" size={10} /></a>}
        {j.collection.slug && <a className="bkey bkey-url" href={`https://opensea.io/collection/${j.collection.slug}`} target="_blank" rel="noreferrer">OpenSea <Icon name="explorer" size={10} /></a>}
      </div></div>
    </div>
  );
}

/** The OpenSea mint window: quote a drop, press Mint, watch the card go pending → confirmed. */
export function OsMintView({ jobs, now, wallet, prefill, onPrefilled }: { jobs: MintJob[]; now: number; wallet?: string; prefill?: { locator: string; chain?: string } | null; onPrefilled: () => void }) {
  const [locator, setLocator] = useState('');
  const [chain, setChain] = useState<string | undefined>();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const flash = (t: string) => { setToast(t); window.setTimeout(() => setToast(null), 4000); };
  const quote = async (l = locator, c = chain, q = qty) => {
    if (!l.trim()) return;
    setBusy(true);
    try { await api.osQuote(l.trim(), q, c); } catch (e: any) { flash(e?.message ?? 'quote failed'); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!prefill) return;
    setLocator(prefill.locator);
    setChain(prefill.chain);
    onPrefilled();
    void quote(prefill.locator, prefill.chain, qty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  useLayoutEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight; }, [jobs]);
  const send = async (id: string) => {
    setBusy(true);
    try { await api.osSend(id); } catch (e: any) { flash(e?.message ?? 'send failed'); } finally { setBusy(false); }
  };
  return (
    <div className="cove osm">
      <div className="osm-bar muted">
        <Icon name="wallet" size={12} /> {wallet ? short(wallet) : 'no wallet — add one in ⚙ → Trading'}
      </div>
      <div className="cove-body" ref={body}>
        {jobs.length === 0 && <div className="empty">Paste a collection below, or press Mint on a MintGo card or a minting row in OpenSea Volume.</div>}
        {jobs.map((j) => <JobCard key={j.id} j={j} now={now} onSend={send} busy={busy} />)}
      </div>
      {toast && <div className="cove-toast">{toast}</div>}
      <div className="composer cove-composer osm-composer">
        <div className="composer-row">
          <input value={locator} onChange={(e) => { setLocator(e.target.value); setChain(undefined); }} placeholder="collection slug, opensea.io link or 0x address" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && void quote()} />
          <input className="osm-qty" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} title="quantity" />
          <button className="composer-send" disabled={busy || !locator.trim()} onClick={() => void quote()} title="quote (Enter)">Quote</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Settings → Trading → OpenSea wallet**

Add a section component and render it in the Trading tab after `CoveSection`:

```tsx
function OpenSeaSection() {
  const [os, setOs] = useState<MaskedConfig['opensea'] | null>(null);
  const [key, setKey] = useState('');
  const [rpc, setRpc] = useState<Record<string, string>>({});
  const { busy, err, run } = useAsync();
  const load = () => api.opensea().then((o) => { setOs(o); setRpc(o.rpc); }).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!os) return null;
  return (
    <section>
      <h2>OpenSea mint wallet</h2>
      <div className="hint">
        The OpenSea Mint column signs mints with this key and pays from this wallet. Use a <b>dedicated wallet</b> holding only what you mean to spend: the key is stored in plain text in config.json on this machine, and a mint is irreversible once sent.
      </div>
      <div className="row-inline">
        <input type="password" placeholder={os.hasWallet ? `saved · ${os.walletAddress}` : 'private key (0x…)'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        <button disabled={busy || !key} onClick={() => run(async () => { setOs(await api.setOpenSeaWallet(key.trim())); setKey(''); })}>Save</button>
        {os.hasWallet && <button disabled={busy} onClick={() => run(async () => setOs(await api.setOpenSeaWallet('')))}>Remove</button>}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>RPC endpoints. Blank uses the public default.</div>
      {(os.chains ?? []).map((c) => (
        <div className="row-inline" key={c.id}>
          <span className="muted" style={{ width: 120, fontSize: 12 }}>{c.name}</span>
          <input placeholder={c.defaultRpc} value={rpc[c.id] ?? ''} onChange={(e) => setRpc((r) => ({ ...r, [c.id]: e.target.value }))} spellCheck={false} />
          <button disabled={busy} onClick={() => run(async () => { const o = await api.setOpenSeaRpc(c.id, rpc[c.id] ?? ''); setOs(o); setRpc(o.rpc); })}>Save</button>
        </div>
      ))}
      {err && <div className="err">{err}</div>}
    </section>
  );
}
```

(`MaskedConfig` and `useEffect` are already imported in Settings; `useAsync` exists there.)

- [ ] **Step 3: App: the mint pane and the Mint buttons**

Near `ensureBotColumn`:

```tsx
  // OpenSea mint window: one 'osmint' column, created on first use and flashed, prefilled by Mint buttons.
  const [mintPrefill, setMintPrefill] = useState<{ locator: string; chain?: string } | null>(null);
  const [osAddr, setOsAddr] = useState<string | undefined>();
  useEffect(() => { void api.opensea().then((o) => setOsAddr(o.walletAddress)).catch(() => {}); }, [cfg?.opensea?.hasWallet, settingsOpen]);
  const mintFrom = (target: { locator: string; chain?: string }) => {
    if (!flatColumns.some((c) => c.type === 'osmint')) saveColumns([...columns, { id: 'osmint', type: 'osmint', title: 'OpenSea Mint', chats: [], width: 400 }]);
    setMintPrefill(target);
    setCoveFlash('osmint');
    window.setTimeout(() => setCoveFlash(null), 1500);
  };
```

(`settingsOpen` is whatever state toggles the Settings modal; if it has another name use that, so the address refreshes after saving a key.) In `renderColumn`:

```tsx
    if (col.type === 'osmint') {
      return (
        <Column key={col.id} title={col.title} subtitle={osAddr ? `${osAddr.slice(0, 6)}…${osAddr.slice(-4)} · opensea.io` : 'no wallet yet'} kind="osmint" className={`col-cove col-osmint${coveFlash === 'osmint' ? ' col-flash' : ''}`} {...actions}>
          <OsMintView jobs={mintJobs} now={now} wallet={osAddr} prefill={mintPrefill} onPrefilled={() => setMintPrefill(null)} />
        </Column>
      );
    }
```

Replace the two `onMint={undefined}` placeholders from Tasks 4 and 7 with the `mintFrom(...)` calls shown there. The MintGo card's `onMint` passes `{ locator: e.contract.slug!, chain: e.chain }`; the ranking row passes `{ locator: r.slug, chain: r.chain }`.

- [ ] **Step 4: CSS**

```css
/* ---------- OpenSea mint window ---------- */
.osm-bar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 11px; border-bottom: 1px solid var(--line); }
.osj { width: 100%; max-width: 100%; align-self: stretch; }
.osj-head { display: flex; justify-content: space-between; font-size: 13px; }
.osj-ready { border-color: rgba(65, 200, 146, 0.45); }
.osj-confirmed { border-color: rgba(65, 200, 146, 0.7); }
.osj-failed { border-color: rgba(242, 102, 130, 0.5); }
.osj-pending, .osj-sending { border-color: rgba(100, 126, 255, 0.5); }
.osj-col { display: flex; gap: 8px; align-items: center; margin-top: 6px; font-size: 12px; }
.osj-col img { width: 32px; height: 32px; border-radius: 7px; object-fit: cover; }
.osj-lines { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin-top: 6px; font-size: 12px; }
.osj-lines span { color: var(--muted); }
.osj-lines b { text-align: right; font-variant-numeric: tabular-nums; }
.osj-ok { margin-top: 6px; color: var(--good); font-size: 12px; }
.osj-err { margin-top: 6px; color: var(--err); font-size: 12px; }
.osj-mint { background: var(--accent) !important; color: #04140d !important; border-color: transparent !important; font-weight: 600; }
.osm-composer .composer-row { display: flex; gap: 6px; align-items: center; }
.osm-composer input { flex: 1; min-width: 0; }
.osm-qty { flex: 0 0 56px !important; }
```

- [ ] **Step 5: Verify** — `npm run typecheck`; `npm run dev`: add OpenSea Mint, paste `chump-nft-310989788` (or any drop from the volume column's Mint pill), see the failed card without a wallet; with a throwaway key see a `failed · needs …` card carrying stage and price. Press Mint on a MintGo card: the pane is created/flashed and a quote appears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "OpenSea Mint column: quote cards, Mint button, wallet settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: Docs, review, release notes

**Files:**
- Modify: `CHANGELOG.md` (Unreleased), `README.md` (column list / Settings paragraph)

- [ ] **Step 1: CHANGELOG under `## Unreleased`**

```
- New column: **MintGo**. NFT mints on Ethereum, Robinhood Chain and Ink as they happen, straight from mintgo.fun's live feed: collection, quantity, price, minter and supply on each card; click one for its X, OpenSea and website links, the transaction, the deployer's history, and a Mint button. Filter by chain or minimum quantity in ✎.
- New column: **OpenSea Volume**. OpenSea's Trending or Top collections with floor, volume, sales and floor change, and a 1H / 1D switch in the header. Rows open the collection; a collection with an open SeaDrop stage gets a Mint pill.
- New column: **OpenSea Mint**. Paste a collection (slug, link or address) or press Mint anywhere: the card shows the open stage, your allowance, price, gas and balance, and one press mints with the wallet from ⚙ → Trading → OpenSea mint wallet. Cards go sent → pending → confirmed with the minted ids and explorer links. ERC-721 SeaDrop drops only, one wallet, dedicated-wallet warning in Settings.
```

- [ ] **Step 2: README** — add the three columns to the column types paragraph and "Trading (Cove amounts, o1 key, OpenSea mint wallet + RPCs)" to the Settings sentence.

- [ ] **Step 3: Money-path review** — run the `money-path-adversarial-review` skill on `backend/src/opensea/` before any release; fix what it finds; commit.

- [ ] **Step 4: One real mint** — with a dedicated wallet holding a few dollars on Robinhood Chain, mint 1 of a free/cheap open drop from the volume column's Mint pill; confirm the card reaches `confirmed` with a token id and the explorer link resolves. Record the tx hash in the PR description.

- [ ] **Step 5: Commit and hand off**

```bash
git add CHANGELOG.md README.md
git commit -m "NFT columns: release notes and README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then use `superpowers:finishing-a-development-branch` (PR against `main`).

---

## Self-review notes

- Spec coverage: MintGo feed (Tasks 2–4), volume 1H/1D (5–7), purchasing window with wallet, quote, send, cards (8–13), Settings wallet/RPC (12–13), hello/ws plumbing (1, 3, 6, 12), non-goals untouched.
- The `Status.mintgo` initial value and `nftState` on the hub are set in Task 3; `syncColumnFeeds` (Task 6) replaces the `startMintGo` call sites from Task 3.
- Frontend `MaskedConfig.opensea` fields `walletAddress`/`chains` are optional because `/config` omits them and `/opensea` fills them (Task 12).
