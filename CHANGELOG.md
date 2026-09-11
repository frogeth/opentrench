# Changelog

Notes for every release. The **Unreleased** section is what the next release
will ship; `scripts/release.sh` turns it into the version heading, publishes it
as the GitHub release notes (which is what the Discord webhook posts), and the
app shows the same text in its update prompt.

## Unreleased

- J7Tracker column: paste your J7 session id in Settings → Accounts and its tweet feed streams natively, newest first, with a strip under each tweet showing the calls it mentions (by contract or $ticker). Click a match to jump to the call; contract addresses in tweets get the usual copy and right-click actions. Unofficial integration, read-only.
- J7 column shows deleted tweets the way J7 does: the original stays put and a red "deleted" copy lands at the top of the feed.
- J7: star an X account on any of its tweets and you get a sound (pick it in the column editor) plus a desktop notification whenever it tweets.
- J7: a "launches" button under each tweet scans pump.fun and letsbonk for tokens whose metadata links that tweet (or just the account), with market cap, launch time and the contract as a normal chip.
- Bots: with "Show bots" on, a new "Calls from" switch lets you keep bots in your chats while only the bots you mark "calls" put tokens in the Calls column (Brandzo).
- Composer keeps keyboard focus after you send a message, so you can keep typing (Brandzo).

## v0.1.17 — 2026-09-11

- Salpha column: your conversation with @salpha_research_bot, alongside Cove.
- Right-click any contract address (in chat, on a call card, in the drill-down) for Buy on Cove, Research with Salpha, or Copy. Buy and Research paste the address to that bot and open its column.
- Cove and Salpha columns have a slimmer editor: no channel list, since they show one bot conversation.

## v0.1.16 — 2026-09-10

- Cove panels keep their links and formatting: positions, Sell 100%, Move, Hide and Switch to bulk sell are clickable and act inside the app.

## v0.1.15 — 2026-09-10

- Cove: alerts the bot deletes (Close, or expired) disappear from the Cove column too, instead of erroring when pressed.

## v0.1.14 — 2026-09-10

- Cove inside the app: the $25 / $50 / $100 / Cove buttons now open a Cove column (added on first use) that shows the bot's reply through your own Telegram session. Cove's inline buttons work in place, edits update live, and there's a box to type commands. Needs Telegram connected; otherwise the buttons open Telegram as before.

- The share button on a call opens an in-app picker: tick up to six chats across Discord and Telegram and the bare contract address is posted to each, one at a time. Respects the per-platform sending switches; the Telegram share sheet is still there as a fallback.

- Messages you send from the app show up in the chat log immediately on both platforms.
- A media toggle in chat column headers (on by default) hides picture, gif and sticker-only posts when off. Remembered like the other toggles.

## v0.1.13 — 2026-09-10

- Reactions: click a reaction under a message to add yours, or hover and use ☺+ for a quick emoji picker. Uses the same per-platform sending switch as the composer.

- Repeat contract posts show by default (with their 🔁 badge) instead of being hidden; the hidden and repeats toggles are remembered.

- "Latest" lands on the bottom of the last message, and a column pinned to the end stays there as rows load and grow.

- Click a reply quote to jump to the original message: it scrolls into view and flashes. A hidden or filtered original is revealed in place; one that has left the buffer opens on Discord or Telegram.

## v0.1.12 — 2026-09-10

- Send messages and replies from the app. A composer sits under every chat column with a target picker, and hovering a message shows a reply arrow. Off by default per platform: Telegram is a plain toggle in Settings → Accounts; Discord shows the self-bot ban risk and needs a typed acknowledgement. One message a second per chat, only what you typed.

## v0.1.11 — 2026-09-10

- Per-column filters: a funnel in every column header opens the new two-pane editor — channels by server on the left; callers to show or mute, chains, launchpads, must-haves, and min/max ranges for metrics, activity and holder distribution on the right. Chat columns filter by search, bots and callers.
- The column editor shows every channel ticked when a column follows all channels, with select all / deselect all links.
- Patch notes: every release carries notes on GitHub (so the Discord webhook posts them) and the update prompt in the app shows what's new, with a button to the full notes.
- The hidden / repeats toggles in chat column headers are pill buttons that match the new look.

## v0.1.10 — 2026-09-10

- Mark calls as seen: a checkbox in each card's top-right corner, and "N new · mark seen" in the column header. Marks are saved and follow you between devices.
- Market cap is shown in gold; volume is a size smaller so the two stop competing.
- Repeat contracts get a 🔁 badge on the token strip instead of a dimmed message.
- The add/edit column picker groups channels by Discord server, Telegram last, with a checkbox per group.
- The "latest" button is a green pill centered at the bottom of chat columns.
- Fixed column titles wrapping in crowded headers and the drill-down's numbers running together.
- `#token=<address>` in the URL opens that token's drill-down.
- Releases now upload as a draft and go live only when every file is present, so an update check can no longer land on a half-published release.

## v0.1.9 — 2026-09-10

- Holder security refreshes near-live: every minute for calls under an hour old, every 5 minutes under 6 hours, every 30 minutes under a day. EVM chains are fetched in one batched request per chain.

## v0.1.8 — 2026-09-10

- Column resize is exact: a dragged column is as wide as you drag it (320–1600px) and only the last column stretches to fill the row.

## v0.1.7 — 2026-09-10

- Per-column sound alerts: the bell in a column header arms it, and the edit dialog picks one of eight built-in tones. Fires on new calls in that column's channels.

## v0.1.6 — 2026-09-10

- New look: terminal palette, Inter Tight, a three-row call card with risk chips, header tickers for BTC, ETH, SOL and HYPE.
- Column terminal: add, edit, remove, drag to reorder and drag to resize columns; layouts are saved.
- Top Callers column: callers ranked by median multiplier over 24h, 7d or 30d, with hover for their calls.
- Token drill-down: candles on a market-cap axis with every caller pinned, plus the full call list.
- Bot embeds collapse to one line; consecutive messages group under one header in every chat column.
- Long feeds render only what is on screen.
- Market caps now refresh every minute for every recent call.

## v0.1.5 — 2026-09-09

- Hover cards: the caller list on the call count, website preview on the globe, X profile on the X icon, exact buys and sells on the bar.
- Holder security strip with DH/DS badges and risk flags.
- Market cap recorded per call, with the multiplier since the first call in the card header.
- "Search on X" link on every card.

## v0.1.4 — 2026-09-09

- Windows: the backend exits with the app and the installer closes any leftover copy, fixing "opentrench cannot be closed" during updates.

## v0.1.3 — 2026-09-09

- App icon.
- Bots can be shown or hidden one by one (Settings → Feed → Bots); webhook alert channels show in the feed.
- Discord rich embeds render like Discord, with markdown in chat.
- The page reloads itself when the server restarts with a new build.

## v0.1.2 — 2026-09-09

- First signed and notarized macOS build. Mac updates install in place from here on.

## v0.1.1 — 2026-09-09

- First public desktop release for macOS and Windows with automatic updates.
