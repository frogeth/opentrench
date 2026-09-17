/** The `ot` object as the plugin sees it. Every call is a postMessage round trip; events flow the other way. Append-only within api 1. */
export const BRIDGE_SRC = String.raw`
(() => {
  const pending = new Map();
  let seq = 0;
  const listeners = { message: new Set(), token: new Set() };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ ot: 1, kind: 'call', id, method, args }, '*');
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.ot !== 1) return;
    if (d.kind === 'result') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.reject(new Error(d.error)) : p.resolve(d.value);
    } else if (d.kind === 'event') {
      const set = Object.prototype.hasOwnProperty.call(listeners, d.name) ? listeners[d.name] : null;
      for (const fn of set || []) { try { fn(d.data); } catch (err) { call('log', 'error', 'listener: ' + (err && err.message || err)); } }
    }
  });
  const on = (name) => (fn) => { listeners[name].add(fn); return () => listeners[name].delete(fn); };
  // { status, headers, body, truncated } from the proxy; truncated is true when the body hit the cap
  const withHelpers = (r) => ({ ...r, text: () => r.body, json: () => JSON.parse(r.body) });
  window.ot = Object.freeze({
    api: 1,
    feed: {
      onMessage: on('message'), onToken: on('token'),
      messages: (o) => call('feed.messages', o || {}), tokens: () => call('feed.tokens'), token: (a) => call('feed.token', a),
      post: (m) => call('feed.post', m), patch: (id, p) => call('feed.patch', id, p),
    },
    fetch: (url, init) => call('fetch', url, init || {}).then(withHelpers),
    sites: { status: (s) => call('sites.status', s), signIn: (s) => call('sites.signIn', s) },
    storage: { get: (k) => call('storage.get', k), set: (k, v) => call('storage.set', k, v), remove: (k) => call('storage.remove', k) },
    settings: { schema: (s) => call('settings.schema', s), get: () => call('settings.get') },
    ui: { root: document.body, setTitle: (t) => call('ui.setTitle', t), setSubtitle: (t) => call('ui.setSubtitle', t), badge: (n) => call('ui.badge', n) },
    actions: {
      openToken: (a) => call('actions.openToken', a), jump: (id) => call('actions.jump', id), buy: (a) => call('actions.buy', a),
      research: (a) => call('actions.research', a), copy: (t) => call('actions.copy', t), notify: (t, b) => call('actions.notify', t, b),
    },
    log: (...a) => call('log', 'info', ...a),
  });
  window.addEventListener('error', (e) => call('log', 'error', String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => call('log', 'error', String(e.reason && e.reason.message || e.reason)));
})();
`;
