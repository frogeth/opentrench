# NFT columns: MintGo feed, OpenSea volume, OpenSea mint window — design

Date: 2026-09-12. Branch: `feat/opensea-mintgo-columns`.
Research behind every endpoint here: `docs/research/2026-09-12-nft-columns-research.md`.

## Goal

Three new column types so the terminal covers NFT mints the way it covers
token calls:

1. **MintGo** — mints as they happen on Ethereum, Robinhood Chain and Ink,
   one card per mint event; click a card for the collection's X, OpenSea,
   website and explorer links, and a Mint button.
2. **OpenSea Volume** — OpenSea's trending / top collections table with a
   **1H / 1D** switch in the header.
3. **OpenSea Mint** — the purchasing window: paste a collection (or arrive
   from a Mint button), see the open stage, price and your wallet, press
   Mint, and watch the order card go sent → confirmed, in the same shape as
   the Cove pane.

Everything runs locally against MintGo's and OpenSea's private web APIs,
signing with a wallet key the user stores in the app, like osnm-z's
single-wallet mode.

## Non-goals (v1)

Multi-wallet and sponsored (EIP-7702) minting, scheduled mints ahead of a
stage opening, buying listed NFTs on the secondary market (Seaport), MintGo's
custodial wallet and helper-contract mints for non-SeaDrop collections, mint
alerts/sounds, persisting the mint feed across restarts, ERC-1155 SeaDrop
drops (shown, not mintable), a MintGo "runners" table (the volume column
covers that need).

## Assumptions made without asking

The session was autonomous, so these are the calls a careful colleague would
make; each is cheap to change:

- Column type ids `mints`, `nftvol`, `osmint`; default titles "MintGo",
  "OpenSea Volume", "OpenSea Mint".
- The volume column defaults to **Trending · 1H**; the ranking (Trending/Top)
  is set in the editor, the timeframe with header buttons. Only 1H and 1D are
  offered (the picture asks for those two).
- One wallet, stored as a private key in `backend/config.json` next to the
  other secrets, entered in Settings → Trading. A public RPC per chain by
  default, overridable there.
- Minting supports every chain OpenSea puts a SeaDrop on, provided an RPC is
  configured: Ethereum, Base, Robinhood Chain, Ink out of the box.
- The MintGo feed keeps the last 300 events in memory; a restart starts
  empty and fills within seconds (MintGo has no history endpoint).

## Architecture

```
backend/src/
  mintgo.ts              MintGoClient: session cookie, realtime socket, batch decoder, ring buffer  (new)
  mintgo.test.ts         decoder + upsert tests                                                    (new)
  opensea/
    gql.ts               one fetch wrapper for gql.opensea.io (+ error classification)             (new)
    rankings.ts          RankingsPoller: collectionRankings per (slug, timeframe) key, 60s        (new)
    rankings.test.ts     normalizer tests                                                          (new)
    session.ts           OpenSeaSession: SIWE sign-in, cookie jar, authenticated gql              (new)
    session.test.ts      SIWE message builder + verify-response check                              (new)
    drops.ts             collection lookup (slug / address), stages, eligibility, mint action     (new)
    validate.ts          port of osnm-z validate_mint_transaction (+ calldata decode)              (new)
    validate.test.ts     selector / word tests with osnm-z's fixtures                              (new)
    minter.ts            Minter: quote → send → receipt, MintJob log, viem wallet + public client  (new)
    minter.test.ts       quote math, state machine, receipt parsing (fake clients)                 (new)
    chains.ts            chain identifier → { id, rpc default, symbol, explorer }                 (new)
  config.ts              ColumnDef types + `opensea: { walletKey?, rpc }` + masked()              (edit)
  types.ts               MintEvent, NftRanking, MintJob, ServerEvent additions, Status.mintgo     (edit)
  services.ts            owns MintGoClient, RankingsPoller, Minter; wires events to the hub       (edit)
  api.ts                 /mints/recent, /nft/rankings, /osmint/* , /opensea/wallet, /opensea/rpc  (edit)
  hub.ts                 hello() carries recent mints, rankings, mint jobs                        (edit)
frontend/src/
  components/MintFeed.tsx     MintGo column body: cards, expand, links, Mint            (new)
  components/NftRankings.tsx  volume table                                              (new)
  components/OsMintView.tsx   purchasing window                                          (new)
  components/ColumnEditor.tsx type cards + options                                       (edit)
  components/Column.tsx       kind icons                                                 (edit)
  components/Settings.tsx     Trading → OpenSea wallet + RPCs                            (edit)
  components/Icon.tsx         'mint', 'sea', 'wallet' glyphs                             (edit)
  App.tsx                     render switch, ensureMintPane, timeframe toggle            (edit)
  useFeed.ts, api.ts, types.ts                                                            (edit)
  index.css                                                                               (edit)
backend/package.json          + viem                                                     (edit)
```

