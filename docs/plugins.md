# Plugins

A plugin is one JavaScript file you drop into opentrench's `plugins` folder. It
can pull a website's feed into the app as a chat, watch the feed you already
have, and draw a column of its own. It runs in a sandbox and reaches the app
only through a versioned API called `ot`.

Nothing in the repo ships a plugin for any particular site. The example in
[`plugins-examples/hello-feed.js`](../plugins-examples/hello-feed.js) is the one
this page walks through; everything else in your folder is yours.

---

## What a plugin is

- **One file.** The manifest at the top, the code below. Easy to post in a
  Discord channel, easy to read before you trust it.
- **Sandboxed.** Each plugin runs in its own `<iframe>` on an opaque origin with
  scripts and nothing else — no network of its own, no access to the app's page,
  your config, your cookies or your keychain. Its only door is a postMessage
  bridge the app answers.
- **Off until you approve it.** A plugin sits in the list doing nothing until
  you read a dialog about it and approve the exact bytes on disk.
- **Its output is real feed data.** `ot.feed.post` makes an ordinary message, so
  contract detection, call cards, trending, filters and forwarding all apply to
  it — the same pipeline your Discord and Telegram messages go through.

What it is not: opentrench cannot check a plugin for you. Approving one is
trusting whoever wrote it with your feed and, if it lists sites, with your
logins on them.

---

## Install

### The folder

The `plugins` folder sits next to `config.json`:

| Where you run opentrench | Folder |
| --- | --- |
| Desktop app, macOS | `~/Library/Application Support/opentrench/plugins` |
| Desktop app, Windows | `%APPDATA%\opentrench\plugins` |
| Desktop app, Linux | `~/.config/opentrench/plugins` |
| A checkout running the backend itself | `backend/plugins` (git-ignored) |

The desktop app keeps its data in Electron's `userData` directory, which is the
platform's app-data folder plus the app's name (`opentrench`). `backend/plugins`
is in `.gitignore`: plugins are code from other people and never part of the
repo. `TRENCHFEED_PLUGINS` overrides the folder if you want it somewhere else.

**The file must be named `<id>.js`**, matching the `id` in its manifest —
`hello-feed.js` for `"id": "hello-feed"`. A file named anything else is listed
with the error `file name must be hello-feed.js` and cannot be enabled.

### Settings → Plugins

⚙ → **Plugins** lists what is in the folder: name, version, api, description,
permissions, sites, the chats it has posted, and its state.

- **add a file** — pick a `.js` file; it is copied into the folder.
- **add from link** — paste an `https` link to a `.js` file. The backend fetches
  it (no redirects: paste the final URL), reads its manifest, and asks before
  overwriting a plugin you already have.
- **reload folder** — rescan after editing a file by hand.
- **remove** — deletes the file and forgets the plugin's stored data.

### Approving

A new or changed plugin shows **review & approve**. The dialog is the last thing
between a file on disk and code running against your feed:

- version, file name, the first 12 characters of the file's SHA-256, and a
  **view code** button that shows the whole file as text;
- what *every* plugin can do: read every message in your feed (never the ones
  the feed hides) and fetch any host;
- what *this* one asks for, in words — `feed:write` is "post messages into your
  feed", `storage` is "keep its own settings and data", `actions` is "write your
  clipboard, and open buys for you to confirm";
- the sites it will use your login on, if any;
- the warning: *This is code written by someone else. Once enabled it can post
  anything into your feed. opentrench cannot check it for you. Open the file and
  read it before you trust it.* When the plugin lists sites, the first sentence
  carries a second clause — *…into your feed, and it can use your logins on the
  sites listed above through this app.*

**I read it — approve and enable** approves and switches it on.

**Approval is bound to the file's hash.** It is the bytes you read that are
approved, not the name. Edit the file — your own edit, an update you pasted in,
anything — and the plugin is disabled and back to **review & approve** until you
approve the new version. If the file changes while the dialog is open, approving
is refused (`the file changed since you opened it; review it again`), because
the version on screen is not the version on disk any more.

---

