# TrenchTogether rooms — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friends anywhere share calls through *rooms* on a self-hostable *relay*, with end-to-end encryption, one-link joining, and docs/site/README/skill updated to match (spec: `docs/superpowers/specs/2026-09-17-together-rooms-design.md`).

**Architecture:** A new `relay/` workspace (Node 22 + `ws`, no DB) fans encrypted messages out per room and keeps a short encrypted buffer. The backend gets `backend/src/rooms/` (crypto, invite, RoomClient, manager) wired into `services.ts`, `config.ts`, `api.ts`; the frontend's Settings → Together is rebuilt around rooms with the LAN mode under a disclosure; Electron registers the `opentrench://` scheme. Docs, site, README, changelog and the setup skill describe rooms, hosting a relay, and the 0.11 features.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), `ws`, Node `crypto` (AES-256-GCM, SHA-256), vitest, React 18, plain HTML site.

**Conventions:** work in the `rooms` worktree (`/Users/moussaboussi/projects/trenchfeed-rooms`, branch `rooms`); run `npm install` there first. Never `pkill -f dist/index.js` (the user's own backend runs on 3210); scratch backends use another port with `TRENCHFEED_CONFIG`/`TRENCHFEED_STATE` in a temp dir. Tests before code. Commit after each task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The relay package

**Files:** create `relay/package.json`, `relay/tsconfig.json`, `relay/src/relay.ts` (pure core), `relay/src/index.ts` (process entry), `relay/src/relay.test.ts`, `relay/Dockerfile`, `relay/fly.toml`, `relay/README.md`; modify root `package.json` (`workspaces` += `"relay"`, scripts `relay`, `test` += relay), `electron/package.json` untouched (the relay is not packaged into the app).

- [ ] `relay/package.json`: `{ "name": "opentrench-relay", "version": "1.0.0", "private": true, "type": "module", "main": "dist/index.js", "scripts": { "build": "tsc", "start": "node dist/index.js", "dev": "tsx src/index.ts", "test": "vitest run" }, "dependencies": { "ws": "^8.18.0" }, "devDependencies": { "@types/ws": "^8.5.12", "typescript": "^5.6.0", "vitest": "^3.0.0", "tsx": "^4.19.0" }, "engines": { "node": ">=22" } }` (copy the versions the backend uses).
- [ ] `relay/src/relay.ts` exports `createRelay(opts: RelayOptions): Relay` where `Relay = { attach(server: http.Server): void; rooms(): number; close(): void }` and `RelayOptions = { accessCode?: string; maxRooms?: number (1000); maxMembers?: number (50); bufferMax?: number (2000); bufferHours?: number (24); idleDays?: number (7); dataDir?: string; maxMessageBytes?: number (65536); msgPerSec?: number (30); msgBurst?: number (60); helloPerMin?: number (10); now?: () => number; log?: (m: string) => void }`. Protocol exactly as the spec §2: first frame must be `hello` with `v === 1` (`v < 1` → `too-old`, `v > 1` → `too-new`), `room` = 22-char base64url, `member` = 22-char base64url, `access` matched with `timingSafeEqual` when configured; `welcome` carries members + buffer; `msg` fans out to others, appends `{from, body, ts}` to the room buffer (trim by count and age); `presence` on join/leave; per-member token bucket; per-IP hello limiter; `error` then close(4000+code) on any violation; `GET /` on the attached server answers the health JSON, `GET /v1` non-upgrade → 426. A room with no members is kept (with its buffer) until `idleDays` pass, then dropped. `dataDir`: write `<dataDir>/<roomId>.json` (buffer + lastSeen) debounced 2 s; load all files on start.
- [ ] `relay/src/index.ts`: reads env (`PORT`, `RELAY_ACCESS_CODE`, `RELAY_MAX_ROOMS`, `RELAY_MAX_MEMBERS`, `RELAY_DATA_DIR`, `RELAY_BUFFER_HOURS`), creates `http.createServer`, attaches, listens, logs `opentrench relay v1 listening on :PORT (rooms: n)`; SIGTERM closes.
- [ ] Tests (in-process, random port, real `ws` clients): hello/welcome; fan-out excludes sender; buffer replay for a late joiner in order; buffer trims by count and age; presence on join/leave; `too-old`/`too-new`; access code right/wrong/missing; room full; message too big; rate limit; hello limiter; health endpoint; persistence round trip through `dataDir` (write, new relay instance, buffer back).
- [ ] `Dockerfile` (node:22-alpine, `npm ci --omit=dev` after build stage, `EXPOSE 8080`, `VOLUME /data`, `ENV RELAY_DATA_DIR=/data`), `fly.toml` (app name placeholder `opentrench-relay`, `[http_service] internal_port = 8080, force_https = true`, `[[mounts]] source="relay_data" destination="/data"`, 256 MB). `relay/README.md`: one paragraph + the three hosting routes (same text as docs/relay.md, Task 9).
- [ ] Root `package.json`: add `relay` to workspaces; `"relay": "npm run build -w relay && npm start -w relay"`; `test` runs relay tests too.
- [ ] Commit: `Relay: rooms fan-out server with encrypted buffer (relay/)`.

### Task 2: Room crypto and invites

**Files:** create `backend/src/rooms/crypto.ts`, `backend/src/rooms/crypto.test.ts`.

- [ ] `newRoomKey(): string` (32 bytes base64url), `roomIdOf(key): string` (SHA-256, first 16 bytes, base64url = 22 chars), `newMemberId()`, `encodeInvite({relay, key}): string` → `opentrench://room/<relay-host[:port]>/<key>` (relay given as `wss://host[:port]`; `ws://` allowed only for localhost and written as `opentrench://room/ws:host:port/…`? No — keep it simple: the host part is `host[:port]`, and the app dials `wss://` unless the host is `localhost`/`127.0.0.1`, which dials `ws://`); `decodeInvite(s)` → `{ relay: 'wss://…', key, id }` or undefined; `seal(key, id, plaintextObj): string` (AES-256-GCM, 12-byte nonce, AAD = id, body = base64url(nonce‖ct‖tag)); `open(key, id, body): unknown | undefined` (undefined on any failure, never throws).
- [ ] Tests: round trip; tamper → undefined; wrong AAD → undefined; wrong key → undefined; invite encode/decode incl. ports and localhost → `ws://`; id length and determinism; two keys never share an id.
- [ ] Commit: `Rooms: keys, ids, invites and AES-GCM envelopes`.

### Task 3: RoomClient

**Files:** create `backend/src/rooms/client.ts`, `backend/src/rooms/client.test.ts`; modify `backend/package.json` (devDependency `"opentrench-relay": "*"` so tests can import `createRelay` from the workspace).

- [ ] `class RoomClient extends EventEmitter` with `constructor(opts: { relay: string; key: string; memberId: string; name: () => string; version: string; onToken: (peerName: string, token: TokenInfo) => void; log?; WebSocketImpl? })`. States: `'connecting' | 'connected' | 'disconnected' | 'key-mismatch' | 'relay-too-old' | 'access-denied' | 'full' | 'rate-limited'`. `start()`, `stop()`, `reconnect()`, `send(plain: object)` (seal + `msg`), `members: number`, `lastError?: string`, `state`. Backoff 2 s → 15 s, `relay-too-old`/`access-denied`/`full` retry every 60 s. On `welcome`: replay `buffer` (open each; count failures; three consecutive failures → `key-mismatch`), send `{k:'hello', name, v}`; on `msg`: open → `hello` (remember `from`→name) | `token` (→ `onToken(name, token)`) | `bye`. Emits `'state'` and `'members'`.
- [ ] Tests against an in-process relay: connect + hello + welcome; a second client's token message reaches the first with the sender's name; buffer replay on join; wrong key → `key-mismatch`; relay `too-old` → state; access code; reconnect after the relay closes the socket; `stop()` sends `bye`.
- [ ] Commit: `Rooms: RoomClient (connect, replay, send, reconnect)`.

### Task 4: Config

**Files:** modify `backend/src/config.ts`, `backend/src/config.test.ts`.

- [ ] `Config.together` gains `rooms: { id: string; key: string; relay: string; name: string; joinedAt: number }[]`, `memberId: string` (generated on first load when missing), `relay: string` (`''` = default). Room keys are sealed on disk: extend `SecretPath` with a template `` `together.rooms.${string}` `` and seal/open each room's `key` keyed by its `id` (a locked key keeps its ciphertext, and that room is skipped at runtime with a warning). `masked()` returns rooms without keys: `{ id, relay, name, joinedAt }` plus `memberId` and `relay`.
- [ ] Tests: load/save round trip with sealing; old config without rooms; masked hides keys; a room whose key cannot be opened is kept on disk and absent from `get().together.rooms` (or present with `key: undefined` — pick one and test it).
- [ ] Commit: `Config: together.rooms with sealed keys, memberId, preferred relay`.

### Task 5: Rooms manager in Services

**Files:** create `backend/src/rooms/manager.ts` (+ test), modify `backend/src/services.ts`, `backend/src/types.ts` (`Status.together.rooms`), `backend/src/hub.ts` (nothing new if `applyRemoteToken` suffices).

- [ ] `DEFAULT_RELAY = 'wss://relay.opentrench.app'` exported from `backend/src/rooms/manager.ts`.
- [ ] `class RoomsManager`: `sync()` starts/stops a RoomClient per configured room; `status()` → `{ id, name, relay, state, members, error }[]`; `create(name, relay?)` → generates key, updates config, syncs, returns the invite; `join(invite, name?)`; `leave(id)`; `rotate(id)` (new key + id, same name/relay); `invite(id)`. Outbound: subscribe to `hub.on('event')` for `type: 'token'` where the token has at least one call from this machine's own chats (no `via`) and a call newer than the last sent for that token; throttle one send per token per 30 s per room; on each room's `connected` state send the last 24 h of own-called tokens, newest first, ≤ 200. Inbound: `hub.applyRemoteToken(name, token)`. `remoteLive` unchanged (room tokens are not in it).
- [ ] `Status.together.rooms` added (backend + `frontend/src/types.ts`); `togetherStatus()` includes it; `syncTogether()` calls `rooms.sync()`.
- [ ] Tests (manager with a fake hub + in-process relay): create → invite decodes to the same relay/key; two managers in one room exchange a call; a `via` token is not re-sent; throttle; rotate changes id and invite; leave stops the client; join with a bad invite throws a readable error.
- [ ] Commit: `Rooms: manager wired into services and status`.

### Task 6: Routes and frontend API

**Files:** modify `backend/src/api.ts` (+ `backend/src/api.together.test.ts` if one exists, else add cases to the closest suite), `frontend/src/api.ts`, `frontend/src/types.ts`.

- [ ] Routes (mutations require `x-requested-with: opentrench`, like the market routes): `GET /together` gains `rooms: { id, name, relay, joinedAt, invite }[]`, `memberId`, `relay`, `defaultRelay`; `POST /together/rooms { name, relay? }` → the room (with invite); `POST /together/rooms/join { invite, name? }`; `DELETE /together/rooms/:id`; `POST /together/rooms/:id/rotate` → new invite; `PUT /together/relay { relay }` (validates `wss://` or localhost `ws://`); `GET /together/relay/probe?url=` → `{ ok, v?, rooms?, error? }` (HTTP GET on the relay's `/` with a 4 s timeout; refuse private/loopback hosts except localhost).
- [ ] Frontend `api.ts`: `createRoom`, `joinRoom`, `leaveRoom`, `rotateRoom`, `setRelay`, `probeRelay`; `TogetherInfo` gains the new fields.
- [ ] Tests for validation (bad invite, bad relay URL, header guard) and the probe against an in-process relay.
- [ ] Commit: `Rooms: routes and client API`.

### Task 7: Settings → Together UI

**Files:** modify `frontend/src/components/Settings.tsx` (`TogetherSection`), `frontend/src/index.css`; add `frontend/src/components/Settings.together.test.tsx`.

- [ ] Layout per spec §5: **Rooms** first (blurb; room cards with name, relay host, status dot + text, "N online", Copy invite / Rotate (confirm) / Leave (confirm)); **Create a room** (name input, relay input prefilled with `defaultRelay` or the saved preference, a *What's a relay?* disclosure with the exact copy from the spec and a link to `DOCS.relay`, a "Check" button that calls `probeRelay` and shows "relay v1 · N rooms" or the error, Create button); **Join a room** (invite input, optional display name, Join); then **Same Wi-Fi instead** disclosure (`<details>`) holding the existing nearby/requests/following/pair-by-link UI unchanged. States map to plain words: `connected` → "connected", `connecting` → "connecting…", `disconnected` → "offline · retrying", `key-mismatch` → "invite changed — ask for the new one", `relay-too-old` → "this relay needs updating", `access-denied` → "relay wants an access code", `full` → "room is full". Add `relay` and `together` to `DOCS` in `frontend/src/site.ts` (`${SITE_URL}/docs/together/`, `${SITE_URL}/docs/together/#relay`).
- [ ] CSS: `.room-card` grid (name, meta, actions), reuse `.choice`/`.acct-card` look; the disclosure uses the existing `.hdr-toggle`.
- [ ] Tests (vitest + jsdom): renders rooms from `api.together()`; Create calls `createRoom` with the relay field; Join calls `joinRoom`; the state words above.
- [ ] Commit: `Settings: rooms first, same-network under a disclosure`.

### Task 8: Deep link

**Files:** modify `electron/main.js`, `electron/preload.js`, `frontend/src/desktop.ts`, `frontend/src/App.tsx`.

- [ ] `app.setAsDefaultProtocolClient('opentrench')` (dev: with `process.execPath` + script path); single-instance lock; macOS `open-url`; Windows/Linux `second-instance` argv scan for `opentrench://`; store the last link until the window is ready; `ipcMain.handle('link:pending')` and `win.webContents.send('link', url)`. Preload exposes `desktop.onLink(cb)` and `desktop.pendingLink()`.
- [ ] Frontend: on a `opentrench://room/...` link, open Settings on the Together tab with the invite prefilled in Join (App holds `settingsOpen` + a `pendingInvite` prop; `TogetherSection` accepts `initialInvite`). Pasting an invite anywhere in Join still works.
- [ ] Tests: `decodeInvite` already covered; add a frontend test that `TogetherSection` with `initialInvite` shows it in the Join field.
- [ ] Commit: `Desktop: opentrench:// links open Settings → Together with the invite`.

### Task 9: Docs and README

**Files:** create `docs/together.md`, `docs/relay.md`; modify `docs/getting-started.md`, `README.md`, `CHANGELOG.md`.

- [ ] `docs/together.md`: what a room is, create/share/join, what travels (calls only; priced locally), rotate/leave, same-network mode, the one-sentence trust note (the relay operator sees your IP and traffic volume, never a call), troubleshooting (state words → what to do).
- [ ] `docs/relay.md`: what a relay does, the three hosting routes in full (Fly with the shipped `fly.toml`; Docker; any Node host behind Caddy — a 5-line Caddyfile), env vars table, the access code, updating, "the invite carries your relay's address: friends configure nothing".
- [ ] `docs/getting-started.md`: new step `## 7. Share calls with friends` (rooms in three sentences + link), renumber nothing else.
- [ ] `README.md`: rewrite the TrenchTogether paragraph under "What the feed does" (rooms + same network), add **Live prices from the pool** (already there) a line about Alchemy + the on-chain first sight, add a **Host a relay** line under Install or a new short section linking `docs/relay.md`; refresh the Screenshots section to reference `docs/img/settings.png` and `docs/img/together.png` (images added in Task 12).
- [ ] `CHANGELOG.md` Unreleased: rooms, relay package, deep links, docs.
- [ ] Commit: `Docs: rooms, hosting a relay, README and changelog`.

### Task 10: Site

**Files:** create `site/docs/together/index.html`; modify `site/docs/index.html` (nav: `7 · Share with friends` + `Host a relay`), `site/index.html` (a feature block "Your calls, your friends, anywhere." with `img/together.png`, and a line in the "No token" block? no — keep to one block), `site/style.css` only if a new element needs it.

- [ ] Same structure and classes as `site/docs/index.html` (nav, `article`, numbered `h2`s, `.aside`, footer). Content = `docs/together.md` + `docs/relay.md` in the site's voice. Anchors `#rooms`, `#join`, `#relay`, `#hosting`, `#trust`.
- [ ] Commit: `Site: rooms and relay docs, feature block`.

### Task 11: The setup skill

**Files:** modify `skills/opentrench-setup/SKILL.md`.

- [ ] Update the description line (add rooms/relay/live prices to the triggers). New sections: `## 5. Share calls with friends (rooms)` (create, copy invite, join, what the state words mean, rotate), `## 6. Live prices and your Alchemy key` (Settings → Market data, what the green dot means, why some tokens have no dot, custom RPC beats Alchemy beats public), `## Host a relay` (the three commands, env vars, the access code), and failure modes for each ("could not reach relay", "invite changed", "this relay needs updating", "0 live · N skipped: paired with X, which is not priced"). Remove the user-token fallback sentence in §2 (the UI no longer has it).
- [ ] Commit: `Skill: rooms, relay hosting, live prices`.

### Task 12: Screenshots

**Files:** replace `site/img/terminal.png`, `site/img/drilldown.png`, `docs/img/terminal.png`, `docs/img/drilldown.png`; add `site/img/settings.png`, `site/img/together.png`, `docs/img/settings.png`, `docs/img/together.png`.

- [ ] Taken from the real app at 1440×900 (the desktop app or the in-app browser resized), dark theme, with a room card showing "connected · 2 online" (use a scratch relay on localhost with two scratch backends). Crop nothing sensitive (no phone numbers, no keys). Same frame for site and docs copies.
- [ ] Commit: `Screenshots for 0.12: terminal, drill-down, settings, together`.

### Task 13: Final review, PR

- [ ] Full test run in all four workspaces, `npm run typecheck`, a scratch end-to-end: relay on :8090, two backends on :3310/:3320 with their own configs, create a room on one, join on the other, post a call in one (inject via the hub test hook or a plugin post), see it `via` on the other.
- [ ] Open a PR `rooms` → `main` with the spec summary; do **not** deploy the relay.
