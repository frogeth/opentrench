# opentrench

One live feed for your Discord channels and Telegram chats, with contract
addresses highlighted and copyable. Runs entirely on your machine.

> **Warning.** The Discord side uses your **own account token** (a self-bot).
> That is against Discord's Terms of Service and can get the account banned.
> Use at your own risk. The Telegram side uses your own account via the
> official MTProto API, which Telegram permits.

## Run

```bash
npm install
npm run build
npm start          # http://127.0.0.1:3210
```

Dev mode with hot reload (`http://localhost:5173`):

```bash
npm run dev
```

## What the feed does

One Discord-style layout for both platforms. The rail on the far left has
**★ All** pinned on top, then your Discord servers and Telegram chats as icons
(each badged with its platform's logo, drag to reorder — the order is saved),
and **+**. The « next to ★ collapses the channel pane. The pane lists only
what's in your feed for the selected rail item: channels by category for a
server, everything (grouped by server / Telegram) for All. Then
**Calls** (one card per contract, newest call first) and **Chats**, both scoped
to whatever is selected; a focused chat groups messages by author like
Discord. The tab row under the header is a quick switcher across every watched
chat.

**+** opens the picker: every server & channel, or every Telegram chat, with a
`+ add` / `✓ in feed` toggle and a preview eye. Clicking a name **previews**
its recent history without adding it (a banner offers "+ add to feed").
Clicking a ticker under a message jumps to and flashes its card in Calls.
The search box matches text, authors, chats, tickers and addresses.

Settings (⚙) is one modal with three tabs: **Accounts** (Discord token,
Telegram login), **Feed** (favorite callers & pings, blacklist), **Trading**
(Cove amounts, o1 key). Channels are managed in the sidebar, not in settings.

- Newest on top. Discord and Telegram merged, with each platform's logo and the
  poster's avatar.
- Every contract address becomes a card: ticker, name, chain, price, market
  cap, liquidity, 24h change, a **live chart** you can expand in place, and
  icon links for chart / website / 𝕏 / Telegram / explorer. Click the ticker
  or address to copy.
- Token data is layered, so a minutes-old launch still resolves: Rick-style
  scanner posts (parsed, never shown) → Dexscreener → GeckoTerminal (covers
  Robinhood Chain and fresh pools) → Bankr (launch name, chain, socials). A
  token with no price yet is re-checked after 1 and 5 minutes.
- "called N×" counts how many different chats have posted a contract since
  the server started (hover to see which). Repeats inside the same chat don't
  count.
- **Call cards** show the caller (with a 👑 if favorited), age, live market
  cap, token image with chain badge, ticker, token age, price, a buys/sells
  bar, volume, market cap, ATH since first call, liquidity, Cove buttons and
  a Telegram **share** button. Market numbers refresh every minute for tokens
  called in the last 24h. A token called by a second chat glows and jumps to
  the top; three or more chats turns it red.
- **Favorite callers** (⋯ next to a name → 👑) ping you when they post a
  contract nobody has called yet: a desktop notification with a sound (enable
  with the 🔔 in the top bar) and a message to your own Telegram Saved
  Messages (toggle in Settings).
- **Launchpads.** pump.fun (coin API: image + market cap while still
  bonding), Bankr, Stonks, Pons and Flap (read straight off the token contract
  on Robinhood Chain / BNB), Virtuals, Clanker and letsbonk are detected
  automatically; o1 needs an API key (Settings → Trading). The launchpad's logo sits on the
  token image and links to the launch page, and the launchpad's own token
  image and socials fill in when no chart site has them yet. IPFS images go
  through a local gateway-hopping proxy.
- **Buy buttons** open Cove (t.me/cove_trading_bot) with the token and a USD
  amount prefilled, same deep-link format frogr uses. Amounts and an optional
  affiliate Telegram ID live in Settings → Buy buttons. Supported chains:
  Ethereum, Base, BNB, Robinhood Chain, MegaETH, Solana.
- Charts come from **BasedBot** (token-address embeds on Robinhood, Base,
  Ethereum, Solana, BNB, Arbitrum); Dexscreener / GeckoTerminal is the
  fallback and can be made the default in Settings → Feed.
- Live charts open automatically under every contract in Chats (only the
  ones on screen actually load; switch it off in Settings → Feed).
- Replies show the quoted message above the text; reactions show as pills
  under it and update live (Discord custom emoji render as images).
- Images, GIFs, videos and stickers render inline (Telegram media is fetched
  through your session and served locally). X/Twitter links get a preview
  card from the platform's own unfurl, or from the public fxtwitter API.
- Bot posts and repeat posts (a contract already posted in that same chat) are
  hidden by default. Toggles in the Chats column bring them back. Bots never
  create or count a call.
- **Blacklist** a caller with the 🚫 next to their name (or in Settings):
  they're treated like a bot from then on and the call list is rebuilt.
- Messages, calls, counts and reactions **persist across restarts** in
  `backend/state.json` (written a couple of seconds after each change). Filter matches text, author, chat, ticker and name.

## Desktop app (macOS)

```bash
npm run desktop        # build, then open opentrench as an Electron window
npm run desktop:dist   # build a .dmg into electron/dist/
npm run dist:win -w electron   # Windows installer (.exe), built from macOS
```

### Updates

The app checks GitHub Releases (frogeth/opentrench) on launch and hourly, and
there's "Check for Updates…" in the app menu. Windows installs updates
silently on quit. macOS can self-update only when the build is signed and
notarized (Developer ID cert in the keychain + `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in the environment when
releasing); an unsigned Mac build shows a "download the new version" dialog
instead. Cut a release with:

```bash
npm run release -w electron            # patch bump, build mac + win, upload
npm run release -w electron -- minor   # or: major, or an explicit version
```

Windows builds are unsigned too: SmartScreen shows "Windows protected your
PC" on first run → More info → Run anyway. Each user connects their own
Discord and Telegram accounts on first launch.

The desktop app runs the same backend with Electron's bundled Node and keeps
`config.json` / `state.json` in `~/Library/Application Support/opentrench` (an existing trenchfeed folder is adopted once).
First run from the repo copies the dev checkout's files there. If a server is
already listening on 3210 the app attaches to it instead of starting another.
External links open in your default browser. The build is unsigned: on first
launch right-click the app → Open.

## Setup (in the browser, ⚙ top right)

1. **Discord** — paste your user token, save. Then tick the channels to watch.
2. **Telegram** — enter API ID + hash from https://my.telegram.org, save.
   Enter phone → code → 2FA password if prompted. Then tick chats to watch.

Everything is stored in `backend/config.json` (git-ignored, mode 600).
Nothing is sent anywhere except to Discord and Telegram.

## Tests

```bash
npm test
```
