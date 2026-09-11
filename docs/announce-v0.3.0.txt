# opentrench v0.3.0 — no more Discord token, and we have a website

Big one. Two things changed: how opentrench connects to Discord, and where you go to set it up.

**Why this happened**
Someone in here caught a Discord ban. opentrench used to sign into Discord with your account **token** — a "self-bot". That is exactly what Discord's anti-abuse looks for, and sending messages that way is the loudest signal. So it had to go.

**What it does now**
opentrench talks to Discord through a tiny plugin that runs **inside your own Discord app** (via Vencord), the same way BetterDiscord/Vencord plugins work. Your real client does the reading and sending, so to Discord it is simply *you* using Discord. **No token, anywhere.** Nothing to paste, nothing stored.

> One trade-off: Discord has to be open for the Discord side of the feed to work. Telegram is unchanged.

**If you already used a token**
Nothing breaks. Your feed keeps reading, **read-only** — sending and reactions with a token are gone (that was the risky part). Switch to the plugin whenever you like; the app shows a one-time note explaining it, and once the plugin connects the token session closes on its own.

**New: __opentrench.app__**
A proper site with a landing page and full **step-by-step setup for Mac and Windows** — the Discord plugin, Telegram, everything.
→ **https://opentrench.app**
→ Setup guide: **https://opentrench.app/docs**

**Also in this release**
- Chat and J7 columns **hold your place** — scroll up and new messages stop yanking you around
- **Paste or drop images** into any chat to send them
- **Share button on J7 tweets** — send a tweet to any chat in your feed
- **Click any image** to view it full size

**Get it**
Download / update: **<https://github.com/frogeth/opentrench/releases/latest>** (the app also auto-updates)
Questions or stuck on setup? Drop them here. 🐸
