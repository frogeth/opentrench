**Welcome to opentrench** 🟢

opentrench is a terminal for the trenches: it turns the Discord servers and Telegram chats you're already in into one live feed. Every contract anyone posts becomes a call card with price, market cap, holders, launchpad, live chart, one-click Cove buys, and the history of who called it and at what cap. It runs on your own machine with your own accounts. Nothing leaves your computer except the requests to Discord and Telegram themselves.

**Download:** <https://github.com/frogeth/opentrench/releases/latest>
Mac (signed, just open it) · Windows (click "More info → Run anyway" once). It updates itself after that.

⚠️ **Heads up:** the Discord side uses your *user token* (a self-bot). That's against Discord's ToS and can get an account banned. Use an alt if that worries you. Telegram uses the official API and is fine.

──────────

**Connect Discord (2 minutes)**
1. Open Discord in a **browser**: <https://discord.com/app>
2. Press **F12** → **Network** tab.
3. Click any channel, then click any request called `messages` or `science`.
4. Under **Request Headers** find **`authorization`** — that long string is your token. Copy it. (It should *not* start with `Bot`.)
5. In opentrench: **⚙ → Accounts → paste → Save & connect.** The `discord` pill goes green.
Never share that token. It's your password in another form.

**Connect Telegram (3 minutes)**
1. Go to <https://my.telegram.org>, log in with your phone.
2. **API development tools** → any app title (e.g. `opentrench`) → **Create application**.
3. Copy **api_id** and **api_hash**.
4. In opentrench: **⚙ → Accounts → Telegram** → paste both → **Save credentials**.
5. Phone number with country code (`+1555…`) → **Send code** → the code arrives in your Telegram app → **Submit code** → 2FA password if you have one.
Stays logged in across restarts.

**Add channels**
Round **+** at the bottom of the left rail → pick Discord or Telegram → tick what you want. Click a name to preview it first. Each server/chat becomes an icon in the rail; drag to reorder, ★ takes you back to everything.

──────────

**Reading the terminal**
• **All Calls** — one card per token, newest first. Caller, channel, gold **1st** or 🔥 count, MC at call and the multiplier since; then image, symbol, V/MC, age, address (click = copy), ATH, links, holders, buy/sell bar; then holder security (top 10, dev, insiders, LP lock, **DS** = dev sold).
• **All Chats** — the raw messages, read bottom-up, every contract turned into a token strip with a live chart.
• **Hover** the 🔥 count for every caller, the globe for a site preview, the X icon for the profile, the bar for exact buys/sells. **Click a token image** for the drill-down: candles on a market-cap axis with every caller pinned, plus the full call list.

**Make it yours**
• **Columns** — the **+** on the right adds a column: calls, chat, or **Top Callers** (ranked by median multiplier), over all channels or a few. Grip to reorder, right edge to resize, pencil to edit, × to remove. Saved automatically.
• **Alerts** — bell in a column header = sound on every new call there. Eight tones to pick from in the column's edit dialog.
• **Favorites** — ⋯ next to a name → **Favorite caller**. Crown, plus a ping (sound + desktop notification + optional message to your own Telegram Saved Messages) on their first calls.
• **Bots** — ⚙ → Feed → Bots to show or hide any bot the feed has seen. Scanners and buy-bots are hidden by default; alert webhooks show.
• **Trading** — ⚙ → Trading sets your Cove quick-buy amounts.

**If something's off**
• `discord: auth_error` → token wrong or expired; copy it again.
• `telegram: needs_login` → session ended; do Send code again.
• Empty feed → you haven't added channels yet.
• No sound on the web version → click anywhere once; browsers block audio until you do. The app has no such rule.

Questions, bugs, ideas → post here. GitHub: <https://github.com/frogeth/opentrench>
