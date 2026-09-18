# TrenchTogether rooms — design

**Goal.** Friends anywhere in the world share their calls with each other, with nothing to port-forward, no IP handed out, and a join flow that is one link. Anyone can host the server side from the open-source repo; the app never depends on a relay it does not have the URL for.

**One sentence for users.** A *room* is a private channel for calls. It lives on a *relay*: a small server that passes messages between the room's members and cannot read them, because every message is encrypted on your machine with a key only the invite carries.

## 1. Shape

```
 friend A ──wss──►┐                  ┌◄──wss── friend B
                  │   relay (dumb)   │
 friend C ──wss──►┘  room = fan-out  └◄──wss── friend D
```

- Every app opens **one outbound websocket per room** to the room's relay. Nothing listens on the internet. The relay sees members' IPs and ciphertext; members never see each other's IPs.
- **Invite** = `opentrench://room/<relay-host>/<key>` where `key` is 32 random bytes, base64url. The room id is `SHA-256(key)` truncated to 16 bytes, base64url; the relay only ever learns the id. The key is what the invite is *for*: whoever has it is in.
- **The relay is a package in the repo** (`relay/`), plain Node 22 + `ws`, no database, one process. It runs on Fly, a VPS, a Docker one-liner, a Raspberry Pi. No provider-specific primitives, so no lock-in. There is **no official or default relay**: the app never prefills a relay address, and the protocol has no notion of one.
- The existing **same-network** mode (UDP beacons, port 3211, pairing codes) stays as it is, for people who want nothing leaving the house. Rooms sit beside it, not on top of it.

## 2. Relay protocol (v1)

WebSocket at `wss://<host>/v1`. JSON text frames. All bodies the relay carries are opaque base64url ciphertext.

Client → relay:
- `{"t":"hello","v":1,"room":"<id>","member":"<memberId>","access":"<code>"?}` — first frame. `v` is the protocol version; `member` is a random 16-byte id the app generates once per install (not a secret; names live inside ciphertext).
- `{"t":"msg","body":"<ciphertext>"}` — fan out to every other member and append to the room buffer.

Relay → client:
- `{"t":"welcome","v":1,"members":["<memberId>",…],"buffer":[{"from","body","ts"},…]}` — on a good hello: who is here, and the room's recent history (see buffer).
- `{"t":"msg","from":"<memberId>","body":"<ciphertext>","ts":<ms>}`
- `{"t":"presence","members":["<memberId>",…]}` — whenever someone joins or leaves.
- `{"t":"error","code":"too-old"|"too-new"|"access"|"full"|"rate"|"bad"}` then close. `too-old` means *the relay* is older than the app's protocol; the app shows "this relay needs updating".

Limits (env-tunable, sensible defaults): message ≤ 64 KB; 30 messages/s per member (burst 60); ≤ 50 members per room; ≤ 1000 rooms per relay; room buffer = last 2000 messages **or** 24 h, whichever is smaller; a room with no member for 7 days is dropped; `hello` ≤ 10/min per IP. `GET /` answers `{"name":"opentrench-relay","v":1,"rooms":<n>}` for health checks and for the app's "is this a relay?" probe before joining.

Buffer persistence: in memory, plus an optional JSON file per room under `RELAY_DATA_DIR` written on change (debounced) so a relay restart keeps the last day of calls. Ciphertext only.

Environment: `PORT` (8080), `RELAY_ACCESS_CODE` (optional; hello must carry it — for a relay you want private to your circle; the app stores it per room, entered when creating or joining, or later on the room card when the relay says `access`), `RELAY_MAX_ROOMS`, `RELAY_MAX_MEMBERS`, `RELAY_DATA_DIR`, `RELAY_BUFFER_HOURS`, `RELAY_TRUST_PROXY` (off by default; on, the client IP comes from `fly-client-ip` or the last `x-forwarded-for` entry — only behind a proxy that sets them). The hello limiter is a strict rolling minute per IP; a socket that never sends hello is closed after 10 s; a frame over twice the message cap is refused by the socket layer.

## 3. Encryption

- Key: the 32 bytes from the invite. AES-256-GCM, 12-byte random nonce per message, AAD = room id. Wire body = base64url(nonce ‖ ciphertext ‖ tag).
- Plaintext is JSON: `{"k":"hello","name":"<display name>","v":"<app version>"}` on join; `{"k":"token","name":"<display name>","token":<shareable TokenInfo>}` for a call; `{"k":"bye"}` on leave. `shareable()` is the same projection the LAN mode uses (no `via` chain, no chat text).
- A message that does not decrypt is dropped and counted **per sender**: three from one member id mutes that sender for the connection. It never changes the room's state or closes the socket, because anyone who learns a room id can join the relay and send garbage, and a client that derived the id from its key can never legitimately hold the wrong key. Settings shows "N messages from M members did not decrypt" only when a replay yielded nothing readable from two or more senders.
- Rotating a room = a new key = a new room id = a new invite. Everyone re-joins with it. There is no revocation short of that, and the UI says so ("Rotate: makes a new invite; anyone with the old one is out").
- Room keys are secrets: sealed on disk like the other secrets in config.json.

## 4. What travels

Only calls. Each app now prices whatever is on its screen from the chain every 3 s, so streaming market numbers between friends over the internet is waste. Per room a member sends:
- on join: its called tokens of the last 24 h, one `token` message each, newest first, capped at 200;
- afterwards: a `token` message whenever one of **its own** chats adds a call to a token (not calls that arrived `via` someone else — no re-broadcast loops), at most one message per token per 30 s.