## The file

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
  // runs at enable and at every app start; may return a stop()
}
```

### Manifest fields

| Field | Rule |
| --- | --- |
| `id` | 1–40 characters of `a-z`, `0-9` and `-`, starting with a letter or digit, and not `constructor`, `prototype` or `__proto__` (those name something on an object, not something in your folder). The file must be `<id>.js`, and the id is the folder-safe key everything else is filed under. |
| `name` | Required, up to 60 characters. Shown in the list, in the approval dialog, as the "via" tag on its messages, and in front of its notifications. |
| `version` | `1.2.3`, optionally with `-beta` / `+build`. Up to 40 characters. |
| `api` | The plugin API major version. This build serves **1**. A higher number is refused: *this plugin needs plugin api 2; this build serves 1 — update opentrench*. |
| `sites` | https **origins** (`https://example.com`, no path, query or fragment), at most 20, never a local or LAN address. They gate two things: which hosts `ot.fetch` sends **with your login**, and which origins an avatar or attachment may be loaded from. Leave it `[]` if the plugin needs no login. |
| `permissions` | Any of `feed:write`, `storage`, `actions`. Anything else refuses the whole manifest. |
| `ui` | `true` when the plugin draws a column. |
| `description` | Up to 300 characters, shown in the list and the approval dialog. |

**The JSON rule.** The manifest block must be the **first statement in the
file** (a leading comment is fine) and must be plain JSON: quoted keys, no
comments inside the block, no trailing commas, no expressions. The app finds
`export const manifest = {`, takes the matching `}` with a string-aware brace
scan, and `JSON.parse`s it. Nothing in the file is ever executed to read the
manifest — that is the point of the rule, and why the app can show you what a
plugin asks for before it has run a line. Two `export const manifest` blocks in
one file are refused.

### `main(ot)` and `stop`

