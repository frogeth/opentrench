# trenchfeed — design

Date: 2026-09-08

## Goal

A local web app that shows messages from selected Discord channels and Telegram
chats in one live feed, with contract addresses highlighted and copyable.
Everything runs on the user's machine. Nothing is sent anywhere except to
Discord and Telegram themselves.

Reference for the shape of the problem: trenchcord. No code is shared with it
(its license forbids derivatives).

## Non-goals (v1)

Rooms, user highlighting, notifications, chart links, contract sidebar,
trading, message persistence across restarts, media rendering (attachments
show as a marker only), editing/deleting, sending messages.

## Constraints

- Discord uses the user's **own account token** (self-bot). This violates
  Discord ToS; the user has accepted that risk. The client must mimic the
  official web client's identify properties to reduce ban risk.
- Telegram uses the user's **own account** via MTProto (gramjs). This is
  permitted by Telegram.
- Server binds to `127.0.0.1` only.
- Config (tokens, sessions, watched channels) lives in one local JSON file,
  git-ignored.

## Architecture

```
backend/                     Node 22 + TypeScript (ESM)
  src/
    index.ts                 boot: load config, start hub, http+ws server
    config.ts                load/save config.json, typed
    hub.ts                   MessageHub: normalize, detect, buffer, broadcast
    contracts.ts             detectContracts(text) -> Contract[]
    types.ts                 FeedMessage, Contract, Status, wire protocol
    discord/
      gateway.ts             DiscordGateway: raw WS, heartbeat, resume, reconnect
      normalize.ts           MESSAGE_CREATE payload -> FeedMessage
      rest.ts                fetch guild/channel list (uses READY payload)
    telegram/
      client.ts              TelegramClient wrapper: login, list dialogs, events
      normalize.ts           gramjs message -> FeedMessage
    api.ts                   HTTP routes (setup, channel lists, watch list)
    ws.ts                    WebSocket server: replay buffer + live push
frontend/                    Vite + React + TypeScript
  src/
    App.tsx                  header (status), settings drawer, feed
    api.ts                   fetch helpers
    useFeed.ts               WS client, buffer, reconnect
    components/
      Feed.tsx               list, filter box, contracts-only toggle, autoscroll
      MessageRow.tsx         badge, chat, author, text, contract chips
      ContractChip.tsx       shortened addr, click-to-copy
      Settings.tsx           Discord token, Telegram login wizard, channel picker
```

## Data model

```ts
type Source = 'discord' | 'telegram';

interface Contract {
  chain: 'sol' | 'evm';
  address: string;
}

interface FeedMessage {
  id: string;            // `${source}:${platformMessageId}`
  source: Source;
  chatId: string;        // discord channel id / telegram peer id
  chatName: string;      // "#alpha-calls (Server)" / "Group Name"
  author: string;
  text: string;
  ts: number;            // epoch ms
  contracts: Contract[];
  link?: string;         // discord jump link / t.me link when available
  hasAttachment: boolean;
}

interface Status {
  discord: 'disconnected' | 'connecting' | 'connected' | 'auth_error';
  telegram: 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'auth_error';
  error?: { discord?: string; telegram?: string };
}
```

### Config file (`backend/config.json`)

```json
{
  "discord": { "token": "...", "watch": ["channelId", ...] },
  "telegram": { "apiId": 123, "apiHash": "...", "session": "...", "watch": ["peerId", ...] }
}
```

## Backend components

### DiscordGateway

- Connects to `wss://gateway.discord.gg/?v=9&encoding=json`.
- Identify with the user token and browser-like `properties`
  (os, browser, release_channel, client_build_number, etc.), `capabilities`
  set like the web client. No intents (user accounts don't use them).
- Handles HELLO → heartbeat interval; sends HEARTBEAT, tracks ACK; on missed
  ACK, closes and reconnects.
- On READY: stores `session_id`, `resume_gateway_url`, and extracts guilds
  and their text channels (id, name, guild name) for the picker.
- On MESSAGE_CREATE: if `channel_id` is in the watch list, emits the raw
  payload to the hub.
- Reconnect: on close, RESUME if we have a session, else re-IDENTIFY, with
  exponential backoff (1s → 60s). Close codes 4004 (auth failed) and
  4014 are fatal → emit `auth_error`, stop.
- Unit-testable: takes a WebSocket factory so tests can inject a fake.

### TelegramClient wrapper

- gramjs `TelegramClient` with `StringSession`.
- Login wizard exposed as three API calls: `start(phone)`,
  `code(code)`, `password(pw)`. Saves the session string on success.
- `listDialogs()` → groups, supergroups, channels (id, title, type).
- Subscribes to `NewMessage`; if the peer id is in the watch list, emits to hub.
- Reconnect handled by gramjs; a health probe every 30s (`getMe`) restarts
  the client if it fails. Fatal auth errors (AUTH_KEY_UNREGISTERED,
  SESSION_REVOKED, …) → `needs_login`.

### MessageHub

- `push(msg: FeedMessage)`: run `detectContracts`, append to a ring buffer
  (500), broadcast `{type:'message', msg}` to all WS clients.
- `setStatus(source, status)`: broadcast `{type:'status', status}`.
- On WS connect: send `{type:'hello', status, messages: buffer}`.

### detectContracts

- EVM: `/0x[a-fA-F0-9]{40}/g`.
- Solana: `/[1-9A-HJ-NP-Za-km-z]{32,44}/g` then verify it base58-decodes
  to exactly 32 bytes. Exclude matches that are substrings of a longer
  base58 run or part of a URL path we know isn't a CA (keep it simple:
  just the decode check in v1).
