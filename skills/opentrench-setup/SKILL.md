---
name: opentrench-setup
description: Use when someone is installing opentrench, connecting Discord or Telegram to it, adding channels, sharing calls with a friend, joining a room, sending or pasting an invite link, hosting a relay, adding an Alchemy key or custom RPC for live prices, or when the desktop app shows a red discord/telegram pill, "backend did not come up", a blank column, a plugin that will not connect, a room stuck on "offline · retrying" or "this relay needs updating", prices that are not live, or a card without the green dot. Walks through the exact steps for macOS and Windows and the known failure modes.
---

# opentrench setup

opentrench is a desktop app (Electron) with a local backend on 127.0.0.1:3210. It reads the
user's own Discord and Telegram accounts. Nothing needs installing besides the app itself,
except the Discord plugin step below.

## 1. Install the app

Send the user to https://github.com/frogeth/opentrench/releases/latest and tell them which
single file to download:

| Machine | File |
| --- | --- |
| Mac, Apple Silicon (any Mac from 2020 on) | `opentrench-x.y.z-arm64.dmg` |
| Mac, Intel | `opentrench-x.y.z.dmg` (no `arm64` in the name) |
| Windows | `opentrench-Setup-x.y.z.exe` |

Apple menu → About This Mac says "Chip: Apple M…" (Apple Silicon) or "Processor: Intel…".
Ignore `.zip`, `.blockmap` and `.yml`. Windows shows "Windows protected your PC" once: More
info → Run anyway. The app updates itself afterwards.

Do NOT walk a non-developer through `npm install`; that is the from-source path and the
usual source of "npm missing", "make missing" and dependency errors.

## 2. Connect Discord

Discord connects through a Vencord plugin inside the user's own Discord app, so no token is
pasted or stored. Discord must be open for that side of the feed to work.

Preferred: in opentrench, ⚙ → Accounts → Discord → **Set up Discord**. The app quits Discord,
installs its bundled Vencord (with the opentrench plugin enabled) and relaunches Discord. The
`discord` pill turns green within a few seconds.

If the button is missing or fails (Discord installed somewhere unusual, or a permissions
error), the manual route is https://opentrench.app/docs/discord/ (git + Node + pnpm, clone
Vencord, copy `vencord/opentrench-bridge` into `src/userplugins`, `pnpm build`, `pnpm inject`).

Known failure modes:
- "macOS blocked the change (App Management)": macOS gates edits to other apps' bundles.
  System Settings → Privacy & Security → App Management → switch on opentrench, press Set
  up Discord again. The dialog in the app offers to open that pane.
- Pill stays red: Discord is not running, or the plugin is disabled (Discord → User Settings →
  Vencord → Plugins → OpentrenchBridge), or it points at a different port than the backend.
- Discord updated itself: on macOS an update replaces the app bundle and removes the
  injection. Run Set up Discord again.
- "Discord is not installed" from the button: only /Applications/Discord*.app (macOS) and
  %LOCALAPPDATA%\Discord* (Windows) are searched.

There is no token field any more. A token saved by an older version keeps being read until the
plugin connects, then the plugin is the one way in.

## 3. Connect Telegram

Telegram uses the user's own account through Telegram's official API. It needs an API ID and
hash, which take a minute:

1. https://my.telegram.org/apps, log in with the phone number and the code Telegram sends.
2. Fill any app title and short name, Create application.
3. Copy App api_id (a number) and App api_hash (a long string).
4. opentrench ⚙ → Accounts → Telegram: paste both, Enter or Save credentials.
5. Phone number in international format (+15551234567) → Send code. The code arrives in the
   Telegram app, not by SMS. Enter it; then the two-step password if the account has one.

Failure modes: "PHONE_NUMBER_INVALID" (missing country code), "FLOOD_WAIT" (too many
attempts, wait the stated seconds), a code typed with spaces.

## 3b. Vampy (optional)

