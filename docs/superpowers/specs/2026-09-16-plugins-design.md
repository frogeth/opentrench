# Plugins — design

Date: 2026-09-16. Status: approved in conversation, awaiting spec review.

## Goal

Let people extend opentrench with code they write and share: pull a website's feed into the app as a chat, transform feed data, or draw a custom column. Plugins must keep working across app updates, and installing one must never silently hand over the user's sessions or keys.

## Decisions made

1. **Sandboxed plugins with an API**, not raw script injection. Each plugin runs in its own sandboxed iframe on a separate origin and talks to the app only through a versioned postMessage bridge (`ot`). It cannot reach the app page, cookies, the backend API, or the keychain.
2. **Frontend-only plugin code.** No plugin code runs inside the Node backend. Network access goes through a backend fetch proxy.
3. **Site sign-in handled by the app.** A plugin's manifest lists the sites it wants to use with the user's login. The app opens the site's own sign-in page in an app window and keeps that session in a partition per site. Proxy requests to those hosts carry that partition's cookies; the plugin never sees them.
4. **One JS file per plugin**, manifest at the top, code below. Easy to post, easy to read before trusting.
5. **Plugin output becomes real feed items** (messages with source `plugin`), so contracts, calls, trending, filters and forwarding all apply (pings do not: a plugin names its own author). A plugin may also draw its own column; that is the fallback for things that are not messages.

## The plugin file

```js
export const manifest = {
  "id": "example-feed",
  "name": "Example feed",
  "version": "1.0.0",
  "api": 1,
  "sites": ["https://example.com"],
  "permissions": ["feed:write", "storage", "actions"],
  "ui": false,
  "description": "Posts example.com alerts into the feed as a chat."
};
export default function main(ot) {
  // runs once per enable / app start; may return a stop() for cleanup
}
```

Fields: `id` `[a-z0-9-]`, unique, the folder-safe key; `api` the opentrench plugin API major version; `sites` the hosts the plugin may fetch through the user's login; `ui` true when the plugin draws a column.

The manifest block must be valid JSON (quoted keys, no comments, no trailing commas). The app extracts it from the file as text with a bounded search for `export const manifest =` up to the matching `};` and parses it with `JSON.parse`, so nothing in the file runs before the user has seen the manifest.

## Where plugins live

A `plugins` folder next to the config file:

- built app: `~/Library/Application Support/opentrench/plugins` (and the platform equivalents);
- a checkout running the backend on its own: `backend/plugins`, listed in `.gitignore`.

Adding or removing a file in the folder is enough; Settings has a Reload button. Installed plugins are also addable from the app (file picker or URL) and are copied into the folder.

## Trust model

- A plugin is off until the user enables it. Before the first enable a dialog shows the manifest in plain words (what it can post, which sites it will use your login on, which permissions) and the warning: this is code from someone else; it can post anything into your feed and use your logins on the sites listed; read the file before you trust it; opentrench cannot check it for you.
- Approval is bound to the file's SHA-256. A changed file is disabled until re-approved.
- Every plugin column header tooltip carries "runs code you installed".
- Permissions are enforced on the app side of the bridge, never inside the iframe.
- **Nothing a plugin asks for moves money on its own.** `actions.buy` and `actions.research` are "ask the user" hooks: the host raises a confirmation bar naming the plugin and the address — "<Plugin name> wants to open a buy for 0xabc… [Open] [Ignore]" — and only the user's click sends anything to a bot. A plugin can put a buy in front of you; it cannot take one.
- `actions.copy` is allowed but never silent: the host toasts "copied by <plugin name>: <first 24 characters>", because an unannounced clipboard write is how a pasted address gets swapped.
- `actions.notify` titles are prefixed with `[<plugin name>]` by the router, so a plugin's notification cannot pass for the app's own.
- `ot.sites.signIn` stays available — the sign-in window is visible and the user drives it — and the host loop rate-limits every plugin call (a per-plugin budget, args capped at 256 KB serialized).
- The approval dialog says it plainly: a plugin can read every message in your feed, fetch any host, and with `actions` write your clipboard and open buys for you to confirm. **The messages the feed hides are the one thing it never sees** — not through `feed.messages`, not through `onMessage`.
- Rate and size caps on `feed.post` (per plugin per minute, per message) so a runaway plugin cannot flood the feed.
- A plugin that throws is stopped and shown as errored; the app stays up.

