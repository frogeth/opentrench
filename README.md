# trenchfeed

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

Two equal panels: **Calls** (one card per contract, newest first, with who
called it first) and **Chats** (the merged message stream). The tab row lists
every watched chat with its photo and filters both panels to one chat; the
Discord / Telegram buttons at its left open a channel browser (server rail,
channels by category, add / remove from feed). Clicking a ticker under a
message jumps to and flashes its card in Calls. The search box matches text,
authors, chats, tickers and addresses.

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
- **Buy buttons** open Cove (t.me/cove_trading_bot) with the token and a USD
  amount prefilled, same deep-link format frogr uses. Amounts and an optional
  affiliate Telegram ID live in Settings → Buy buttons. Supported chains:
  Ethereum, Base, BNB, Robinhood Chain, MegaETH, Solana.
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