The default export (or a named `main`) is called once with the `ot` object when
the plugin starts: at enable, and at every app start while it is enabled. It may
be `async`. Whatever it returns is the plugin's `stop()` — see
[Lifecycle](#lifecycle) for what today actually calls it.

An exception thrown out of `main`, an uncaught error, or an unhandled rejection
inside the frame is caught and written to the plugin's log panel.

---

## The `ot` API

Every method returns a promise; every call is a round trip to the app. The
object is frozen. Within api 1 the surface is **append-only** — nothing here is
renamed or removed without an `api: 2`.

### Feed, read

No permission needed. **Messages the feed hides — blacklisted authors, bots the
bot policy refuses — are never returned and never pushed.** What you have told
the app you do not want to see is not a plugin's to read.

| Call | What it does |
| --- | --- |
| `ot.feed.onMessage(fn)` | Every new message as it lands. Returns an unsubscribe function. |
| `ot.feed.onToken(fn)` | Every token that appears or changes. Returns an unsubscribe function. |
| `ot.feed.messages({ chat, limit })` | A snapshot, **newest first**. `chat` matches a chat name or a chat id; `limit` defaults to 100, caps at 500. |
| `ot.feed.tokens()` | Every token the app is tracking (up to 2000). |
| `ot.feed.token(address)` | One token, or `null`. An own-property lookup: `constructor` is a miss, not an inherited member. |

```js
const stop = ot.feed.onMessage((m) => {
  if (m.contracts.length) ot.log('call in', m.chatName, m.contracts[0].address);
});
const recent = await ot.feed.messages({ chat: 'Zen', limit: 20 });
```

Events start when the frame starts: what came before is history you ask for with
`feed.messages`. After a gap the app replays at most 50 missed messages.

### Feed, write — `feed:write`

`ot.feed.post({ id, chat, author, text, ts, avatar, link, attachments })`

| Field | Rule |
| --- | --- |
| `id` | Required. The plugin's own stable id for the item, up to 120 characters. The message's real id is `plugin:<pluginId>:<chat slug>:<id>`, and a post whose id is already in the feed is dropped — that is the de-duplication. |
| `chat` | Required, up to 60 characters. The plugin's own name for the chat. Keyed as `plugin:<pluginId>:<slug>`, where the slug is the name lowercased with runs of anything else turned into `-` (so `Zen` → `plugin:hello-feed:zen`). At most 32 distinct chats per plugin. |
| `author` | Up to 60 characters; defaults to the plugin's name. |
| `text` | Up to 4000 characters. Line breaks and tabs survive; control characters do not. |
| `ts` | Milliseconds. Defaults to now, and is clamped to at most a minute ahead of the clock. |
| `avatar` | https, and only on one of the plugin's declared `sites`. |
| `link` | Any http(s) URL that is not a local address. Click-gated, so it is not restricted to `sites`. |
| `attachments` | Up to 8 `{ url, kind: 'image' \| 'video' }`. https, and only on the plugin's declared `sites` — the renderer loads these without a click, so a URL anywhere else would be a beacon. |

A post needs text or an attachment; 60 posts a minute per plugin.

**A chat name already in your feed is refused.** If `chat` is the name of a
Discord channel or Telegram chat you are already watching — the same letters,
whatever the case or spacing — the post comes back
`that chat name belongs to a chat already in your feed`, and nothing is
written. A plugin must not be able to file its own messages under a name you
read as someone else's chat; the "via" tag says who posted a message, but it
cannot unsay whose chat it is in. Other plugins' chat names are not reserved:
each plugin's chats are keyed by its own id.

```js
await ot.feed.post({ id: '2026-09-17-1', chat: 'Alerts', author: 'example.com', text: 'ETH pool opened 0x…', link: 'https://example.com/a/1' });
```

**What happens next.** The message lands in the same hub your Discord and
Telegram messages land in, so: contract addresses in `text` are detected and
enriched, a new contract becomes a call and a call card, repeated calls count
towards trending, filters and forwarding apply. The **first post to a chat adds
that chat to your feed** — it appears in the sidebar and in your Chats columns
straight away, with a small **via &lt;plugin name&gt;** tag next to the chat
name, and under a **Plugins** group in the channel picker (**+**) where you can
switch it off again.

Two things a plugin deliberately cannot do: its messages never count as a
**ping** (a plugin picks its own author name, so it must not be able to ping you
as one of your favourite callers), and there is no reply button on them.

`ot.feed.patch(id, { text, attachments })` edits one of the plugin's own
messages — the id is the full `plugin:<pluginId>:…` id, and another plugin's
message is refused. The edit is re-scanned for contracts, but an address that
appears only in an edit never registers a new call: a plugin cannot turn an old
message into a fresh call by rewriting it. Patches share the 60-a-minute budget.

### Network

`ot.fetch(url, init)` — the backend's proxy. `init` carries `method`, `headers`
and a string `body`, and nothing else; a Request, a stream or credentials cannot
be smuggled through it.

```js
const res = await ot.fetch('https://example.com/api/items', { headers: { accept: 'application/json' } });
if (res.status === 200) for (const item of (await res.json()).items) { /* … */ }
```

The answer is `{ status, headers, body, truncated }` plus `text()` and `json()`
helpers over `body`.

- **Declared sites use your login.** A URL whose origin is in the manifest's
  `sites` is fetched by the desktop app from that site's own cookie partition.
  When the desktop app is not connected — a checkout running the backend on its
  own — such a fetch **fails outright** (`the desktop app is not connected`)
  rather than quietly going out signed out, because that would be a different
  request than the one the plugin asked for. Everything else is fetched plain
  by the backend.
- **`method` is `GET`, `POST`, `PUT`, `PATCH`, `DELETE` or `HEAD`.** Anything
  else is refused (`unsupported method …`) rather than quietly sent as a GET,
  and a `GET` or `HEAD` carrying a body is refused too.
- **Bodies are capped at 4 MB**; `truncated` says whether this one hit the cap.
  Request bodies are capped at 1 MB.
- **Response headers are an allow-list**: `content-type`, `content-length`,
  `etag`, `last-modified`, `link`, `retry-after`, `location`, `cache-control`,
  `date` and `x-ratelimit-*`. Everything else is dropped.
- **Cookies never reach the plugin.** `set-cookie` is dropped on the way back,
  and `cookie` on the way out; on the shell path the site's login is the shell's
  to attach, so `authorization` from the plugin is dropped too — and so are
  `origin` and `referer`, which the plugin has no standing to claim: the request
  is made by the app, from no page at all.
- Local and LAN addresses are refused, on the first hop and on every redirect.
  Redirects are followed by hand (at most 5), https never hands off to http, and
  credentials are dropped the moment the chain leaves the origin you addressed.
- **120 fetches a minute per plugin, and 4 in flight at once.** Timeout 20s.

`ot.sites.status(site)` → `{ signedIn, available }` — whether that site has a
session right now, and whether the desktop app is there at all.
`ot.sites.signIn(site)` opens the sign-in window for one of the plugin's own
declared sites.

```js
if (!(await ot.sites.status('https://example.com')).signedIn) await ot.sites.signIn('https://example.com');
```

### Storage — `storage`

Per plugin, in the backend's `plugins-state.json`, next to `config.json`.

| Call | What it does |
| --- | --- |
| `ot.storage.get(key)` | The value, or `null`. An own-property lookup, so `constructor` reads back as `null`. |
| `ot.storage.set(key, value)` | Anything JSON can carry. The whole bag is capped at 256 KB. |
| `ot.storage.remove(key)` | Deletes it. |

```js
const last = await ot.storage.get('lastId');
await ot.storage.set('lastId', item.id);
```

### Settings — `storage`

`ot.settings.schema(fields)` declares the little form the user sees under the
plugin in ⚙ → Plugins; `ot.settings.get()` reads their answers back.

```js
await ot.settings.schema([
  { key: 'interval', label: 'Check every (seconds)', type: 'number', default: 60 },
  { key: 'token', label: 'API key', type: 'secret' },
]);
const { interval } = await ot.settings.get();
```

Field rules: at most **20 fields** and 16 KB in all; `key` is 1–40 of
`[a-z0-9_-]` in either case (`Interval` is as good a key as `interval`), never
`__proto__`, `constructor` or `prototype` in any case, and never repeated — two
keys that differ only in case are two keys; `label` is at most 60 characters; `type` is `text`, `number`,
`toggle` or `secret`; `default` is text, a number or true/false. Anything else
is refused whole, so a half-valid form is never shown. The form is stored, so
the user can fill it in while the plugin is switched off or waiting to be
approved, and a field the user has never touched saves as the plugin's default.

> **Secrets are not sealed.** A `secret` field is only hidden on screen. It is
> stored in plain text in `plugins-state.json` like the rest of a plugin's data
> — unlike the app's own tokens, which are encrypted with a key in your OS
> keychain. The form says so under it. Do not put anything there you would mind
> another program on your machine reading.

### UI — `ui: true`

| Call | What it does |
| --- | --- |
| `ot.ui.root` | The body of the plugin's frame. Draw into it with ordinary DOM. |
| `ot.ui.setTitle(text)` | The column header, up to 60 characters. Empty clears it back to the column's own title. |
| `ot.ui.setSubtitle(text)` | The line under it, up to 120 characters. |
| `ot.ui.badge(n)` | The count on the header. Clamped to a whole number 0–9999; `null` (or nothing) clears it. |

```js
ot.ui.setTitle('Example feed');
ot.ui.badge(unread.length);
```

### Actions — `actions`

| Call | What it does |
| --- | --- |
| `ot.actions.openToken(address)` | Opens the token drill-down. |
| `ot.actions.jump(messageId)` | Scrolls to a message in the feed and flashes it. |
| `ot.actions.buy(address)` | **Asks.** Raises a confirmation bar: *&lt;Plugin name&gt; wants to open a buy for &lt;address&gt;* [Open] [Ignore]. Only your click reaches a bot. |
| `ot.actions.research(address)` | The same bar, for research. |
| `ot.actions.copy(text)` | Writes the clipboard, up to 10 000 characters, and toasts *copied by &lt;plugin name&gt;: &lt;first 24 characters&gt;*. |
| `ot.actions.notify(title, body)` | A desktop notification. The router puts `[<plugin name>]` in front of the title, so it cannot pass for the app's own. |

`openToken`, `buy` and `research` take a **contract address and nothing else** —
`0x` + 40 hex, or base58 32–44. A plugin that could pass a sentence could write
the text of the bar you are reading.

```js
ot.actions.buy('0x0000000000000000000000000000000000000000'); // you still have to press Open
```

### Logging

`ot.log(...args)` writes a line to the plugin's log panel (the **log** button in
⚙ → Plugins). Lines are written at `info`; errors the app catches for you —
uncaught exceptions, unhandled rejections, a plugin that would not start — are
written at `error`. The last 200 lines are kept, 2000 characters each.

