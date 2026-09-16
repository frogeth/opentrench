# Changelog

Notes for every release. The **Unreleased** section is what the next release
will ship; `scripts/release.sh` turns it into the version heading, publishes it
as the GitHub release notes (which is what the Discord webhook posts), and the
app shows the same text in its update prompt.

## Unreleased

- MintGo column: the feed holds still while your pointer is over it, so the mint you are about to click does not slide away. New mints queue behind a "N new mints waiting" pill and flow in when the pointer leaves (or you click the pill). (Suggested by lunchbag.)
- Clicking a trending row opens the token drilldown (chart, every call, buy buttons) instead of only highlighting it in the calls column. (Suggested by Brandzo.)
## v0.9.4 — 2026-09-16

- Every token now shows what it is paired with (/ WETH, / USDC, / SOL …) next to its chain mark: call cards and compact rows, the token drilldown, the trending column and chat chips. Hover for the venue (Uniswap, Raydium, pump.fun, a launchpad's bonding curve).
- Token drilldown: the chart falls back to your chart provider's embed (BasedBot, Dexscreener, …) when candles are unavailable, and says why (GeckoTerminal rate limit, no pool yet) instead of an empty grid. The backend now pauses all GeckoTerminal requests for half a minute after a rate limit instead of collecting more of them.
- Token drilldown calls: one row per person. The same caller scanning in several chats is one row with ×N and every chat listed (entry from the earliest scan), and your own Discord and Telegram scans fold into a single "you" row.
## v0.9.3 — 2026-09-16

- A Telegram bot you add to the feed (its own chat, like a custom alert bot) is no longer hidden by the bot policy and its contracts count as calls; only the blacklist can hide it.
- The Telegram picker finds chats by @handle too, shows the handle next to the name, and a name pasted from Telegram (with the @ and the invisible marks Telegram wraps it in) still matches.
- The app no longer silently stops a backend started from a checkout when an update makes it look older; it asks Use it / Replace it (its own leftover backends are still replaced without asking).
## v0.9.2 — 2026-09-16

- A chat column whose chats sit outside the server or channel picked in the rail now says so, with a "show all channels" button, instead of a bare "Nothing here yet." (a friend's single-chat column looked broken while a server was selected).
- Fixed: dragging a column edge or a stack divider could stay stuck in resize mode after letting go (mouse and trackpad) when the release landed over a chart or website frame; the handle now keeps the pointer until it is released. Fixed: a narrow column pushed its × button past the edge; the header toggles give way first.
- TrenchTogether without the link: a machine with sharing on announces itself on the local network, so friends see it by name under Nearby in the Together tab and press Connect. The other side gets an Allow / Ignore prompt with a four-character code shown on both screens, and Allow does the pairing. The pairing string stays as "pair by link" for people not on the same network, shown once instead of once per address.
- Synthra Launches (app.synthra.org) on Arc and Robinhood: badge, bonding progress, curve complete or graduated, price and market cap (Robinhood's ETH-priced launches converted with Synthra's own rate), image and socials from its metadata service, and a launchpad filter entry.
- Trending column: each row now says who found the token (first caller, chat, when; click to see that message) and shows the faces of everyone who scanned it in the window. The hover list of scans opens each message in the app instead of the browser. Entry and current market cap, the multiple and the most-scanned ordering were already there. (Suggested on Discord.)
- Two more Arc launchpads: Peach (peach.ag, from its launchpad API: name, image, price, market cap, liquidity, progress or graduated) and DYOR Launch (dyorswap.org, from its factory and curve contracts on Arc and Robinhood: bonding progress or graduated). Badges, token-page links and launchpad filters for both.
- Cove buy buttons on Arbitrum, Stable, X Layer and Avalanche too, now that Cove published its full chain-code table.
- o1 launches on Arc and Monad are recognised (o1's API added both chains).
## v0.9.1 — 2026-09-16

- Scanner cards (Rick, Phanes, TokenScan, and mirrors relaying them) count only the token they are about. The pair address and the top-holder wallets a card links had each counted as a separate token, which is why one Rick post could fill a column with strange calls. Existing stray tokens are cleaned up once on update. (Brandzo.)
- Chat columns: a message that carries a contract always shows its author and time, even right after another message from the same poster, so a run of calls relayed by one account reads as calls rather than a stack of bare token chips. (Brandzo.)
- Telegram groups: messages from the group's owner and admins carry a gold tag next to the name, owner, admin, or the custom admin title the group gave them, the way Telegram shows it.
- Arc tokens get an explorer link (A/X Explorer, arcexplorer.org), and Arc mint transactions link there too.
## v0.9.0 — 2026-09-16

- Cove buy buttons and the trade panel work for Arc tokens (Cove's chain code for Arc, confirmed against its own panels).
- pump.fun tokens whose mint does not end in "pump" (the vanity suffix is optional) get their picture and badge: pump.fun itself is asked for every Solana token the chart sites cannot picture.
- Two Arc launchpads: Argus (argus.world) and Warp (circlewarp.fun). Their tokens get the badge, a link to the token page, bonding or graduated status, and for Warp the live price, market cap, liquidity and progress to graduation from its own API. Argus is read straight from its Portal contracts, with the launch's name, image and socials when the RPC still has the event. Both appear in the launchpad filters.
- Arc (Circle's chain): tokens called on Arc get their chain, price and market cap (GeckoTerminal lists the network; Dexscreener does not yet), with Arc's badge, label and chain filter. The OpenSea mint window knows the chain (id 5042, USDC gas, checked against the RPC) for when OpenSea lists Arc drops. BasedBot charts work for Arc tokens. No public Arc explorer answered yet, so token explorer links wait.
- OpenSea mint: a drop that has minted out is refused with "Sold out: 3,333 of 3,333 minted" even when OpenSea still lists the public stage as open (the mint would only revert). A quantity past what is left is refused with the number, and a drop OpenSea has paused says why. (Brandzo, Yield Farm.)
## v0.8.15 — 2026-09-15

- Every text box, select and textarea in the app shares one style; the add-column button sits in the bottom-right corner, the same distance in as the Pings pill.
- Secrets at rest, everywhere: a backend run from the repo (`npm start`, or the checkout the desktop app attaches to) used to keep the wallet key, Telegram session and API tokens in plain text in config.json, since only the app's own backend got a sealing key. It now keeps a key of its own in the OS keychain (macOS login keychain, Linux Secret Service, Windows DPAPI) and seals the file on the next start. Nothing changes for the desktop app's own backend.
- The OpenSea Mint column is a guided mint, not a chat: Drop › Amount › Mint across the top; the drop as one panel (supply, floor, schedule, your wallet with a face drawn from its address and what it can still mint); then "How many?" with a stepper capped at your remaining allowance, which quotes the price for that amount; then one button in the foot for the state the mint is in (Mint, Mint when it opens, Look up again). The paste box lives in the foot. Queue and history fold into one line each. Laid out so several wallets slot in later.
- OpenSea mint cards show what the mint page shows: minted so far out of the cap with a bar and how many are left, the floor, and the whole schedule, each stage with its name, when it runs, its price, the per-wallet limit, the allowlist size and whether your wallet is eligible. A wallet that has used up its allowance gets "You have reached your mint limit", the way OpenSea says it.
- OpenSea mint: a real public mint failed with "calldata is shorter than a whole number of words". OpenSea appends a 4-byte attribution tag to the mint calldata (its own site sends it too) and the safety check refused it. The tag is allowed now; every other check on the calldata stays.
- OpenSea mint queue: quoting a drop whose stage you can mint in has not opened yet (a presale you are not on, public in 15 minutes) no longer fails. The card waits with a countdown, quotes itself again the moment the stage opens and pings you. "Mint when it opens" arms it: the mint is sent by itself at the price OpenSea showed for that stage, with gas under the chain's ceiling; dearer than that and it is held for you with a note. The queue survives a restart. The card counts down by the second; a warm-up quote ten seconds before the stage means the armed send goes out about a second after it opens. (Brandzo.)
## v0.8.14 — 2026-09-15

- Rick, Phanes and the other scanner bots no longer count as callers when they answer a contract someone already posted in that chat; existing echoes are dropped on update. A bot that posts a contract first (an alert bot) is still the call.
- Forwards into Discord: a bot's report is laid out as one, with a heading, section headings and the "via" line as subtext instead of one grey quote block; links are proper [text](url) links that do not unfurl, so a Salpha report is not a wall of raw URLs followed by a dozen previews. A lone bare link keeps its preview.
## v0.8.13 — 2026-09-15

- Telegram picker: conversations with bots are listed too (a Bots filter), so a custom alert bot that posts to you can be in the feed like any chat. Bots were left out before. (Asked on Telegram: RH_Rombot.)
- A favorite caller's first call now shows in the Pings panel (👑 called $X, with the chat around it) and has its own sound, a coin, instead of the same chirp as a mention with nothing on screen to match it.
- Forward any Telegram message: a forward button on every row (and in the right-click menu), and "send to chat" under a bot's reports (Salpha research, say). Into a Telegram chat it is a real forward, formatting and media intact. Into Discord it becomes a copy in Discord's own markdown with a small "forwarded from" line, the photo attached, split when it is longer than Discord allows. An optional note goes above it. (Brandzo.)
- Every chat keeps its own recent history (150 messages each) instead of all chats sharing one 500-message window. A few busy chats no longer push the quiet ones out, so switching to another layout shows its columns already filled rather than empty until something new arrives. (Brandzo.)
- Type "/" in any composer and the commands that chat offers appear above the box, the way Discord and Telegram show them. Arrows to move, Enter or a click to send, Tab to fill it in and add arguments, Escape to clear. Discord channels list the server's slash commands (through the plugin, so this needs the Discord setup redone or the next app update); typed as `/chart pepe` they run as real slash commands, with the command's arguments in order. Telegram chats list every bot's commands and send `/cmd@bot` so the right bot answers. Bot columns (Cove, Salpha…) list their bot's commands. (Suggested on Discord.)

- Chat rows: the reply, react and ⋯ buttons are always visible now (faint, full on hover) instead of appearing only when the mouse is over the row.

- Scanner bots feed the first scan. When Rick, Phanes, TokenScan or any bot answers a contract in the same chat within three minutes, its market cap becomes that call's, and the entry when it is the first call; Rick's "You are first @ X" sets the entry outright. The API loops still take over for updates. Suggested by the author, prompted by a wrong entry on $FLY.
- The multiple on a call card now measures from the first call (the entry), not the latest one; each later call's own market cap stays in the hover list. (Reported by yannz.)
- Fix: the "N calls for $X" hover list could not be scrolled — scrolling inside it closed it. (Reported by yannz.)
- Fix: "+ caller's next" on contracts-only columns showed nothing (it read the feed in the wrong order). Also new: "+ caller's previous 0–3". (Reported by Roms.)

## v0.8.12 — 2026-09-15

- Fix: reacting on a reaction you had already set did nothing, or removed a different one. The page now knows which reactions are yours (Telegram marks them, Discord says who reacted), so clicking your own reaction removes it and clicking another adds it, with the server's answer winning after a moment. (Reported by Brandzo.)

- Fix: Telegram pictures (groups, channels and people) showed as initials since 0.8.11: the avatar lookup had been narrowed to a cache that does not answer for them. The normal lookup is back; it was never the source of the flood, the dialog list was, and that is cached now.

## v0.8.11 — 2026-09-14

- Desktop: an older backend left behind by the previous version is replaced automatically at launch, no dialog. Before, a dialog asked about "attaching", and attaching to the old one showed an old page with features missing. Only if the old copy refuses to close does the app say so, in plain words. A newer backend (a dev checkout ahead of the app) is used as before.

- Share: an optional message goes out above the address, the same to every chat you pick. (Suggested by Brandzo.)
- Contracts-only chat columns can keep the caller's next 1–3 messages after a call, so the thesis shows with the contract. Column editor → Message filter → Contracts only → "+ caller's next".

- Calls count per caller per chat. A different person posting a contract in a chat that already called it is a new call: the 🔥 count goes up and the card moves to the top. The same person re-posting stays a repeat. (Before, a second caller in the same chat was ignored, so cards sat at 3× while people kept calling.)
- TrenchTogether: a chat both machines watch no longer shows every call twice on the follower, and the 🔥 count is no longer doubled.
- Fix: Send on Telegram could take minutes. Telegram flood-limits `GetDialogs` hard, the app fetched it on every page load, and gramJS also fell back to it when resolving a chat for a send. The dialog list is now cached for a minute with one shared request, and avatars never trigger that fallback.

- TrenchTogether: reconnects in seconds instead of up to a minute after the host restarts, a Reconnect button and re-pasting a pairing dial again at once, the peer row says why a connection failed, and link-local 169.254 addresses are no longer offered as pairings.

- Settings shows the app version with a **check for updates** button (desktop), the same check the app menu runs.

## v0.8.10 — 2026-09-14

- **TrenchTogether** (⚙ → Together): share your calls with a friend on the same network or VPN. Turn on sharing, send them the pairing string, and your calls show in their feed tagged "via you"; only the call travels (token, caller, chat name, market numbers), never a chat message. Their machine skips the API lookups for tokens you keep fresh, so two machines on one connection stop fighting over the same rate limits. Sharing opens one extra port (3211) on the LAN that serves only that stream to a paired peer; the rest of opentrench stays on 127.0.0.1.

- GeckoTerminal's 30-a-minute allowance is per public IP, so two machines on one connection share it. After a 429, charts and the call-price backfill now stand aside for a minute so the market refresh keeps the budget; fresh tokens resolve first, candles catch up after.

## v0.8.9 — 2026-09-14

- The + picker's Telegram list has filters: All / Groups / Channels / DMs, and "in feed" for what you already watch, each with a count. For accounts with a ton of chats.

- Calls: a card you mark as seen (the ✓) folds to one line — symbol, chain, 🔥count, caller, MC, multiple, age — so more coins fit on screen and what you already looked at is obvious at a glance; the chevron peeks at the full card, the ✓ unfolds it. A new eye button hides a card from the calls columns while the token keeps being tracked (trending, callers, repeat counts); the column header shows "N hidden" to reveal or unhide them. Suggested by a user.

- Fix: call market caps read from candles were the *other* asset's price for tokens on the quote side of their pool (an entry of $1.6 trillion, every multiplier 0.0x): GeckoTerminal returns the pool's base token unless the token is named, and now it is, for the backfill and the drill-down chart alike. On first start every candle-derived value is sent back to be re-read, and values wildly off the current market cap are dropped rather than shown. Reported with the exact repro by a user, thank you.

## v0.8.8 — 2026-09-14

- Fix: Set up Discord on a Mac explains when macOS App Management blocks it and offers to open that settings pane; Discord is reopened if the install cannot proceed.
- Fix: Set up Discord failed with "ENOENT, not found in app.asar": the desktop shell reads Discord's app.asar through Electron's archive-aware file system; it now uses the plain one.

## v0.8.7 — 2026-09-14

- Fix: a Telegram group without a photo showed a broken image in the rail; it shows its initials now, like a Discord server without an icon.

- Long (app.long.xyz): a call for a Long token shows the Long badge with what it is anchored to ("anchored to NVDA"), and Long is in the launchpad filter. Reads Long's own indexer, unofficially.

- Desktop: **Set up Discord** in one click (⚙ → Accounts → Discord, the first-run guide, or the app menu). The app quits Discord, installs its own copy of Vencord with the opentrench plugin switched on, and reopens Discord; no git, Node or pnpm. An existing Vencord is replaced by the same Vencord plus the plugin, settings kept; "remove the plugin" puts Discord's original files back. The plugin build ships inside the app (electron/scripts/build-vencord.sh, GPL-3 notice included).
- First-run guide: a three-step checklist (Discord, Telegram, channels) when nothing is connected yet, reachable again from ⚙ → Accounts.
- Call market caps are corrected after the fact: a call lands with the number the app had cached; once the 1-minute candle for that minute has closed, the real market cap is read from the pool's candles and the entry (first call) moves with it. Multipliers and the "N calls for $X" hover reflect the price at the call, not at the next refresh.
- Filters: "Multiplier" is now "MC since first call", grouped with "Times called" under Calls, so nobody reads it as a call count again.
- A Claude skill for onboarding (skills/opentrench-setup): install, connect Discord and Telegram, add channels, and the known failure modes.

- Onboarding: Enter submits the account forms (Discord token, Telegram credentials, phone, code, password); the Telegram tab links straight to my.telegram.org/apps; the search box in the + picker now narrows the Discord server rail too, not only the channels of the selected server; the getting-started guide says which installer file is which.

- Trending column: the ten most-called tokens in the last 5m, 1h, 6h or 24h, ranked by calls then recency, with the entry market cap (at the first call), the current one, the multiplier and the last call. The header switches the window; hover a row for the calls behind it, click to open the token. Suggested by Brandzo, after the Discord leaderboard he built.

- Click a message in a column that follows several chats (All Chats, a server) and the message box switches to that chat. Just the chat, not a reply. A reply you had pending for a different chat is dropped, since the click is the newer intent; one for the same chat stays.

- Cove buy buttons on Ink tokens (chain code i, confirmed against Cove's own panel).

- Ink tokens get their explorer link and chain badge, and the calls / chat column chain filter now lists Ink, MegaETH, Plasma, Story and Stable. Token cards use the one chain-label table the rest of the app uses, so newer chains read INK, MEGA, XPL and so on instead of a truncated id.

- Fix: clicking a photo in a chat opened it twice — the lightbox, and the image again in a second window (the photo is also a link, and the click followed it). Same for the image on a link preview, which also opened the linked post. A click now opens the lightbox only; right-click and drag on the photo still give you the link.

- Market caps are live-er: tokens called in the last hour refresh every 10 seconds (Dexscreener only), everything from the last 24 hours every minute as before, and chains are queried in parallel so one slow chain no longer holds the rest back. Opening a token's chart refreshes it on the spot. Tokens whose network was never resolved used to be skipped for good; they are now looked up chain-less each minute and pick up their network when Dexscreener lists the pair.

## v0.8.6 — 2026-09-14

- Desktop: tokens, sessions and the mint wallet key in config.json are now encrypted with a random key the app keeps in the OS keychain (Keychain on macOS, DPAPI on Windows). An existing plain-text config is sealed on first launch. A backend started from the repo has no key: it treats sealed values as unset and leaves them on disk.
- Robinhood Chain explorer links open on robin.etherscan.io instead of Blockscout.
- The buy links' referral code is opentrench's own and fixed in the code; the README now says so and why (referral payouts help cover development costs; they change nothing about your price or fees).
- Dependencies: qs (under express) bumped past two moderate advisories.

## v0.8.5 — 2026-09-13

- Website columns have a ⟳ in the header that reloads the page, for a page that went blank or turned into Chromium's sad face.
- Desktop: a log of what the app shell does, including any renderer or helper process Chromium loses and why, in the app's log folder (desktop.log). Open Log Folder in the app menu (File on Windows) takes you there. Please attach it when reporting a blank or crashed Website column.

## v0.8.4 — 2026-09-13

- Every Discord, Telegram and bot link stays in the app. A message link scrolls the chat to that message (or opens the chat when the message is no longer in the feed), a channel or group link opens it (focused if you watch it, a preview otherwise), and a bot link drives that bot's column, creating one for a bot you have not got a column for. That covers links in message text, embeds, call cards, the calls list and time stamps. Hold ⌘/Ctrl while clicking to open one in the browser anyway; invite links still open outside.
- Call cards: click the chat name on a card, or a row of the "N calls for $X" list, to scroll the chat to the message that made the call (it flashes). A call that has aged out of the feed opens the original in Telegram or Discord instead.
- Fix: J7 tweets showed broken image tiles (the feed now sends media as objects; their urls are read instead of the object being stringified).
- Fix: a big Telegram supergroup (thousands of members) showed only your own messages and replies to you. Telegram does not push such a group's messages to a client at all; its own apps poll the group's difference while the chat is open. opentrench now does the same for every watched supergroup: a group Telegram has proved it will not push is asked every 2 seconds, the rest every 30 as a safety net, and Telegram's flood limits are honoured.
- Telegram bot column: any bot you talk to, as a column, with its buttons — Cielo's wallet tracker (@evmtrackerbot) is a preset, Custom takes any bot username.
- Fix: removing every column no longer brings All Calls and All Chats back, and adding one column to an empty terminal no longer adds the two defaults with it. An empty terminal stays empty until you add a column or pick a layout.
- Layouts menu: a save icon on each saved layout writes the current columns over it (no retyping the name), and "Clear all columns" at the bottom closes every column at once, after a confirm. Switching layouts also resets the feed scope to all channels instead of leaving it on whichever server was selected.

## v0.8.3 — 2026-09-13

- **Zoom one column.** Hold Ctrl (⌘ on a Mac, or pinch on a trackpad) and scroll over a column to scale just that column's content, 50%–150%, remembered per column. A chip in the column header shows the level and resets it on click. The page and the other columns stay as they are.
- The message boxes under Chats, the bot panes and the mint window line up: one 34px row, same control heights and gaps, and no blank footer line under the chat box when there is nothing to say.
- Header: the Discord and Telegram connection pills are their logos now, green / amber / red by state, with the words in the tooltip. The Layouts button uses a proper icon (lucide) instead of a text glyph.
- **Layouts.** Save the column terminal as a named arrangement and switch between them from the Layouts button in the header: every column's channels, splits, widths and filters come along, so a calls-and-chats setup and an NFT setup are one click apart. Saving under an existing name overwrites it; the menu marks the layout that matches what is on screen and warns before switching away from an arrangement you have not saved.

## v0.8.2 — 2026-09-13

- Fix: a MintGo (or any newer) column could turn into a chat column. When the desktop app starts it attaches to a backend already listening on its port; a backend left running from an older checkout doesn't know the newer column types and rewrites them to Chats on every save. The app now checks the running backend's version and offers to quit instead of attaching to a different build.
- OpenSea Mint: a failed or confirmed card has a Dismiss button, and a failed one also offers Quote again. A mint that is still sending or pending stays until the chain answers, since it holds the wallet's one-mint-at-a-time guard.
- Fix: a narrow (or zoomed-in) chat column lost its title — the header's hidden / repeats / media toggles and buttons never shrank, so the title was squeezed to nothing. It now ellipsizes instead, narrow columns get tighter header chrome, and in message rows the author name gives way before the timestamp wraps.

## v0.8.1 — 2026-09-13

- Charts in chat can stay collapsed: with ⚙ → Feed → "Live charts in chat" off, every contract under a message keeps its one-line stats and gets a ▾ chart bar that opens the live chart in place; ▴ folds it back. With the setting on, the same bar collapses a chart you don't need right now.

## v0.8.0 — 2026-09-12

- New column: **MintGo**. NFT mints on Ethereum, Robinhood Chain and Ink as they happen, straight from mintgo.fun's live feed: collection, quantity, price, minter and supply on each card; click one for its X, OpenSea and website links, the transaction, the deployer's history, and a Mint button. Filter by chain or minimum quantity in ✎. A mint whose price isn't confirmed yet says "price pending".
- New column: **OpenSea Volume**. OpenSea's Trending or Top collections with floor, volume, sales and floor change, and a 1H / 1D switch in the header. Rows open the collection; a collection with an open SeaDrop stage gets a Mint pill.
- New column: **OpenSea Mint**. Paste a collection (slug, link or address) or press Mint anywhere: the card shows the open stage, your allowance, price, gas and balance; Mint asks once more, then sends with the wallet from ⚙ → Trading. Cards go sent → pending → confirmed with the minted ids and explorer links. ERC-721 SeaDrop drops only, one wallet, one mint in flight at a time, gas capped per chain, and the transaction is refused if OpenSea's price or contract differs from the quote.
- ⚙ → Trading → OpenSea mint wallet: the key for the mint column (use a dedicated wallet; it is stored in config.json on this machine) and RPC endpoints per chain (https only, or a local node).

## v0.7.0 — 2026-09-12

- Website columns: pages inside a column can use the clipboard, so their copy buttons (a contract address, say) work instead of reporting the clipboard unavailable. Cross-origin frames get no clipboard access unless the host grants it; the column now does.
- The Add/Edit column dialog keeps one size whatever type you pick (bot types used to shrink it), and the type picker is a grid of cards, each with an icon, its name and a line on what it shows.
- Right-click a message for its menu: a strip of quick reactions, Reply, jump to the message it answers, open its chat, copy the text, copy or open the original link on Discord or Telegram, and the token menu (open, buy, research, copy) for any contract it mentions. A contract address keeps its own right-click.
- Fix: a column could not be dropped onto a Website column (or stacked under it). The embedded page swallowed the drag, so only the header strip accepted a drop. Embedded pages and chart embeds now ignore the pointer while a column is being dragged.
- Website columns come with two ready picks, MintGo (mintgo.fun) and Smart Money (smartmoney.sh), plus Custom for any address. Picking one fills the title; a typed title stays.

## v0.6.1 — 2026-09-12

- Fix: some sites in a Website column loaded their shell and then hung (mintgo.fun sat on "Loading…"). Inside a frame, Chromium withholds a site's own session cookies unless they are marked SameSite=None, so the site's realtime connection had no session. The desktop app now marks cookies set inside embedded pages that way, and those sites work like they do in a browser tab.

## v0.6.0 — 2026-09-12

- Split a column in two. Drag a column by its grip over another one: a translucent box shows where it lands, the front half to move in ahead of it, the lower half to stack underneath, sharing its width. Drag the divider between the pair to change the split, double-click it to even out, drag the stack's right edge to resize the pair. Either half can be dragged back out onto any column's front half to be a full column again. One level only. Removing the top hands its slot to the bottom; removing the bottom just unsplits.
- New column type: Website. Paste any address and the page lives inside the column like a browser tab; the ↗ in its header opens it in your real browser. Sites that forbid embedding (X-Frame-Options, frame-ancestors) still load in the desktop app, which drops those refusals for embedded pages only.
- DMs are chats now. Telegram private chats (people, not bots) and Discord DMs and group DMs show up under + → add chats, with a Direct Messages entry on the rail, so a column can be scoped to one person on either platform. Sending, reactions and pings work the same as in any chat. Discord DMs need the plugin rebuilt (vencord/README.md), since the client is what lists them.

## v0.5.1 — 2026-09-12

- Fix: the reaction picker vanished as soon as you moved the mouse over it. Two CSS rules fought over its position and left the box 14px tall with the emoji drawn outside it, so crossing any gap between emoji counted as leaving. The picker now sizes to its contents below the ☺+ button and closes on an outside click or Escape, like the other menus, instead of on mouse-leave.

## v0.5.0 — 2026-09-12

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