- Dedupe by address within a message; preserve first-seen order.

### HTTP API (Express, localhost only)

```
GET  /api/status
GET  /api/config                  -> tokens masked, watch lists
PUT  /api/discord/token           {token}
GET  /api/discord/channels        -> [{id, name, guildName}]
PUT  /api/discord/watch           {ids: string[]}
PUT  /api/telegram/credentials    {apiId, apiHash}
POST /api/telegram/login/start    {phone}
POST /api/telegram/login/code     {code}
POST /api/telegram/login/password {password}
POST /api/telegram/logout
GET  /api/telegram/dialogs        -> [{id, title, type}]
PUT  /api/telegram/watch          {ids: string[]}
WS   /ws
```

Any PUT that changes a token restarts that client. Watch-list changes take
effect immediately (in-memory set).

## Frontend

- Header: app name, two status pills (Discord / Telegram) with color, gear
  button opens Settings.
- Settings drawer: Discord section (token input, save, channel list with
  checkboxes and a search box). Telegram section (api id/hash, then
  phone → code → password wizard, then dialog list with checkboxes).
- Feed: newest at bottom, auto-scroll unless the user scrolled up (show a
  "jump to latest" button then). Filter input matches chat, author, text.
  "Contracts only" toggle. Each row: source badge, chat name, author, time,
  text, contract chips, "📎" marker if attachment.
- ContractChip: `Ab12…xyz9` with chain tag; click copies full address and
  flashes "copied".
- WS client reconnects with backoff; on `hello` replaces the buffer.

## Error handling

- Auth failures show a red banner with the platform and reason; the
  settings drawer opens on click.
- Transient disconnects show the pill as "connecting" and log to console.
- Backend never crashes on a malformed payload: normalizers wrap in
  try/catch and drop the message with a warn log.

## Testing

- `contracts.test.ts`: EVM, Solana, mixed, dedupe, false positives
  (a 40-char base58 that doesn't decode to 32 bytes, tx signatures which
  are 64 bytes).
- `discord/normalize.test.ts`, `telegram/normalize.test.ts`: fixture
  payloads → FeedMessage.
- `discord/gateway.test.ts`: fake WS; HELLO → heartbeat sent; ACK tracking;
  missed ACK → reconnect; READY → channels extracted; MESSAGE_CREATE on
  unwatched channel ignored; 4004 → auth_error and no reconnect.
- `hub.test.ts`: ring buffer cap, broadcast, hello replay.
- Test runner: vitest. Frontend gets a smoke test only in v1.
- Manual: real accounts end-to-end.

## Tooling

- npm workspaces: `backend`, `frontend`.
- `npm run dev` runs both (backend on 3210 with tsx watch, Vite on 5173
  proxying `/api` and `/ws`).
- `npm run build && npm start` serves the built frontend from the backend.

---

# Addendum 2026-09-08 (evening): v1.1 — feed order, avatars, bots, tokens

Approved by the user after v1 ran against real accounts.

## Changes

1. **Newest on top.** Feed renders newest first, pinned to the top unless the
   user scrolls down (then a "↑ latest" button).
2. **Avatars.** Discord: CDN URL built from the gateway payload (guild avatar
   > user avatar > default). Telegram: backend downloads the sender's profile
   photo through the session on demand (`GET /api/telegram/avatar/:id`), caches
   it in memory (cap 500), serves it locally.
3. **Bot messages hidden but parsed.** `FeedMessage.isBot` set from Discord
   `author.bot` / Telegram `sender.bot`. Frontend hides bot rows by default
   ("show bots" toggle). The hub still reads them for token metadata.
4. **First-time contracts + call counter.** The hub keeps a `TokenInfo` map
   keyed by address. First mention: `seen=1`, message shown. Later mentions:
   `seen++`, message flagged `repeat=true` and hidden by default ("show
   repeats" toggle). Every token change is broadcast as a `token` event; the
   card shows "called Nx".
5. **Token metadata from Rick + Dexscreener.** Links are extracted from every
   message that carries a contract: Discord markdown `[label](url)` and
   Telegram `MessageEntityTextUrl` entities. Classified by domain:
   x.com/twitter.com → twitter; plain t.me/<name> (no `?start=`, not a bot) →
   telegram; everything not on the aggregator/explorer/bot list → website.
   Rick's header line gives name + symbol. Dexscreener
   (`api.dexscreener.com/latest/dex/tokens/{addr}`, best pair by liquidity)
   fills price, market cap, liquidity, 24h change, image, chart URL, and
   socials only where Rick had none. Fetched once per address; failures leave
   the card bare.
6. **Logos.** Discord and Telegram inline SVG replace the DC/TG badges.

## New/changed types

```ts
interface FeedMessage { ...; avatar?: string; isBot: boolean; repeat: boolean }
interface TokenInfo {
  chain: 'sol' | 'evm'; address: string; seen: number; firstSeenTs: number;
  name?: string; symbol?: string; priceUsd?: number; marketCap?: number;
  liquidity?: number; change24h?: number; imageUrl?: string; chartUrl?: string;
  website?: string; twitter?: string; telegram?: string;
}
type ServerEvent = ... | { type: 'token'; token: TokenInfo }
hello adds `tokens: TokenInfo[]`
```

## New files

```
backend/src/links.ts            extractLinks(text, entityLinks) -> {website?, twitter?, telegram?, name?, symbol?}
backend/src/dexscreener.ts      fetchToken(address) -> Partial<TokenInfo>
frontend/src/components/TokenCard.tsx, Logo.tsx, Avatar.tsx
```
