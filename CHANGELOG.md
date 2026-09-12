# Changelog

Notes for every release. The **Unreleased** section is what the next release
will ship; `scripts/release.sh` turns it into the version heading, publishes it
as the GitHub release notes (which is what the Discord webhook posts), and the
app shows the same text in its update prompt.

## Unreleased

- Two more chart providers: **Birdeye** and **GMGN** (⚙ → Feed → Chart provider). Both embed a live chart under contracts like BasedBot does, and both cover Solana, Ethereum, Base, BNB, Arbitrum and Robinhood Chain — so Pons launches on Robinhood Chain get an inline chart for the first time (Dexscreener has no data there). Chains a provider doesn't cover fall back to the Dexscreener chart. A cold chart can take up to half a minute to draw.
- Buy and Research from a focused chat or the token drill-down now open the bot right there, as a drawer on the right, instead of silently landing in a column you can't see. Cove, BasedBot and Salpha all behave this way; on the main view the column flashes as before.
- Fix: the buy buttons on the token strip inside chat messages still opened Telegram. In-app routing is now the default for every buy row in the app, not something each screen has to opt into, and any Cove or BasedBot deep link that appears anywhere — including one somebody pastes into a chat — runs in the in-app pane or drawer instead of Telegram.

## v0.4.0 — 2026-09-11

- **Pick your buy bot: Cove or BasedBot** (⚙ → Trading → Buy buttons). Buy buttons on cards and in the drill-down, right-click → Buy on …, and the buy pane all follow the choice. There is one buy pane; it shows whichever bot is picked. BasedBot opens the token via its `r_<referral>_b_<mint>` deep link (the bot asks the amount); a web-app link is kept as a fallback. Cove keeps its one-click amounts.
- Referral credit on every buy goes to opentrench: Cove links carry the app's affiliate (base62-encoded into the 14-character tail per Cove's deep-link spec) and BasedBot links carry the app's referral. Neither is a setting.
- Search anyone to favorite. ⚙ → Feed → Favorites now has a people search instead of a blind name field: it lists everyone the feed has seen (including people who only chat and have never called), and when you type it also searches your Discord servers and Telegram groups for members who have not posted at all. Each row shows their calls, messages and where, and one click toggles the crown. Typing a name nothing matches still lets you add it verbatim (alextjh).
- Browse a chat's member list. The same picker has a chat dropdown: pick any watched Discord channel or Telegram group and it lists that chat's members, so you can crown someone who has never posted. Members already in the feed show their calls and messages; the rest read "hasn't posted here yet". Telegram hides the member list of large channels, and Discord only knows the members its client has loaded.
- Sound fixes. The 🔕 in the top bar is now a true master mute: column alerts and J7 pings obeyed only their own switches before and kept playing. A column's bell is the only thing that makes it ping: call alerts come only from chat/calls columns with the bell on (the J7 pane's bell was wrongly counted as a call alert, so every new call also played its tone), and J7 starred-account pings and notifications fire only when the J7 column's bell is on. Bot panes no longer show a bell. The top-bar bell now toggles sound no matter what the desktop-notification permission is; before, it only became a mute after notifications were granted, so users who declined them had no way to silence the app.
- Dark form controls. The page never declared `color-scheme: dark`, so every native control the OS draws — dropdowns and their popups, scrollbars, date pickers — rendered light. Settings dropdowns are now styled like the text fields, with a matching chevron, and the people picker's scrollbar is themed.
- The last column can be resized. It used to fill the row and was given no resize handle, so whichever column sat on the end — the buy pane, most often, since it is appended when you first buy — was stuck at its width. Every column now has a handle, and the leftover width goes to the last column you have not sized yourself.

## v0.3.1 — 2026-09-11

- The red status banner (e.g. "discord: open Discord with the opentrench plugin enabled") can be dismissed with an × and stays dismissed across restarts, so Telegram-only users aren't nagged. It's keyed to the exact message, so a different error for the same platform still shows. The top-bar pill keeps showing the real state.

- Telegram-only fixes. Channel and supergroup messages were dropped when Telegram handed the chat id back in a different shape than the watch list stored (`-100…` vs bare), and All Chats hid Telegram messages whose chat title didn't match the dialog list, which is why they showed in a focused chat but not in All Chats or the ★ view. Both now match by chat id in every shape.
- The add-column + stays pinned at the right edge of the terminal instead of sliding into the horizontal overflow when columns fill the width.