## Data model (backend/src/types.ts, mirrored in frontend/src/types.ts)

```ts
export type MintChain = 'ethereum' | 'robinhood' | 'ink' | 'stable' | 'arc';

/** One mint (one tx) seen by MintGo. `preview` rows are later replaced by the confirmed one under the same id. */
export interface MintEvent {
  id: string;                      // MintGo's row id: `${tx}-${contract}-${n}`
  chain: MintChain;
  ts: number;                      // block timestamp, ms
  txHash: string;
  blockNumber: number;
  contract: {
    address: string;               // lowercase
    name: string;
    symbol?: string;
    image?: string;
    slug?: string;                 // OpenSea slug when known
    openSeaUrl?: string;
    projectUrl?: string;
    twitterUrl?: string;
    standard?: 'erc721' | 'erc1155' | string;
    deployer?: { address: string; createdAgo?: string; projects?: number };
  };
  quantity: number;
  tokenIds: string[];              // capped by MintGo; `tokenIdsTotal` when truncated
  tokenIdsTotal?: number;
  minter: string;
  valueEth?: number;               // what the tx paid
  unitPriceEth?: number;
  priceConfirmed: boolean;
  preview: boolean;                // realtime preview, price may change
  airdrop: boolean;
  thirdParty: boolean;             // minted through another contract
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
  chain: string;                   // OpenSea chain identifier
  floor?: { usd: number; unit: number; symbol: string };
  topOffer?: { usd: number; unit: number; symbol: string };
  volume: { usd: number; unit: number; symbol: string };   // for the key's timeframe
  sales: number;
  floorChange?: number;            // fraction, 0.2253 = +22.53%
  owners?: number;
  supply?: number;
  listed?: number;
  /** a SeaDrop stage open right now: the row gets a Mint button */
  minting?: { stageType: string; endTime?: string };
}

export type MintJobState = 'quoting' | 'ready' | 'sending' | 'pending' | 'confirmed' | 'failed';

export interface MintJob {
  id: string;
  ts: number;                      // created
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
  error?: string;                  // human sentence; the state is 'failed'
}

// Status gains:  mintgo?: 'disconnected' | 'connecting' | 'connected' | 'error'; error.mintgo?: string
// ServerEvent gains:
//   | { type: 'mint'; mint: MintEvent }
//   | { type: 'nftRankings'; key: RankingKey; rows: NftRanking[]; at: number }
//   | { type: 'mintJob'; job: MintJob }
// hello() gains: mints: MintEvent[]; rankings: Partial<Record<RankingKey, { rows; at }>>; mintJobs: MintJob[]
```

### ColumnDef additions

```ts
type: … | 'mints' | 'nftvol' | 'osmint';
/** nftvol */ ranking?: 'trending' | 'top'; timeframe?: '1h' | '1d';
/** mints: filters.chains?: MintChain[] (empty = all); filters.minQty?: number */
```

`parseColumn` accepts the three types, defaults `ranking: 'trending'`,
`timeframe: '1h'`, and keeps the `chains` filter to known chain names.

### Config additions

```ts
opensea: {
  walletKey?: string;                       // 0x + 64 hex, never sent to the UI
  rpc: Record<string, string>;              // chain identifier → RPC URL overrides
}
// masked(): opensea: { hasWallet: boolean; walletAddress?: string; rpc: Record<string,string>; chains: {id, name, defaultRpc}[] }
```

