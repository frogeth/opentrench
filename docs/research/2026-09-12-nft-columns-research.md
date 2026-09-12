# Research: osnm-z, MintGo and OpenSea for the NFT columns

Date: 2026-09-12. Branch: `feat/opensea-mintgo-columns`.

The target screenshot asks for three things: a **MintGo feed** column (mints in
real time, click one for its X / OpenSea links), an **OpenSea volume feed**
column with 1H and 1D options, and an **OpenSea purchasing window** that looks
like the Cove pane (executed-order cards). Everything below was verified live on
2026-09-12 from Node with `curl` / `fetch`, not read off a docs page.

## 1. osnm-z (github.com/zunmax/osnm-z)

A Rust CLI that mints OpenSea-hosted **SeaDrop** collections. Single-wallet
mode, self-funded multi-wallet mode (10 wallets, concurrent) and a sponsored
EIP-7702 mode with its own executor contract. Only the single-wallet flow
matters for us; the multi-wallet and sponsored machinery is out of scope.

What it teaches, and what we copy:

| Step | How osnm-z does it (src/opensea.rs) | Verified from Node |
| --- | --- | --- |
| Endpoints | site `https://opensea.io`, GraphQL `https://gql.opensea.io/graphql`, header `x-app-id: os2-web`, `origin: https://opensea.io`, `referer: https://opensea.io/collection/<slug>/overview` | yes |
| Collection by slug | `collectionBySlug(slug)` → address, chain `{identifier networkId}`, `drop { __typename stages { stageType stageIndex startTime endTime maxTotalMintableByWallet } }` | yes, no auth |
| Address → slug | `collectionsByQuery(query: "0x…", limit: 50)`; pick the one whose address and chain match (an address can exist on several chains) | yes, no auth |
| Sign in | cookie `connected-account-server-hint=<addr lowercase>`; `POST /__api/auth/siwe/nonce` (JSON `{nonce}`); sign the SIWE text with `personal_sign`; `POST /__api/auth/siwe/verify` with `{message:{domain,address,statement,uri,version:"1",chainId,nonce,issuedAt,accountType:"Ethereum"},signature,chainArch:"EVM"}`; response `user.address` must equal the wallet; cookies `access_token`, `refresh_token`, `auth_hint`, `auth_access_hint`, `__cf_bm` | yes (throwaway key, chain 4663) |
| Eligibility | `dropBySlug(slug) { ... on Erc721SeaDropV1 { minterQuantityMinted(minter:$address) } stages { stageType stageIndex isEligible eligibleMinterAddress maxTotalMintableByWallet eligibleMaxTotalMintableByWallet eligiblePrice { usd token { unit symbol contractAddress chain { identifier } } } } }` — needs the session | yes (public stage `isEligible: true`) |
| Mint calldata | `swap(address, fromAssets:[{asset:{contractAddress: 0x0, chain}}], toAssets:[{asset:{contractAddress: drop, chain, tokenId:"0"}, quantity:"1"}], recipient:null, action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } }` | yes: the unfunded key got `errors:[{__typename:"InsufficientFundError"}]`, which is the funding check that runs before calldata is built |
| Validation before signing | exactly one `MintAction`, one transaction, `to != 0x0`, `chain.networkId == expected`, and for `Erc721SeaDropV1` decode the calldata: selector `0x161ac21f` (PUBLIC_SALE), `0x4b61cd6f` (SIGNED_PRESALE), `0x4300a4e6` (MERKLE_PRESALE); word 0 = nft contract, word 2 = minterIfNotPayer (0 or the wallet), word 3 = quantity, word 8 = stage index for presales | to port with unit tests |
| Send | EIP-1559 tx, gas limit 300000 default, automatic fees from the RPC, same-nonce replacement bump 112.5% after 20s pending, receipt polling 250ms → 2s | viem does all of this |
| Receipt | ERC-721 `Transfer(0x0 → wallet)` logs from the nft contract give the minted token ids | port |

Error codes OpenSea returns in `swap.errors[].__typename` that osnm-z maps:
`InsufficientFundError`, plus stage-not-open / ineligible / limit-exceeded
variants (see `classify_mint_action_errors`). Introspection is disabled on the
GraphQL endpoint; the rate limit header showed 400 requests per window.