- Every Cove buy now opens inside opentrench's Cove column, never a Telegram tab. Buy buttons, the token drill-down, right-click Buy, and Cove's own in-panel buttons (Move, Sell, buy confirms) all run through your Telegram session in-app. Only genuinely external links like charts still open a browser tab.

## v0.3.0 — 2026-09-11

- Chat and J7 columns hold your place: when you're scrolled up (or away for a while), new messages, reconnects and old rows dropping off no longer move what you're reading. "Latest" is still one click away.
- Paste or drop images into any composer to send them, with the text as the caption. Telegram sends through your session; Discord uploads through your own client via the plugin.
- Share button on J7 tweets: pick chats in your feed and the tweet link is sent there, with a "sent to …" line under the tweet (Brandzo).
- Click any image in chat, embeds, previews or tweets to view it full size; Esc or click outside closes, "Open original" for the file (Brandzo).

- **Discord through your own Discord app.** opentrench can now read and send Discord through a small Vencord plugin (`vencord/opentrench-bridge`) running inside your Discord client, the way BetterDiscord and Vencord plugins work: the client's own functions do the work, so there is no self-bot session for Discord to detect and no token anywhere. Discord must be open for that side of the feed to work.
- **Tokens are read-only now.** If you connected with a user token, nothing changes for reading. Sending and reacting with a token are gone (that was the part Discord bans for); they need the plugin. A one-time note in the app explains this, and the switch is yours to make: once the plugin connects, the token session closes on its own and you can remove the token in Settings.
- **opentrench.app**: a website with a landing page and step-by-step setup guides for Mac and Windows (Discord plugin, Telegram). Settings and the update note link there.

## v0.2.1 — 2026-09-11

- Pings ignore bots by default. Settings → Feed → Bots has a "Pings from" switch: no bots, bots I pick (a per-bot "pings" toggle appears), or every bot (Brandzo).

## v0.2.0 — 2026-09-11

- Right-click → Open token works on any contract, called or not: the drill-down loads market data and holder security on the spot so you can research a launch before anyone calls it.

- Click the chat chip on any message to open that channel or group in the focused view.

## v0.1.19 — 2026-09-11

- Fix: jumping to a message from Pings (or to a reply) no longer drops it into whatever column is focused; a message only ever shows in a column that carries its chat. If nothing on screen shows that chat, the jump focuses it first.

## v0.1.18 — 2026-09-11

- J7Tracker column: paste your J7 session id in Settings → Accounts and its tweet feed streams natively, newest first, with a strip under each tweet showing the calls it mentions (by contract or $ticker). Click a match to jump to the call; contract addresses in tweets get the usual copy and right-click actions. Unofficial integration, read-only.
- J7: launches pair up live. While a J7 column is open, new pump.fun and Pons (Robinhood Chain) tokens whose links point at a tweet in the feed appear under that tweet within seconds, with market cap, launch time and the contract as a normal chip. A "scan launches" button digs for older ones.
- J7: star an X account on any of its tweets and you get a sound (pick it in the column editor) plus a desktop notification whenever it tweets.
- J7 column shows deleted tweets the way J7 does: the original stays put and a red "deleted" copy lands at the top of the feed.
- J7 launches only count when the token's links point at that exact tweet and it launched after the tweet. Account-only links no longer pair.
- Pings window: a small panel bottom-left (the @ button in the top bar opens it, it minimizes to a pill) lists everyone who pinged you across Discord and Telegram: direct mentions, replies to you, @everyone/@here and your roles. Each ping shows the 4 messages before it, the ping highlighted, and the next 4 as they arrive, so it reads in context. Jump to chat scrolls the column to the message; reply answers from the panel. New pings chirp and post a desktop notification (Brandzo). Tagging yourself counts too, so you can test it.
- Discord mentions show real names: @user, @role and #channel markup is resolved to the person's display name, the role name and the channel name.
- Right-click on any contract now also offers "Open token", the same drill-down you get from a call card's picture.
- Cove buy buttons now cover every chain in Cove's deep-link table: Tempo, Monad, Story, HyperEVM and Plasma join ETH, Base, BNB, MegaETH, Robinhood and Solana. Arbitrum, Ink and Stable have no published code yet; right-click → Buy on Cove still works there because it sends the bare contract.
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