Receiving: `hub.applyRemoteToken(name, token)` exactly as the LAN guest does. The hub's `remoteLive` set stays empty for room peers: room tokens are priced locally like any other. Replayed buffer messages are applied in order on join; duplicates are already ignored by message id.

## 5. App side

Backend `backend/src/rooms.ts`:
- `RoomClient`: one per configured room. Connects (2 s → 15 s backoff, like `TogetherGuest`), sends `hello`, handles `welcome` (members, buffer replay), `msg`, `presence`, `error`. Exposes state `connecting | connected | disconnected | key mismatch | relay too old | access denied | full`, member count, last error.
- `Rooms` manager in `services.ts`: starts a client per room in config, stops on removal, feeds outbound calls from the hub, reports status through `Status.together.rooms`.
- Config: `together.rooms: { id, key, relay, name, joinedAt, access? }[]`, `together.memberId`, `together.relay` (the last relay the user typed, shown again next time; empty on first use). Keys sealed; relay URLs canonical (the invite rule).
- Routes: `GET /together` gains `rooms` (with each room's invite); `POST /together/rooms {name, relay?}` creates (generates key, joins); `POST /together/rooms/join {invite, name?}`; `DELETE /together/rooms/:id`; `POST /together/rooms/:id/rotate`; `GET /together/relay/probe?url=` answers `{ok, v, rooms}` for the UI's "check". Mutations need the app header.
- No default relay (decision by the owner, 2026-09-17): there is no official or default relay, ever. No `DEFAULT_RELAY` constant; the app never prefills a relay address. The relay field is empty (placeholder `wss://your-relay.example`) and only remembers the last relay the user typed. To start a room you need a relay address: host your own (docs/relay.md, one command) or use a friend's. Whoever creates the room picks the relay; the invite carries its address, so people who join configure nothing.

Frontend, Settings → Together, top to bottom:
1. **Rooms** — the page's main thing. Blurb: *"A room is a private channel for your calls. Friends join with one link, from anywhere."* Then one card per room: name, relay host, a status dot, "3 members online", buttons **Copy invite**, **Rotate**, **Leave**. Below: **Create a room** (name; relay field empty, placeholder `wss://your-relay.example`, remembering the last relay typed, with a one-line *"What's a relay?"* disclosure: *"The server the room lives on. It passes messages between members and can't read them: everything is encrypted on your machine with a key only the invite carries. Host your own, it's one command, or use a friend's."* with a docs link) and **Join a room** (paste an invite; Join).
2. **Same network** — the existing nearby / requests / following / pair-by-link UI, under a collapsed disclosure *"Same Wi-Fi instead (no relay, nothing leaves the network)"*.
3. Feed: a room peer's calls show `via <name>` as today.

Deep link: the desktop app registers the `opentrench` URL scheme (macOS `open-url`, Windows/Linux second-instance argv). An `opentrench://room/…` link opens Settings → Together with the invite filled in and focus on Join. Pasting still works everywhere.

## 6. Hosting a relay (docs)

`docs/relay.md` and the site page: three routes, each complete —
- **Fly.io**: `cd relay && fly launch --copy-config --yes && fly deploy` with the shipped `fly.toml` (256 MB, one region, a volume for `RELAY_DATA_DIR`).
- **Docker**: `docker build -t opentrench-relay ./relay && docker run -d -p 8080:8080 -v relay-data:/data opentrench-relay` (no published image yet).
- **Any Node host**: `npm ci --workspace relay && PORT=8080 node relay/dist/index.js` behind any TLS proxy (Caddy one-liner shown).
Plus: what the relay operator can and cannot see (IPs and traffic volume: yes; calls, names, tokens: no), the access code, and "your invite tells your friends which relay you used; nothing else to configure on their side".

## 7. Everywhere this is documented

- `README.md`: TrenchTogether section rewritten (rooms + same network), Market data section (live on-chain prices, Alchemy), Settings screenshot refreshed, feature list updated for 0.11.
- `docs/together.md` (rooms, joining, rotating, what travels), `docs/relay.md` (hosting), `docs/getting-started.md` step "7 · Share with friends".
- Site: `site/docs/together/index.html` (rooms + hosting), nav links on `site/docs/index.html`, a feature block on `site/index.html` with a screenshot; new screenshots: terminal, drill-down, settings, together.
- Skill `skills/opentrench-setup/SKILL.md`: sections "5. Share calls with friends (rooms)", "6. Live prices and your Alchemy key", "Host a relay", and the known failure modes for each.
- `CHANGELOG.md` Unreleased.

## 8. Testing

- relay: unit tests for hello/welcome/fan-out/presence/buffer/limits/access/version with `ws` in-process; one integration test that starts the relay on a random port and drives two clients.
- backend: `rooms.test.ts` — encrypt/decrypt round trip and AAD binding, invite encode/decode, room id derivation, RoomClient against the in-process relay (join, replay, send, reconnect, key mismatch, too-old), outbound throttle, no re-broadcast of `via` tokens; config sealing of room keys; routes.
- frontend: Settings Together section renders rooms and the create/join forms; the deep link fills the join field.

## 9. Not doing

No moderation inside rooms (anyone with the invite is equal); no chat messages over rooms; no relay federation; no directory of public rooms; no official or default relay (see §5).