```js
ot.log('fetched', items.length, 'items');
```

---

## Lifecycle

- **One frame per plugin, app-wide.** It is created when the plugin is enabled
  and destroyed when it is disabled, removed, or its file changes. It lives in a
  fixed layer of its own, not inside a column.
- **A plugin runs whether or not anything is showing it.** A `ui: false` plugin,
  and a `ui: true` plugin whose column nobody has added, runs at 0×0. Being
  *enabled* is what makes a plugin run; a column only decides whether you can
  see it.
- **Columns never restart it.** A plugin column marks out a rectangle and the
  app lays the plugin's frame over it. Reordering, resizing, splitting or
  removing columns moves the rectangle, not the frame, so whatever the plugin
  has in memory survives. Two columns on the same plugin: the first gets the
  frame, the second says *This plugin is already open in another column.*
- **One copy per open app window.** The frames belong to the page, so a second
  browser tab pointed at the same backend runs its own copy of every enabled
  plugin: a poller polls twice. Give `feed.post` ids that make the duplicate
  land as one message, as the example does, and keep anything that must happen
  once behind `ot.storage`.
- **Every load has a generation number**, stamped on messages both ways, so a
  document winding down after a reload cannot answer under the new code's
  identity.
- **`stop()` is not called yet.** What `main` returns is kept on the frame's
  window, and when the plugin is disabled or its code changes the whole frame is
  destroyed — which takes its timers, listeners and memory with it. Nothing runs
  your cleanup first. Return a `stop()` anyway: it is part of api 1, it costs
  nothing, and it is what will be called when the app starts tearing frames down
  gracefully.