A vampy.app subscriber can mirror the feeds built there. On vampy.app: Settings → API → generate a
key (shown once). In opentrench: ⚙ → Accounts → Vampy → paste it → **Save & connect**; the card
shows the plan, days left and the number of feeds. Each Vampy feed is then a chat (rail group
"Vampy", channel picker of any column); a call feed's calls count as calls. A **Vampy** column shows
one feed on its own. `auth error` on the card: the key was rejected (rotated) or the plan lapsed.

## 4. Add channels and columns

The **+** in the left rail lists every Discord server/channel and Telegram chat; **+ add**
puts it in the feed, the eye previews it. The search box narrows servers, channels and chats.
Columns (All Calls, All Chats, Trending, Top Callers, Website, bots, Vampy…) are added with the + in
the column header row; each column has its own channel scope and filters.

## 5. Share calls with friends (rooms)

A room is a private channel for calls. It lives on a relay: a small server that passes
encrypted messages between members and cannot read them. Nothing to port-forward, no IP
handed out; friends can be anywhere.

1. ⚙ → **Together** (sidebar) → **Create a room**: type a name and paste a relay address.
   There is no official relay: host your own (see Host a relay, one command) or use a
   friend's. The field is empty the first time and remembers the last relay you used.
   **Check** next to the field asks the relay whether it is up; Create does not probe first. "What's a relay?"
   under it explains the server. Create.
2. **Copy invite** on the room card and send it to the friend (any messenger). It looks like
   `opentrench://room/<relay-host>/<key>`; whoever has it is in, so treat it like a password.
3. The friend pastes it into **Join a room** → Join, or clicks the link with opentrench
   installed (it opens Together with the invite filled in).
4. Their calls appear in the feed with a `via <name>` tag; the room card shows members online.

**Rotate** (the **New invite** button) makes a new key = a new invite. The other members' cards
say `invite changed — ask for the new one` and stop reconnecting; they Leave and re-join with
the new invite, anyone with the old one is out. That is the only way to remove someone.
**Leave** drops the room on this machine only.

What travels: calls only (token address and chain, who called it, in which chat, when),
encrypted on each machine with the key in the invite. No chat text; no prices, market caps,
liquidity, volume or holder data: every app prices what is on its screen itself (§6, live from
the pool on screen, Dexscreener otherwise), so a friend's call is priced on your side the same
as your own.

A relay with an access code: enter it per room, on create, under "This relay asks for an access
code" on join, or in the field the room card shows when it says `relay wants an access code`.

State on a room card:

| Card says | Meaning / what to do |
| --- | --- |
| connecting… | First connect or a reconnect; give it 15 s. |
| connected | Fine; `N online` is how many members the relay sees. |
| offline · retrying | Relay unreachable or the network dropped; the reason follows, most often `could not reach <host>`. Check the host in the invite / relay field; is the relay up (`curl https://<host>/` should answer JSON)? A relay that has not been started yet shows this too. |
| invite changed — ask for the new one | The room was rotated; the app stops reconnecting. Leave, join the new invite. |
| this relay needs updating | The relay speaks an older protocol than the app. Whoever hosts it must update it (see Host a relay). Nothing to do on the client. |
| relay wants an access code | The relay runs with `RELAY_ACCESS_CODE`; ask its operator for the code and enter it in the field on the room card (kept per room). |
| room is full | 50 members per room (or the relay's room cap). Rotate into a second room or raise the relay's limits. |
| slow down · retrying | The relay cut the connection for sending too fast; the app backs off and reconnects by itself. |

Known failure modes:
- Two people made two rooms instead of one joining the other: rooms are separate keys. One
  creates, the rest join that invite.
- A friend on an older opentrench sees "update opentrench": the relay is newer than their app.
- Clicking an `opentrench://` link does nothing: the link handler registers on first launch of
  the installed app; open the app once, or paste the invite into Join a room.
- Calls from the room show but stay unpriced: that is §6, not the room.

**Same Wi-Fi instead** (no relay, nothing leaves the network) still exists under that
disclosure on the same page: the nearby list shows machines on the LAN, **Allow** a request
when the 4-letter code matches on both screens, port 3211 must be open between them.

## 6. Live prices and your Alchemy key

Every token on screen is priced from its pool on-chain every 3 s (one batched RPC per chain).
A green dot on the card = the number is live. Off-screen tokens are not read; Dexscreener and
GeckoTerminal still fill liquidity, volume and 24h change.

Setup: ⚙ → **Market data**.
- Paste an **Alchemy API key** → Save. Save probes it; the list under it names the chains the
  key answers for (Robinhood Chain and HyperEVM included). Same table serves NFT mints.
- Or a **custom RPC** per chain in that chain's row → Save. Priority: custom RPC > Alchemy >
  public endpoint. Each row shows the source in use and `N live · M skipped`; hover "skipped"
  for the reasons.
- Public RPCs work with no key, but rate-limit.

Known failure modes:
- `0 live` on every chain: no screen is reporting yet (open a calls column: only visible
  tokens are priced), or the RPC is down (the chain row shows the error; try another source).
- "paired with X, which is not priced": the token's quote asset has no pool the app can read.
  Nothing to do; Dexscreener prices it.
- A card without the dot: its pool type is not read on-chain yet (a v4 pool with no quote
  address yet, PancakeSwap Infinity, or a pool no directory has listed). Dexscreener prices it
  on its normal cadence.
- Robinhood rows full of 429 / rate-limit: the public RPC throttles; add the Alchemy key.
- "The key answered for no chain": wrong or revoked key, or the Alchemy app has every network
  disabled; check the app on dashboard.alchemy.com.

The Alchemy key is stored sealed like the other secrets; custom RPC URLs are plain text in
`config.json`.

## Host a relay

Anyone can run the relay from the repo (`relay/`): one Node 22 process, no database. Pick one:

```sh
# Fly.io (shipped fly.toml: 256 MB, one region, a volume for room buffers)
cd relay && fly launch --copy-config --yes && fly volumes create relay_data --size 1 && fly deploy

# Docker
docker build -t opentrench-relay ./relay && docker run -d -p 8080:8080 -v relay-data:/data opentrench-relay

# Any Node host, behind a TLS proxy (the app connects over wss://)
npm ci -w relay && npm run build -w relay && PORT=8080 RELAY_DATA_DIR=./data node relay/dist/index.js
```

Caddy in front of the Node route: `relay.example.com { reverse_proxy 127.0.0.1:8080 }`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `RELAY_ACCESS_CODE` | unset | Only apps configured with this code can join; a relay private to your circle. |
| `RELAY_MAX_ROOMS` | `1000` | Rooms held at once. |
| `RELAY_MAX_MEMBERS` | `50` | Members per room. |
| `RELAY_DATA_DIR` | unset | One `<room>.json` per room so a restart keeps the last day; unset = memory only. |
| `RELAY_BUFFER_HOURS` | `24` | How long recent messages are kept for late joiners (also capped at 2000). |
| `RELAY_TRUST_PROXY` | `0` | `1` to read the client IP from `fly-client-ip` / last `x-forwarded-for` for the per-IP limit. Only behind a proxy that sets that header itself (Fly does; `fly.toml` sets it). |

Verify: `curl https://<host>/` → `{"name":"opentrench-relay","v":1,"rooms":N}`. Then in the
app put `wss://<host>` in the relay field when creating a room. Your invite carries your
relay's address; friends configure nothing.

The operator sees IPs, member ids and traffic volume. Not calls, names or tokens: those are
inside the ciphertext. A room nobody visits for 7 days is dropped, file included.

## Where things live

- macOS: config and state in `~/Library/Application Support/opentrench/` (`config.json`,
  `state.json`; tokens, room keys and the Alchemy key inside are sealed with a key in the
  Keychain; custom RPC URLs are plain). Logs: `~/Library/Logs/opentrench/desktop.log` and the
  app menu's Open Log Folder.
- Windows: `%APPDATA%\opentrench\` and the same Open Log Folder entry in the File menu.
- The backend answers on http://127.0.0.1:3210 (`/api/version` shows the build).

## When the app says "backend did not come up" or attaches to an older build

Another opentrench backend is already listening on 3210 (a stale process, or one started from
a source checkout). Quit it and reopen the app. The app refuses to attach to a backend from a
different version and says so in a dialog.