## The `ot` API (major version 1)

All calls are async and return promises. Objects are the same shapes the app uses (`FeedMessage`, `TokenInfo`).

Feed, read (enabled plugins):
- `ot.feed.onMessage(fn)`, `ot.feed.onToken(fn)` — subscriptions; return an unsubscribe.
- `ot.feed.messages({ chat?, limit? })`, `ot.feed.tokens()`, `ot.feed.token(address)`. Messages come back **newest first**, as the feed itself is ordered; `chat` matches a chat name or a chat id; `limit` defaults to 100 and caps at 500. Messages the feed hides (blacklisted authors, bots the bot policy refuses) are never returned, and never pushed to `onMessage` either: what you have told the app you do not want to see is not a plugin's to read. `token(address)` is an own-property lookup: `constructor` and the like are misses, not inherited members.

Feed, write (`feed:write`):
- `ot.feed.post({ id, chat, author, text, ts?, avatar?, link?, attachments? })` — a message from chat `chat` (the plugin's own chat name; the app keys it as `plugin:<pluginId>:<chat>`). `id` is the plugin's own stable id for de-duplication. Landing in the hub means contract detection, enrichment, calls, trending, filters, forwarding — but never a ping: a plugin picks its own author name, so its messages neither mention the user nor count as one of their favourite callers. The first post to a chat adds that chat to the watch list; a `chat` whose name is already that of a watched Discord or Telegram chat (compared trimmed and case-insensitively) is refused with 'that chat name belongs to a chat already in your feed', because the via tag says who posted a message and cannot unsay whose chat it is in.
- `ot.feed.patch(id, { text?, attachments? })`.

Network:
- `ot.fetch(url, init?)` — backend proxy. Hosts in `sites` are fetched with that site's session partition (cookies attached by the shell); other hosts plain. Returns `{ status, headers, truncated, text(), json() }`. Bodies are capped at 4 MB and `truncated` says whether this one hit the cap. Response headers are an allow-list (content-type, content-length, etag, last-modified, link, retry-after, location, cache-control, date, `x-ratelimit-*`); cookies never reach a plugin, and on the shell path `authorization`, `origin` and `referer` from the plugin are dropped as well. `method` is GET/POST/PUT/PATCH/DELETE/HEAD — anything else is refused rather than sent as a GET, and a GET or HEAD carrying a body is refused too, in the same words at both layers. A fetch to a site the plugin declared fails outright when the desktop app is not connected, rather than going out without the login.
- `ot.sites.status(site)` → `{ signedIn: boolean }`; `ot.sites.signIn(site)` opens the sign-in window.

UI (`ui: true`):
- `ot.ui.root` — the iframe body, with the app's theme variables and base styles injected.
- `ot.ui.setTitle(text)`, `ot.ui.setSubtitle(text)`, `ot.ui.badge(count | null)`. An empty title or subtitle clears it; a badge is clamped to a whole number 0–9999, and `null` (or nothing at all) clears it.

Actions (`actions`):
- `ot.actions.openToken(address)`, `jump(messageId)`, `buy(address)`, `research(address)`, `copy(text)`, `notify(title, body)`.
- `openToken`, `buy` and `research` take a contract address and nothing else — EVM `0x` + 40 hex, or base58 32-44 — because the confirmation bar shows the user what the plugin passed. A plugin that could pass a sentence could write the bar's text.
- `buy` and `research` do not act: they ask. Each raises the host's confirmation bar, and the user's click is what reaches a bot. `copy` writes the clipboard and the host toasts who did it. `notify` gets `[<plugin name>]` in front of its title. See the trust model.

Storage (`storage`):
- `ot.storage.get(key)`, `set(key, value)`, `remove(key)` — per plugin, in the backend state file. `get` is an own-property lookup, so a key like `constructor` reads back as null rather than reaching through the object.
- `ot.settings.schema([{ key, label, type: 'text' | 'number' | 'toggle' | 'secret', default? }])` and `ot.settings.get()` — a small settings form rendered in the Plugins tab. Both need the **`storage`** permission: a form and the answers to it are the plugin's own stored data, kept in the same file as its storage bag. At most 20 fields and 16 KB in all; a key is a string, 1–40 of `[a-z0-9_-]`, must not be `__proto__`, `constructor` or `prototype`, and must not repeat; a label is at most 60 characters; a `default` is text, a number or true/false. Anything else is refused whole, so a half-valid form is never shown. The form a plugin declares is kept in the plugins state file, so the Plugins tab can show it while the plugin is switched off or waiting to be approved. Secrets are **not** sealed yet: they sit in that state file in plain text like the rest of a plugin's data, and the form says so under it. Sealing them the way the app's own config secrets are sealed is deferred.

Lifecycle and logging:
- `main(ot)` runs at enable and at app start; an optional returned `stop()` runs on disable, reload, or app close.
- `ot.log(...args)` — the plugin's log panel in Settings.

## Compatibility promise

- The `ot` API is append-only within a major. Renaming or removing anything means `api: 2`, and the app keeps serving `api: 1` plugins.
- The app refuses a plugin whose `api` major is higher than it knows, with a clear message.
- The message and token shapes seen by plugins are the app's public types; changing them in a plugin-visible way requires a version bump. This rule goes into the repo's contributor notes so future work respects it.

## Where plugins show in the app

- **Column editor**: a **Plugin** type card. Picking it lists enabled plugins with `ui: true`; the column body is that plugin's iframe. Standard header controls apply.
- **Add-channels picker**: chats created by plugins appear under a **Plugins** group with the plugin's icon; adding one works like adding a Telegram group.
- **Messages** from plugins show a small "via <plugin name>" tag by the chat name.
- **Layouts** that reference a plugin chat the user lacks show "plugin not installed" instead of breaking.
- **Settings → Plugins**: installed list (name, version, permissions, sites, enabled, error), approve dialog, enable/disable/remove, Add plugin (file or URL), Reload, per-site sign-in status and Sign in button, each plugin's settings form and log panel.

## Internals

Backend (`backend/src/plugins.ts`, routes under `/api/plugins`):
- Load folder, extract manifests, hash files. `GET /api/plugins`; `POST /api/plugins/:id/enable|disable|approve`; `POST /api/plugins/add` (file body or URL); `DELETE /api/plugins/:id`; `POST /api/plugins/reload`; `GET /api/plugins/:id/code` (served with a `Content-Type` of `text/javascript` for the iframe to import).
- Feed input: `POST /api/plugins/:id/post` and `/patch`, validated and capped, pushed into the hub with `source: 'plugin'`, `chatId: plugin:<id>:<chat>`, `chatName: <chat>`.
- `FeedMessage.source` gains `'plugin'`. Spots that switch on source (avatar route, link building, forwarding, the rail) get a plugin branch.
- Storage: `GET/PUT /api/plugins/:id/storage` in the state file; settings schema and values alongside.
- Proxy: `POST /api/plugins/:id/fetch` checks the host against the manifest's `sites`, then asks the shell (IPC) to fetch with that site's partition when a session exists; otherwise fetches plain. Without the shell (backend run on its own) the proxy fetches plain and reports that sign-in needs the desktop app. The shell fetches with Electron's `net.request`, not `session.fetch`: in Electron 33 `session.fetch` never registers a handler for the underlying request's `redirect` event, so `redirect: 'manual'` cancels every 3xx and a hand-rolled hop loop built on it cannot run. Known limitation: a fetch that goes through the shell cannot pin DNS — Chromium's `session.fetch` has no lookup hook — so for a declared site the name-based local-host check, re-applied on every redirect hop, is the only defence against DNS rebinding; a plain fetch resolves once and dials the addresses it checked.
- Config: `plugins: { [id]: { enabled, approvedHash, settings } }`.

Runtime: the backend runs under the desktop app on Electron's bundled Node (20.18.3 on Electron 33), not on the machine's own. A dependency that needs a newer Node fails at import and takes the whole backend with it — `undici` is pinned to 7.x for exactly that reason (8.x demands Node >= 22.19 and throws `webidl.util.markAsUncloneable is not a function` on load).

Shell (`electron/main.js`):
- One `persist:site-<host>` partition per site. `openSignIn(site)` opens a BrowserWindow on that partition at the site's URL. IPC `plugin-fetch` performs `session.fetch` on the partition and returns status, headers, body (capped).
- The backend reaches the shell over a local HTTP callback: on start or attach the shell tells the backend its callback port (`POST /api/shell/hello { port, token }`), and the backend sends proxy fetches and sign-in requests to `127.0.0.1:<port>` with that token. A backend running without a shell has no callback and reports sign-in as unavailable.

Frontend:
- `PluginHost` mounts one sandboxed iframe per enabled plugin (`sandbox="allow-scripts"`, `srcdoc` bootstrap that imports the plugin's code as a `data:` module and calls `main(ot)`), injects the bridge script, and restarts a plugin when its file changes. The srcdoc's first element is a CSP meta: `default-src 'none'`, scripts inline and from `data:` (the bridge and the module), styles inline, images from `data:`/`blob:`/`https:`, and no `connect-src` at all — so the app's own API and the local network are out of reach, and network results only come back through `ot.fetch` (a plugin can still load images from https hosts).
- **The frames never move.** They live in one fixed layer (`.plugin-layer`); a plugin column renders only a placeholder rectangle (`.plugin-slot`) and the host lays that plugin's frame over it, re-measuring on every render, on `ResizeObserver` of the slot, and on window resize and scroll. Columns are reordered, split, resized and removed constantly, and a frame that lived inside one would reload every time — losing whatever the plugin had in memory. Two columns on the same plugin: the first gets the frame, the second says so. A plugin with no column (`ui: false`, or nobody showing it) runs at 0×0.
- Each frame gets its own **host loop** (`plugins/host.ts`): it checks the envelope, spends a per-plugin call budget (60/s, burst 120), caps one call's arguments at 256 KB of JSON, routes through `routeCall`, and always answers — a value the structured clone cannot carry comes back as an error rather than leaving the plugin waiting. Every load of a plugin's code has a **generation** number, set in the srcdoc, stamped on every message both ways: a document winding down after a reload cannot be answered under the new code's identity.
- Writes to `/api/plugins` and `/api/shell` carry `x-requested-with: opentrench`, and the backend refuses them (403) without it. A custom header forces a CORS preflight, so nothing running in a frame or in another page can reach those routes even by guessing the port.
- Column editor card, picker group, the message "via" tag, and the Settings tab as above.

## Testing

- Backend: manifest extraction (valid, malformed, oversize), hash and approval flow, post validation and caps, proxy host checks, source `plugin` flowing through contract detection and calls.
- Frontend: a bridge test running a tiny plugin in jsdom, checking permission denials and the append-only surface.
- Example plugin `plugins-examples/hello-feed.js` posting fake messages from a public JSON endpoint; used in the docs walkthrough and as a smoke test.

## Docs

`docs/plugins.md`: the manifest, the full `ot` reference, the security warning, the sign-in flow, the compatibility promise, the walkthrough with the example plugin. Linked from README. No site-specific plugin lives in the repo; the user's own plugins stay in the git-ignored folder.

## Out of scope for v1

Backend-side plugin code, a plugin gallery or registry, plugin-to-plugin communication, zip packaging, auto-update of plugins.