---

## Drawing a column

Set `"ui": true`, then in the app: **+ column → Plugin**, pick the plugin. The
column body is the plugin's frame, and the standard header controls apply. A
column whose plugin is switched off says so; one whose plugin is not installed
says *Plugin not installed. Add it in ⚙ → Plugins.*

The frame is a blank document with the app's theme on it:
`--bg`, `--panel`, `--line`, `--text`, `--muted` and `--accent`, a 13px system
font, and links in the accent colour. Use them and a plugin column looks like
the rest of the app.

The frame's CSP is the boundary, and it is strict:

```
default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline';
img-src data: blob: https:; font-src data:; connect-src 'none';
form-action 'none'; frame-src 'none'
```

So: **no network from inside the frame at all** — no `fetch`, no `XMLHttpRequest`,
no WebSocket, no form post. `ot.fetch` is the only way data comes back, and the
app's own API and your local network are out of reach even by guessing the port
(writes to the plugin routes also require a header a frame cannot set). Inline
styles and scripts work; images load from `data:`, `blob:` and any https host.
There are no nested frames.

Treat everything you fetched as data: build nodes and set `textContent`. The
example plugin does.

---

## Limits

| Thing | Limit |
| --- | --- |
| Plugin file | 512 KB |
| `sites` | 20 origins |
| `feed.post` / `feed.patch` | 60 a minute per plugin |
| Message text | 4000 characters |
| Attachments | 8 per message |
| Chats per plugin | 32 |
| `ot.fetch` | 120 a minute, 4 in flight, 20s timeout, 5 redirects |
| Response body | 4 MB (`truncated` says when it was cut) |
| Request body | 1 MB |
| Storage | 256 KB per plugin |
| Settings form | 20 fields, 16 KB; answers 64 KB |
| Bridge calls | 60 a second sustained, 120 in hand |
| Arguments of one call | 256 KB serialized |
| `messages({ limit })` | 100 by default, 500 max |
| Log | last 200 lines |

---

## Sign-in

