// hello-feed.js — the example opentrench plugin, and the one docs/plugins.md walks through.
// Copy it into your plugins folder (or ⚙ → Plugins → add a file), read it, approve it, and it
// posts a short line into a chat called "Zen" and draws a column of its own.

// The manifest must be the first statement in the file and plain JSON: quoted keys, no comments
// inside the block, no trailing commas. The app reads it as text and never runs the file to get
// it, so nothing here happens before you have seen what it asks for.
export const manifest = {
  "id": "hello-feed",
  "name": "Hello feed",
  "version": "1.0.0",
  "api": 1,
  "sites": [],
  "permissions": ["feed:write", "storage", "actions"],
  "ui": true,
  "description": "Posts a public one-line feed into opentrench as a chat, and shows the last few in its own column."
};

// A public endpoint that needs no login and answers with one line of plain text. It is not
// listed in `sites`, so it is fetched plain: no cookies, no session, nobody's login.
const ENDPOINT = 'https://api.github.com/zen';
const KEEP = 5; // how many lines the column keeps on screen

/** Runs when the plugin is enabled and at every app start. What it returns is its stop(). */
export default function main(ot) {
  ot.ui.setTitle('Hello feed'); // the column's header, and its subtitle under it
  ot.ui.setSubtitle('one line at a time');

  // The form the user fills in under this plugin in ⚙ → Plugins. It needs the `storage`
  // permission: a form and the answers to it are the plugin's own stored data.
  void ot.settings.schema([
    { key: 'interval', label: 'Check every (seconds)', type: 'number', default: 60 },
    { key: 'greeting', label: 'Prefix for each line', type: 'text', default: '' },
  ]);

  const seen = []; // the last few lines, newest first — what the column shows
  let timer;

  // `ot.ui.root` is the body of this plugin's sandboxed frame. Build nodes and set
  // `textContent`: a line off the network is data, and innerHTML would make it markup.
  const draw = (empty) => {
    if (empty) return void (ot.ui.root.textContent = 'waiting for the first line…');
    ot.ui.root.replaceChildren(
      ...seen.map((line) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:start;padding:10px 12px;border-bottom:1px solid var(--line)';
        const text = document.createElement('div');
        text.textContent = line;
        const copy = document.createElement('button');
        copy.textContent = 'copy';
        // `actions`. The app toasts who copied what: a plugin never writes the clipboard quietly.
        copy.onclick = () => ot.actions.copy(line);
        row.append(text, copy);
        return row;
      }),
    );
  };

  const tick = async () => {
    try {
      const settings = await ot.settings.get(); // the user's answers, read fresh each time
      const res = await ot.fetch(ENDPOINT); // `init` is optional: a plain GET needs nothing
      if (res.status !== 200) throw new Error(`the endpoint answered ${res.status}`);
      const line = (await res.text()).trim();
      // `storage` is this plugin's own bag on disk. It outlives restarts, which is what
      // makes this a de-duplication and not just a comparison.
      if (!line || line === (await ot.storage.get('last'))) return;
      await ot.storage.set('last', line);
      const text = settings.greeting ? `${settings.greeting} ${line}` : line;
      // Into the feed as a real message: chat "Zen" is keyed `plugin:hello-feed:zen`, and
      // `id` is the plugin's own stable id for the item, so the same line never lands twice.
      await ot.feed.post({ id: line.slice(0, 80), chat: 'Zen', author: 'zen', text, link: ENDPOINT });
      seen.unshift(text);
      seen.length = Math.min(seen.length, KEEP);
      draw();
    } catch (e) {
      ot.log('tick failed:', e?.message ?? String(e)); // shows under "log" in ⚙ → Plugins
    }
  };

  draw(true);
  void (async () => {
    // the line from last time, so a restart has something on screen before the next one lands
    const last = await ot.storage.get('last');
    if (last) {
      seen.push(last);
      draw();
    }
    await tick();
    const { interval } = await ot.settings.get();
    // A floor of 10s: a plugin polling faster than its own rate limit only refuses itself.
    timer = setInterval(tick, Math.max(10, Number(interval) || 60) * 1000);
  })();

  // Handed back to the app as this plugin's stop(). See "Lifecycle" in docs/plugins.md for
  // when it is called — today the frame is destroyed outright and this never runs.
  return () => clearInterval(timer);
}
