# opentrench bridge (BetterDiscord plugin)

The same bridge as the [Vencord plugin](../vencord/), for people who run
[BetterDiscord](https://betterdiscord.app). It connects opentrench to **your
running Discord client**: no token is pasted, stored or sent, and sends and
reactions go through the client's own functions.

The bridge logic lives in `../vencord/opentrench-bridge/core.ts` and is shared
by both plugins; `index.ts` here only finds Discord's internals through
`BdApi` and keeps the port setting.

## Install

The desktop app does it for you: ⚙ → Accounts → Discord → **Set up Discord**,
then pick BetterDiscord.

By hand: download `OpentrenchBridge.plugin.js` from the
[latest release](https://github.com/frogeth/opentrench/releases/latest), put it
in BetterDiscord's plugins folder (User Settings → BetterDiscord → Plugins →
Open Plugins Folder) and switch **OpentrenchBridge** on. If opentrench is not on
port 3210, set the port in the plugin's settings.

## Build

```bash
node betterdiscord/build.mjs            # → betterdiscord/dist/OpentrenchBridge.plugin.js
```

`electron/scripts/build-betterdiscord.sh` runs this and adds the pinned
BetterDiscord release the desktop app ships.