A plugin never sees a password or a cookie. When it needs your login on one of
its declared sites:

1. The plugin calls `ot.sites.signIn('https://example.com')`, or you press
   **sign in** next to the site in ⚙ → Plugins.
2. The desktop app opens **the site's own page** in a window of its own, on a
   cookie partition dedicated to that origin (`persist:site-<hash of the
   origin>`, so two origins that differ only in scheme or port never share a
   login). One
   window per site: pressing sign in again raises the window you already have
   and sends it back to the site.
3. You sign in there, by hand. The window has no preload, no devtools, and every
   permission request (camera, microphone, location, notifications) is denied.
   Navigation is not pinned to the site's origin, because a sign-in that hops to
   an identity provider and back has to be able to.
4. From then on, `ot.fetch` to that origin goes out **from the app**, carrying
   that partition's cookies. The plugin gets the response body and the allowed
   headers; the cookies stay in the app.

⚙ → Plugins shows **signed in** or a **sign in** button per site, and says
plainly when there is nothing to open: *Signing in to sites needs the desktop
app.*

> **Known limitation: no DNS pinning on the shell path.** A plain fetch resolves
> the hostname once, refuses every local answer, and dials exactly the addresses
> it checked. A fetch through the desktop app cannot do that — Chromium's
> session fetch has no lookup hook — so for a declared site the name-based
> local-host check, re-applied on every redirect hop, is the only thing standing
> between it and DNS rebinding. Declaring a site you do not trust is worse than
> it looks.

---

## Compatibility promise

- The `ot` API is **append-only within a major**. Methods and fields are added;
  nothing is renamed or removed without `api: 2`, and the app keeps serving
  `api: 1` plugins when that happens.
- A plugin whose `api` is higher than the app knows is refused, with the version
  numbers in the message: *this plugin needs plugin api 2; this build serves 1 —
  update opentrench.*
- The message and token shapes a plugin sees are the app's public types. Changing
  one in a way a plugin could notice needs the same version bump.

So a plugin written today keeps working across app updates for as long as
opentrench serves api 1, and you will be told clearly if it ever does not.

---

## Security notes

### For users

- **Read the file.** It is one file, and the approval dialog will show it to you.
  That is the whole security model: opentrench cannot tell a useful plugin from a
  hostile one.
- **Approval is per version.** A changed file is disabled until you approve it
  again — including an "update" someone hands you.
- **Every plugin can read your feed** (except the messages the feed hides) and
  fetch any host. That is true before it asks for a single permission. A plugin
  can therefore take what it reads somewhere else; the sandbox stops it from
  reaching your config and your accounts, not from sending what it legitimately
  saw.
- **Nothing a plugin asks for moves money on its own.** `buy` and `research`
  raise a bar naming the plugin and showing the whole address, and only your
  click reaches a bot. A plugin can put a buy in front of you; it cannot take
  one.
- **The clipboard is never written quietly.** Every `copy` toasts who did it and
  what it wrote, because an unannounced clipboard write is how a pasted address
  gets swapped.
- **Notifications are attributed.** A plugin's notification always starts with
  `[its name]`.
- **A site in `sites` is a login you are lending out.** Requests to it go out as
  you, from your machine.
- **Plugin settings, including `secret` fields, are stored in plain text.**

### For authors

- Ask for the least you need: no permission at all is a fine manifest, and
  `sites: []` means your plugin works for people running the backend without the
  desktop app.
- Treat everything you fetch as hostile data. `textContent`, not `innerHTML`.
- Give `feed.post` a stable `id` per item — the wall-clock time is not one, and
  you will post duplicates every restart.
- Respect the caps rather than discovering them: poll on a sensible interval,
  keep state in `ot.storage` so a restart does not re-post a week of history.
- Errors belong in `ot.log`. A plugin that throws out of `main` is shown as
  errored next to its name.
- `stop()` is part of the contract even though the app does not call it yet.
  Return one.

---

## Walkthrough: `hello-feed`

[`plugins-examples/hello-feed.js`](../plugins-examples/hello-feed.js) is a
complete plugin in about a hundred commented lines. It polls a public endpoint
that needs no login, posts each new line into a chat called **Zen**, and shows
the last few in a column with a copy button.

