# Getting started with opentrench

opentrench turns the Discord servers and Telegram chats you already sit in into
one live terminal: every contract address anyone posts becomes a call card with
price, market cap, holders, launchpad, charts, one-click Cove buys and the
history of who called it. It runs on your own machine, reads with your own
accounts, and nothing leaves your computer except the requests to Discord and
Telegram themselves.

Community, help and release news: **https://discord.gg/6ByE8fPNN**

> **How Discord is wired.** opentrench does **not** use your Discord token.
> A small plugin runs inside your own Discord app (via Vencord) and feeds
> opentrench from there, so to Discord it is just you using Discord. Discord
> must be open for the Discord side of the feed to work. Client mods are still
> outside Discord's terms; Vencord has a very large user base and Discord has
> not banned for it. The Telegram side uses your own account through
> Telegram's official API, which Telegram allows.

---

## 1. Install

Grab the latest build from
**https://github.com/frogeth/opentrench/releases/latest**.

- **macOS** — download the `.dmg` (`arm64` for Apple Silicon, the other one for
  Intel), open it and drag opentrench into Applications. It is signed and
  notarized, so it opens like any other app.
- **Windows** — download `opentrench-Setup-x.y.z.exe` and run it. Windows will
  show a blue "Windows protected your PC" screen the first time because the
  installer is not code-signed. Click **More info → Run anyway**. That only
  happens once.

opentrench checks for updates on launch and every hour and installs them
itself, so you only do this once.

You can also run it as a web page from source with `npm install && npm run
build && npm start`, then open http://127.0.0.1:3210.

---

## 2. Connect Discord

Discord connects through the **opentrench bridge**, a Vencord plugin that
lives inside your Discord app. One-time setup, about five minutes:

1. Install [git](https://git-scm.com/), [Node.js 20+](https://nodejs.org/) and
   [pnpm](https://pnpm.io/installation).
2. Get Vencord's source:
   ```bash
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
3. Copy the plugin folder from opentrench's repo
   (`vencord/opentrench-bridge`, [here](https://github.com/frogeth/opentrench/tree/main/vencord))
   into `src/userplugins/` inside the Vencord checkout.
4. Build and inject it into your Discord install:
   ```bash
   pnpm build
   pnpm inject
   ```
5. Fully quit and reopen Discord. In **User Settings → Vencord → Plugins**
   enable **OpentrenchBridge**.

The `discord` pill in opentrench's top bar turns green as soon as the plugin
connects. If opentrench runs on a port other than 3210, set it in the plugin's
settings. Nothing is pasted into opentrench and no token is stored anywhere.

---

## 3. Connect Telegram

Telegram needs an API ID and hash for your account, which takes a minute:

1. Go to **https://my.telegram.org** and log in with your phone number and the
   code Telegram sends you.
2. Click **API development tools**. Fill in any app title and short name (for
   example `opentrench`), leave the rest, and click **Create application**.
3. Copy the **App api_id** (a number) and **App api_hash** (a long string).
4. In opentrench, **⚙ → Accounts → Telegram**: paste both and click
   **Save credentials**.
5. Enter your phone number in international format (`+15551234567`) and click
   **Send code**. Telegram sends a login code to your Telegram app (not SMS).
6. Type the code → **Submit code**. If your account has two-step verification
   you'll be asked for that password → **Submit password**.

The `telegram` pill turns green and stays logged in across restarts. **Log out**
in the same tab ends the session.

---

## 4. Add the channels you want

The feed only shows what you choose.

- Click the round **+** at the bottom of the left rail.
- Pick **Discord** or **Telegram**, browse your servers and chats, and tick the
  ones to watch. Click a name first to **preview** its recent history without
  adding it.
- Each Discord server and each Telegram chat then appears as an icon in the
  rail. Drag icons to reorder them. Click one to focus on it, click **★** to get
  back to everything.

---

## 5. Read the terminal

Two columns to start with:

- **All Calls** — one card per token, newest call first. The header line shows
  who called it, where, how long ago, a gold **1st** for a first call or a 🔥
  count when several chats have called it, the market cap at the call and the
  multiplier since. Under that: image, symbol, volume, market cap, age,
  address (click to copy), ATH, links, holders and the buy/sell bar. The last
  line is holder security — top 10, dev, insiders, LP lock — with **DS** when
  the dev has sold.
- **All Chats** — the raw messages, read bottom-up like Discord, with any
  contract turned into a token strip with a live chart.

Hover things: the 🔥 count for every caller, the globe for a website preview,
the X icon for the profile card, the bar for exact buys and sells. Click a
token's image for the drill-down: a candlestick chart on a market-cap axis
with every caller pinned on it, and the full call list.

---

## 6. Make it yours

- **Columns** — the round **+** at the right end adds a column: calls, chat or
  **Top Callers**, over all channels or a few. Drag the grip to reorder, the
  right edge to resize, the pencil to edit, × to remove. Layouts are saved.
- **Alerts** — the bell in a column header plays a sound on every new call
  there. Pick from eight tones in the column's edit dialog.
- **Favorites** — ⋯ next to any name → **Favorite caller**. They get a crown,
  and their first calls ping you with a sound, a desktop notification and,
  optionally, a message to your own Telegram Saved Messages.
- **Bots** — ⚙ → Feed → Bots: hide or show every bot the feed has seen. Rick,
  scanners and buy-bots are hidden by default; webhook alert channels show.
- **Trading** — ⚙ → Trading: your Cove quick-buy amounts.

---

## Troubleshooting

- **discord: auth_error** — the token is wrong or expired. Copy it again; it
  changes when you log out of Discord in that browser.
- **telegram: needs_login** — the session ended; go through Send code again.
- **Nothing in the feed** — you haven't added any channels yet (step 4).
- **No sound on the web page** — browsers block audio until you click
  something after the page loads. The desktop app has no such rule.
- **Windows: "opentrench cannot be closed"** — a copy is still running in the
  background. End `opentrench.exe` in Task Manager, then retry. Fixed for
  updates from 0.1.4 on.

Still stuck? Ask in the Discord: https://discord.gg/6ByE8fPNN
