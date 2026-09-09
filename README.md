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
- Bot posts and repeat posts (a contract already posted in that same chat) are
  hidden by default. Toggles in the feed bar bring them back. Filter matches text, author, chat, ticker and name.

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
