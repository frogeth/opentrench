# opentrench bridge (Vencord plugin)

Connects opentrench to **your running Discord client** instead of a separate
self-bot session. No token is ever pasted, stored, or sent. Reads come from the
client's own event stream; sends and reactions are performed by the client's
own functions, so to Discord it is simply you using Discord.

Discord must be open (and Vencord loaded) for the Discord side of the feed to
work. Telegram is unaffected.

## Install

Vencord loads third-party plugins only from a source build, so this is a
one-time developer-style setup (about 5 minutes):

1. Install [git](https://git-scm.com/), [Node.js 20+](https://nodejs.org/) and
   [pnpm](https://pnpm.io/installation).
2. Get Vencord's source and dependencies:
   ```bash
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
3. Copy this folder into Vencord's user plugins directory:
   ```bash
   mkdir -p src/userplugins
   cp -r /path/to/opentrench/vencord/opentrench-bridge src/userplugins/
   ```
4. Build and inject into your Discord install (pick your Discord flavour when asked):
   ```bash
   pnpm build
   pnpm inject
   ```
5. Fully quit and reopen Discord. Open **User Settings → Vencord → Plugins**,
   enable **OpentrenchBridge**. If you run opentrench on a port other than
   3210, set it in the plugin's settings.

Back in opentrench, the `discord` pill in the top bar turns green as soon as
the plugin connects. Add channels to your feed from the **+** button as before.

## Update

Pull opentrench, copy the folder again, run `pnpm build` in the Vencord
checkout, and restart Discord. Vencord itself updates the same way
(`git pull && pnpm install && pnpm build`).

## What it does, exactly

| direction | what |
| --- | --- |
| client → opentrench | who you are, your servers/channels/roles; new messages, edits, deletes, reactions from the channels you watch |
| opentrench → client | send a message (optionally as a reply), add/remove a reaction, fetch a channel's recent history, refresh the channel list |

The socket is `ws://127.0.0.1:<port>/bridge`. The backend only accepts it from
the Discord client's origin.