1. **Install it.** ⚙ → **Plugins** → **add a file** → pick
   `plugins-examples/hello-feed.js`. (Or copy it into the folder from the table
   above and press **reload folder**.) The list shows *Hello feed v1.0.0 · api 1*
   with permissions `feed:write, storage, actions` and no sites.
2. **Read it.** Press **review & approve**, then **view code**. It asks to post
   into your feed, keep its own data, and write your clipboard; it lists no
   sites, so no login of yours is involved.
3. **Approve it.** **I read it — approve and enable**. The row turns on.
4. **Watch the chat appear.** Within a few seconds it posts its first line, and
   the chat joins your feed by itself: **Zen** shows up under **PLUGINS** in the
   sidebar, and its messages appear in any Chats column with a **via Hello
   feed** tag next to the chat name. Press **+** and choose the **Plugins** tab
   to see it listed there — **Zen**, with **Hello feed** beside it — where you can
   switch it off again.
5. **Give it a column.** **+ column → Plugin → Hello feed**. The column header
   reads *Hello feed / one line at a time* — the title and subtitle the plugin
   set — and its body is the plugin's own frame: the last few lines, each with a
   **copy** button. Press one: the clipboard gets the line and the app toasts
   *copied by Hello feed: …*.
6. **Change a setting.** Back in ⚙ → Plugins, under Hello feed there is a form
   with **Check every (seconds)** = 60 and **Prefix for each line**. Type a
   prefix, **save settings**, and the next line it posts carries it.
7. **Check the log.** Press **log**. On a healthy run it says *nothing logged
   yet*; a failed fetch would show as `tick failed: …`.

To take it off again: **remove** deletes the file and forgets its stored data.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| *approve this version of the plugin first* | The file on disk is not the one you approved (or it was never approved). Press **review & approve**. |
| *the plugin file changed on disk; approve this version first* | It changed while it was running. The frame stops; approve the new version. |
| *the file changed since you opened it; review it again* | The file changed while the approval dialog was open. Close it and look again. |
| *file name must be `<id>.js`* | Rename the file to match the manifest's `id`. |
| *the manifest must be the first statement in the file* | Code (or an import) sits above the manifest block. Only comments may. |
| *manifest is not valid JSON* | Unquoted keys, a comment inside the block, or a trailing comma. |
| *this plugin needs plugin api N; this build serves 1* | The plugin is written for a newer opentrench. Update the app. |
| *the desktop app is not connected* | A fetch to one of the plugin's declared sites, with no desktop app to supply the login. Run opentrench as the app, or drop the site from `sites` and fetch it plain. |
| *too many calls* | The plugin is talking to the app faster than 60 calls a second. Batch, or slow down. |
| *arguments too large* | One call's arguments came to more than 256 KB. Post in pieces. |
| *too many posts (60 a minute)* / *too many fetches (120 a minute)* / *too many fetches at once (4 at a time)* | The plugin's rate caps. |
| *that chat name belongs to a chat already in your feed* | `chat` is the name of a Discord channel or Telegram chat you already watch. Give the plugin's chat a name of its own. |
| *unsupported method …* / *a GET does not carry a body* | `ot.fetch` proxies GET, POST, PUT, PATCH, DELETE and HEAD, and a GET or HEAD goes out without a body. |
| *this plugin did not ask for the `storage` permission* | Add it to the manifest's `permissions` — and the plugin will need approving again. |
| *would replace `<name>`* | A link or file whose manifest id names a plugin you already have; the app asks before overwriting it, and the replacement starts unapproved. |
| *the link now installs `<name>` (`<id>`), not `<id>`* | The link served something different the second time round. Check the link. |
| *the link redirects; use the final URL* | `add from link` does not follow redirects. Paste where it ends up. |
| *plugin storage is full (256 KB)* | Trim what the plugin keeps. |
| *This plugin is already open in another column* | One frame per plugin; the other column has it. |
| The column is blank | The plugin is `ui: false`, or it has not drawn anything yet. Check its log. |