## Backend components

### MintGoClient (`mintgo.ts`)

Same shape as `J7Client`: an EventEmitter with `state`, `recent: MintEvent[]`,
`start()`, `stop()`.

- `session()`: `POST https://mintgo.fun/api/session` with the same-origin
  header set from the research doc; keeps `mg_access` + `mg_vid`; renews at
  `renewAfter`; a 401 anywhere renews once and retries.
- Socket: `wss://mintgo.fun/api/realtime?scope=all&client=<random>&since=<cursor>`
  with the cookie header. Frames may be binary: decode UTF-8, then JSON.
  `[0]` ignored; `[1, cursor, chain, contracts, rows]` → `decodeBatch()` →
  `upsert()` each event; `[2, cursor, chain, name, data]` → `ready` sets
  state connected, `heartbeat` runs the gap check (reconnect when the server's
  `latestMintSequences` for a chain is ahead of what we received by more than
  the batch we saw last), others ignored. Every frame updates the cursor.
- `decodeBatch(packet): MintEvent[]` is a pure function (tested) that mirrors
  MintGo's `expandCompactRealtimeBatch`: indices and flag bits exactly as in
  the research doc; unknown chain code → `ethereum`; rows without id or
  contract address dropped.
- `upsert(e)`: replace by id, else unshift; cap 300; emit `mint`.
- Reconnect: 250ms × 2^n, cap 5s; `stop()` closes and clears timers.
- Ring buffer only; nothing persisted.

### gql wrapper (`opensea/gql.ts`)

`gql<T>(operationName, query, variables, { referer?, cookie? , fetchImpl? })`
posts to `https://gql.opensea.io/graphql` with `x-app-id: os2-web`, origin,
referer, a browser user agent and `accept: application/json`. Rejects with
`OpenSeaError` codes: `rate_limited` (429), `auth_required` (401 or
`extensions.auth.error`), `http_<status>`, `graphql` (with the first
message), `compat` (unparseable body). Bodies over 2 MiB are refused.

### RankingsPoller (`opensea/rankings.ts`)

- `want(keys: RankingKey[])`: the set of keys columns currently need (derived
  from config columns on every columns save). Only wanted keys are polled.
- Every 60s per key (staggered 2s apart): `collectionRankings(slug,
  timeframe, limit: 50)` with the query from the research doc, normalized
  by `normalizeRankings(items, timeframe): NftRanking[]` (pure, tested):
  picks `stats.oneHour` or `stats.oneDay` for `volume/sales/floorChange`,
  keeps floor / top offer, rank = position, `minting` when a drop stage's
  `startTime <= now < endTime`.
- Emits `nftRankings` with the rows; keeps the last rows per key for
  `hello()` and `GET /nft/rankings?key=`. A failed poll keeps the old rows
  and logs once per key until it recovers.

### OpenSeaSession (`opensea/session.ts`)

One per wallet address. `ensure(chainId, slug)` signs in when there is no
session or the last call returned `auth_required`:

1. cookie `connected-account-server-hint=<address lowercase>`
2. `POST /__api/auth/siwe/nonce` → nonce (8–256 alphanumerics, else fail)
3. `buildSiweMessage({ address, uri: collection overview URL, chainId, nonce, issuedAt })` (pure, tested against osnm-z's exact text)
4. `account.signMessage` (viem) → `POST /__api/auth/siwe/verify` (body shape in the research doc)
5. `user.address` must equal the wallet, else `session_mismatch`

Keeps the cookie jar in memory; `gql()` calls go through it with the cookie.

### Drops (`opensea/drops.ts`)

- `resolveCollection(locator)`: a slug, an `opensea.io/collection/<slug>` URL,
  or a `0x` address (→ `collectionsByQuery`, matched on address, preferring
  the chain given). Returns `{ slug, name, image, address, chain, networkId,
  drop: { kind, address, stages[] } }`; `no_drop` when the collection is not
  a SeaDrop.
- `eligibility(session, slug, wallet)`: the `DropEligibilityQuery` POST
  (the persisted-query GET osnm-z tries first is skipped: the POST works).
- `mintAction(session, collection, wallet, quantity)`: the `swap(... MINT)`
  query; returns `{ actions, errors, tx? }`; error typenames mapped to
  sentences (`InsufficientFundError` → "the wallet can't cover price + gas").

### validate (`opensea/validate.ts`)

`validateMintTransaction(decoded, collection, wallet, stage, quantity,
chainId)`: exactly one `MintAction`, exactly one transaction, target not
zero, network id matches, calldata ≥ 4 bytes, and for `Erc721SeaDropV1` the
selector by stage type, nft contract, minterIfNotPayer, quantity and stage
index checks from osnm-z. Anything else → `unsafe_action` with the reason.
Tests use osnm-z's fixture builder (selector + ABI words).

### Minter (`opensea/minter.ts`)

Owns the viem `privateKeyToAccount`, one `publicClient` per chain (RPC from
config or `chains.ts` default) and the `MintJob` log (last 100, in memory,
in `hello()`).

- `quote({ locator, chain?, quantity })` → job in `ready` or `failed`:
  resolve collection → chain must have an RPC → session.ensure → eligibility
  → pick the stage: the one open now with `isEligible`; none → `failed`
  ("no open stage you're eligible for", with the next stage's start time
  when there is one) → quantity ≤ eligible max − already minted → price =
  `eligiblePrice.token.unit × quantity` in native wei → balance via RPC →
  fees via `estimateFeesPerGas`; gas limit 300000 (no `estimateGas`: the
  calldata is not fetched until send) → `balance ≥ total + limit × maxFee`
  else `failed` ("needs X, wallet has Y").
- `send(jobId)` (job must be `ready` and under 2 minutes old, else re-quote):
  `sending` → mintAction → validate → sign EIP-1559 (`chainId`, nonce from
  RPC, `maxFeePerGas/maxPriorityFeePerGas` fresh, gas 300000, `to/data/value`
  from OpenSea) → `sendRawTransaction` → `pending` with `txHash` → poll
  receipt 250ms → 2s for up to 3 minutes → `confirmed` with block and token
  ids from `Transfer(0x0 → wallet)` logs of the nft contract, or `failed`
  (reverted / timed out with the hash kept so the user can look it up).
  No same-nonce replacement in v1 (documented follow-up).
- Every state change emits `mintJob`. Errors never throw out of the API:
  they end in `failed` with a sentence.

### API (`api.ts`)

```
GET  /mints/recent                     → MintEvent[]
GET  /nft/rankings?key=TRENDING:ONE_HOUR → { rows, at } | 404 until first poll
GET  /osmint/jobs                      → MintJob[]
POST /osmint/quote  { locator, chain?, quantity }  → MintJob
POST /osmint/send   { jobId }          → MintJob (state 'sending'; updates by event)
PUT  /opensea/wallet { key }           → { address }   (validates 0x + 64 hex; '' clears)
PUT  /opensea/rpc    { chain, url }    → masked opensea block ('' resets to default)
```

Wallet key and RPC saves go through `cfg.update`; the Minter re-reads config
on every call so a new key needs no restart. `PUT /columns` recomputes the
rankings poller's wanted keys.

## Frontend components

### MintFeed (`MintFeed.tsx`)

Column body for `mints`. Props: `mints`, `now`, `status`, `filters`,
`onMint(e)`. Newest first, `VirtualItem` rows. Card: collection image (chain
badge), name (+ "preview" tag while `preview`), `×quantity`, price
(`unitPriceEth` and total, "free" when 0, "airdrop"/"3rd party" tags),
minter short address, `timeAgo`, supply `minted/max` when known. Click
toggles the expanded row: link icons (𝕏 · OpenSea · website · tx on the
chain's explorer), copy address chip, deployer line ("deployer 1y old, 8
projects"), and **Mint** (only when `contract.slug` is set) → `onMint`.
Filters: chain chips and min quantity, applied client side. Empty states:
"connecting to MintGo…", "MintGo unavailable: <error>", "waiting for the
first mint…".

### NftRankings (`NftRankings.tsx`)

Column body for `nftvol`. Props: `rows`, `at`, `timeframe`, `now`,
`onMint(row)`. A compact table: `#`, image + name (verified check) + chain
badge, floor (native + symbol), volume for the timeframe (native, USD under
it), sales, floor change (green/red %), and a **Mint** pill when
`minting`. Row click opens `https://opensea.io/collection/<slug>` in the
browser. Header `extra`: two buttons **1H** / **1D** (saved to the column's
`timeframe`) and "updated Ns ago". The subtitle reads "Trending · 1H".

### OsMintView (`OsMintView.tsx`)

Column body for `osmint`, styled like `CoveView`: a scrolling log of job
cards and a composer.

- Top strip: wallet address (or "add a wallet in ⚙ → Trading") and the
  balance of the chain of the current target.
- Composer: paste a slug / OpenSea URL / address, quantity stepper, **Quote**.
  A quote card shows collection image + name, chain, the stage ("Public ·
  ends in 2d 3h"), per-wallet limit and already minted, unit and total
  price, gas estimate, balance after, and a **Mint N for X ETH** button
  (disabled with the reason while `failed`). Pressing it calls `send`.
- Job cards then update in place: "⏳ Sending…", "🔵 Pending · tx ↗",
  "✓ Mint confirmed · #123, #124 · block N · ↗ OpenSea", "✗ Failed · reason".
  Card time shows `updated`.
- `onMint` from the other two columns lands here as a prefilled quote
  (`App.ensureMintPane()` creates the column when missing and flashes it,
  the way buy buttons do for Cove).

### ColumnEditor / Column / Settings

- Three new type cards: MintGo ("mints as they happen"), OpenSea Volume
  ("trending and top collections, 1H or 1D"), OpenSea Mint ("mint a drop with
  your wallet").
- `mints` options: chain chips (Ethereum / Robinhood / Ink), min quantity.
  `nftvol` options: Trending / Top, 1H / 1D. `osmint`: none.
- Settings → Trading gains **OpenSea wallet**: private key input (password
  field, shows only the derived address once saved, Remove button, a
  one-paragraph warning: dedicated wallet, funds at risk, stored in
  config.json) and an RPC table per chain with the default as placeholder.

### useFeed

Handles `mint` (upsert by id into `mints`, cap 300), `nftRankings` (map by
key), `mintJob` (upsert by id, newest last), and reads all three from
`hello`.

## Data flow

```
MintGo socket ─▶ MintGoClient.decodeBatch/upsert ─▶ hub 'mint' ─▶ /ws ─▶ useFeed.mints ─▶ MintFeed
gql.opensea.io ◀─ RankingsPoller (per wanted key, 60s) ─▶ hub 'nftRankings' ─▶ useFeed.rankings ─▶ NftRankings
OsMintView ─POST /osmint/quote─▶ Minter.quote ─▶ session/drops/RPC ─▶ 'mintJob'(ready|failed)
OsMintView ─POST /osmint/send──▶ Minter.send  ─▶ mintAction → validate → sign → RPC → receipt ─▶ 'mintJob' × n
```

## Error handling

- Feeds fail soft: state + one-line error in `Status`, column shows it,
  reconnect/poll keeps trying. No feed error can affect the chat feed.
- The Minter never leaves a job in `sending`/`pending` forever: a send that
  throws becomes `failed`; a receipt timeout becomes `failed` with the hash.
- Anything OpenSea returns that the validator does not recognise is refused
  before signing; the reason is on the card.
- Wallet key validation on save (length, hex, derives an address); the key
  never appears in logs, events or the masked config.

## Testing

Vitest, no network: `decodeBatch` (a real captured batch as fixture, flag
bits, unknown chain), `upsert` (preview → confirmed replaces), rankings
normalizer (1h vs 1d pick, `minting` window, missing floor), SIWE message
text byte-for-byte, verify-response mismatch, `validateMintTransaction`
(every rejection path with osnm-z's fixtures), Minter quote arithmetic and
state transitions with fake session/drops/RPC clients, `parseColumn` for the
new types. Manual: the three columns against live MintGo/OpenSea, and one
real mint on a cheap Robinhood Chain drop before release, after
`money-path-adversarial-review`.