Timing: osnm-z captures state at T-10s and fetches calldata at T-2s before a
stage opens, then retries "not ready" actions at 250ms up to 40 times. We do
not schedule mints in v1; the user presses Mint on an open stage.

## 2. MintGo (mintgo.fun)

Vanilla JS app (`/app.<hash>.js`, 627 KB, unminified). Chains: `ethereum`,
`robinhood`, `ink` (`stable` and `arc` exist in the decoder but are not
served). Everything is same-origin under `/api`, gated by a **browser
session cookie**, not by a wallet:

- `POST /api/session` body `{}` → `{ok, expiresAt, renewAfter}` and cookies
  `mg_access` (30 min, HttpOnly) + `mg_vid` (1 year). It refuses plain
  requests with `403 {"error":"Same-origin browser session required"}` but
  accepts a request carrying `origin: https://mintgo.fun`,
  `referer: https://mintgo.fun/`, `sec-fetch-site: same-origin`,
  `sec-fetch-mode: cors`, `sec-fetch-dest: empty` and a browser user agent.
  Renew before `renewAfter`; any 401 means renew and retry once.
- **Realtime**: `wss://mintgo.fun/api/realtime?scope=all|ethereum|robinhood|ink&client=<id>[&since=<cursor>]`
  with the cookie. Frames are JSON arrays, sometimes sent as binary (decode as
  UTF-8 first):
  - `[0, …]` keepalive, ignore.
  - `[2, <cursor>, <chainCode>, "<event>", <data>]` — events `ready`
    (`availableChains`, `chainConfigs` with chainId/rpc/explorer), `heartbeat`
    (`latestMintSequences` per chain; a gap vs. what we received means
    reconnect), `market` (patch of the runners tables), `trending`.
  - `[1, <cursor>, <chainCode>, <contracts[]>, <rows[]>]` — a **mint batch**.
    chainCode: 1/undefined ethereum, 2 robinhood, 3 stable, 4 ink, 5 arc.
    Each contract tuple: `[address, name, symbol, image, openSeaSlug, externalUrl, projectUrl, twitterUrl, deployerAddress, deployerCreatedAgo, deployerNftProjectCount, standard, openSeaUrlOverride?]`.
    Index 5 is the collection's own external URL (its website), not an OpenSea link; index 12 is the actual `openSeaUrl` override, present only when MintGo can't derive it. Otherwise the decoder builds `openSeaUrl` itself from `openSeaSlug`.
    Each row: `[id, txHash, blockNumber, timestampMs, contractIndex, tokenIds[], tokenCount, minter, transactionFrom, tokenImage, valueEth, flags, functionName, mintedSupply, maxSupply, unitPriceEth, unitPriceSource, streamId, streamRevision, streamAbsoluteCount, streamAbsoluteEventCount, tokenIdsTotal, …surge fields 22–29]`.
    flags bits: 1 priceConfirmed, 2 realtimePreview, 4 airdrop, 8 thirdPartyMint, 16 unitPriceConfirmed, 32 unitPriceEstimated, 64 tokenIdsTruncated, 128 mintSurge.
    The same `id` arrives more than once (preview, then confirmed with price): upsert by id.
  - Client → server control frames: `{"type":"watch-detail",chain,contractAddress}` / `{"type":"unwatch-detail"}` (not needed).
  - Reconnect backoff 250ms × 2^n capped at 5s; pass the last cursor as `since`.
  Observed on 2026-09-12: ~90 mint batches in 100 seconds on `scope=all`.
- **Snapshots** (GET with cookie, `?chain=` required): `/api/market-snapshot`
  (runners per window 1m…), `/api/runners-ranked?window=1h|15m|…&sort=mints|volume&limit=20`
  (rank, mint counts, volume, floor, `twitterUrl`, `projectUrl`, `openSeaSlug`),
  `/api/collection/<address>[?finance=1]` (supply, holders, floor, 1d volume,
  `twitterUrl`, `mintStages`, `mintAnalysis`, deployer history; 200 with
  `{error:"Collection not found"}` for collections it has not indexed),
  `/api/mint-analysis/<address>` (`mode: "SeaDrop"`, `ready`, `reason`
  (`ended`, `not_started`, `unsupported mint method`…), `unitPriceEth`,
  `maxPerWallet`, start/end), `/api/eth-gas`.
  There is no "recent mints" list endpoint: the feed is built from the socket.
