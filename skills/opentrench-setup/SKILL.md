---
name: opentrench-setup
description: Use when someone is installing opentrench, connecting Discord or Telegram to it, adding channels, or when the desktop app shows a red discord/telegram pill, "backend did not come up", a blank column, or a plugin that will not connect. Walks through the exact steps for macOS and Windows and the known failure modes.
---

# opentrench setup

opentrench is a desktop app (Electron) with a local backend on 127.0.0.1:3210. It reads the
user's own Discord and Telegram accounts. Nothing needs installing besides the app itself,
except the Discord plugin step below.

## 1. Install the app

Send the user to https://github.com/frogeth/opentrench/releases/latest and tell them which
single file to download:

| Machine | File |
| --- | --- |
| Mac, Apple Silicon (any Mac from 2020 on) | `opentrench-x.y.z-arm64.dmg` |
| Mac, Intel | `opentrench-x.y.z.dmg` (no `arm64` in the name) |
| Windows | `opentrench-Setup-x.y.z.exe` |

Apple menu → About This Mac says "Chip: Apple M…" (Apple Silicon) or "Processor: Intel…".
Ignore `.zip`, `.blockmap` and `.yml`. Windows shows "Windows protected your PC" once: More
info → Run anyway. The app updates itself afterwards.

Do NOT walk a non-developer through `npm install`; that is the from-source path and the
usual source of "npm missing", "make missing" and dependency errors.

## 2. Connect Discord

Discord connects through a Vencord plugin inside the user's own Discord app, so no token is
pasted or stored. Discord must be open for that side of the feed to work.

Preferred: in opentrench, ⚙ → Accounts → Discord → **Set up Discord**. The app quits Discord,
installs its bundled Vencord (with the opentrench plugin enabled) and relaunches Discord. The
`discord` pill turns green within a few seconds.

If the button is missing or fails (Discord installed somewhere unusual, or a permissions
error), the manual route is https://opentrench.app/docs/discord/ (git + Node + pnpm, clone
Vencord, copy `vencord/opentrench-bridge` into `src/userplugins`, `pnpm build`, `pnpm inject`).

Known failure modes:
- "macOS blocked the change (App Management)": macOS gates edits to other apps' bundles.
  System Settings → Privacy & Security → App Management → switch on opentrench, press Set
  up Discord again. The dialog in the app offers to open that pane.
- Pill stays red: Discord is not running, or the plugin is disabled (Discord → User Settings →
  Vencord → Plugins → OpentrenchBridge), or it points at a different port than the backend.
- Discord updated itself: on macOS an update replaces the app bundle and removes the
  injection. Run Set up Discord again.
- "Discord is not installed" from the button: only /Applications/Discord*.app (macOS) and
  %LOCALAPPDATA%\Discord* (Windows) are searched.

A user token still works as a read-only fallback (⚙ → Accounts → Discord → token). Say plainly
that it is a self-bot and carries ban risk.

## 3. Connect Telegram

Telegram uses the user's own account through Telegram's official API. It needs an API ID and
hash, which take a minute:

1. https://my.telegram.org/apps, log in with the phone number and the code Telegram sends.
2. Fill any app title and short name, Create application.
3. Copy App api_id (a number) and App api_hash (a long string).
4. opentrench ⚙ → Accounts → Telegram: paste both, Enter or Save credentials.
5. Phone number in international format (+15551234567) → Send code. The code arrives in the
   Telegram app, not by SMS. Enter it; then the two-step password if the account has one.

Failure modes: "PHONE_NUMBER_INVALID" (missing country code), "FLOOD_WAIT" (too many
attempts, wait the stated seconds), a code typed with spaces.

## 4. Add channels and columns

The **+** in the left rail lists every Discord server/channel and Telegram chat; **+ add**
puts it in the feed, the eye previews it. The search box narrows servers, channels and chats.
Columns (All Calls, All Chats, Trending, Top Callers, Website, bots…) are added with the + in
the column header row; each column has its own channel scope and filters.

## Where things live

- macOS: config and state in `~/Library/Application Support/opentrench/` (`config.json`,
  `state.json`; tokens inside are encrypted with a key in the Keychain). Logs:
  `~/Library/Logs/opentrench/desktop.log` and the app menu's Open Log Folder.
- Windows: `%APPDATA%\opentrench\` and the same Open Log Folder entry in the File menu.
- The backend answers on http://127.0.0.1:3210 (`/api/version` shows the build).

## When the app says "backend did not come up" or attaches to an older build

Another opentrench backend is already listening on 3210 (a stale process, or one started from
a source checkout). Quit it and reopen the app. The app refuses to attach to a backend from a
different version and says so in a dialog.