- **Minting helpers** (not used in v1): `/api/mint-tx/<address>?quantity&from&allowPaid`
  returns a ready-to-sign transaction through MintGo's helper contract for
  collections its analysis marks `ready`; `/api/custody/*` is MintGo's own
  custodial wallet (challenge + `personal_sign` login, server-side signer).
  Both are a possible second execution route for non-SeaDrop mints later.

## 3. OpenSea rankings (the volume feed)

The stats page (`opensea.io/collections?timeframe=one_hour`) is server
rendered; its data comes from one GraphQL query that works **without any
auth** with `x-app-id: os2-web`:

```graphql
query CollectionRankingsQuery($slug: CollectionRankingSlug!, $timeframe: Timeframe!, $limit: Int!, $sort: TopCollectionsSort, $filter: TopCollectionsFilter, $category: CategoryIdentifier) {
  collectionRankings(slug: $slug, timeframe: $timeframe, limit: $limit, sort: $sort, filter: $filter, category: $category) {
    items { score collection { id slug name imageUrl isVerified chain { identifier }
      stats { oneHour { volume { usd native { unit symbol } } sales floorPriceChange }
              oneDay  { volume { usd native { unit symbol } } sales floorPriceChange }
              ownerCount totalSupply listedItemCount }
      floorPrice { pricePerItem { usd token { unit symbol } } }
      topOffer   { pricePerItem { usd token { unit symbol } } }
      drop { __typename stages { stageType startTime endTime } } } }
    nextPageCursor } }
```

- `slug`: `TRENDING` or `TOP` (enum, upper case). `timeframe`: `ONE_MINUTE`,
  `FIVE_MINUTE`, `FIFTEEN_MINUTE`, `THIRTY_MINUTE`, `ONE_HOUR`, `ONE_DAY`,
  `SEVEN_DAYS`, `THIRTY_DAYS`, `ONE_YEAR`, `ALL_TIME`. Page size on the site: 50.
- `stats` also has `oneMinute`, `fiveMinute`, `fifteenMinute`, `sevenDays`,
  `thirtyDays` rolling windows with the same shape, so every timeframe the
  site offers is one field away.
- Volumes come in USD and in the collection's native token (ETH, USDC, POL…):
  show both, never mix symbols across rows.
- Responses carry `cache-control: public, max-age=2` and
  `x-ratelimit-remaining` (399 seen): polling four keys once a minute is
  nothing.
- The public REST API (`api.opensea.io/api/v2`) needs an API key and has no
  hourly ranking, so it is not used.

## 4. What already exists in opentrench that this builds on

- Column system: `ColumnDef.type` union in `backend/src/config.ts`,
  `frontend/src/api.ts`; render switch in `App.tsx` (`renderColumn`); type
  cards and per-type options in `ColumnEditor.tsx`; icons in `Icon.tsx`.
- An external live stream client with reconnect, ring buffer and a `recent`
  REST route: `backend/src/j7.ts` + `J7View.tsx` (the template for MintGo).
- A bot-conversation pane with pressable cards and a composer:
  `CoveView.tsx` + `.bmsg/.bkey` CSS (the template for the purchasing window).
- The "one buy pane, created on demand and flashed" pattern: `ensureBuyPane`
  / `coveFlash` in `App.tsx`.
- Secrets live in `backend/config.json` (Telegram session, Discord token, o1
  key), masked to booleans for the UI by `ConfigStore.masked()`.
- The desktop app already whitelists mintgo.fun cookies for the Website
  column; the native column removes the need for the iframe.

## 5. Risks

- Both MintGo's `/api` and OpenSea's `gql.opensea.io` are private, unversioned
  web APIs (same class of dependency as J7Tracker and the Cove deep links).
  Decode defensively and fail soft: a column shows "feed unavailable", never
  a crash.
- The purchasing window signs with a **private key stored locally** and
  broadcasts irreversible transactions. Single dedicated wallet only, cost
  shown before every send, every calldata validated the osnm-z way, nothing
  scheduled or automatic. Run `money-path-adversarial-review` before release.
- MintGo's session check is header based; if they tighten it the feed dies
  until we adapt (the iframe Website column stays as the fallback).
