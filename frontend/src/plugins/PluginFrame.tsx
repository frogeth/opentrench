import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FeedMessage, PluginInfo, TokenInfo } from '../types';
import { api } from '../api';
import { BRIDGE_SRC } from './bridge';
import { createHostLoop } from './host';
import type { PluginContext, SettingField } from './route';

/**
 * The frame may run scripts and nothing else: no network of its own (`ot.fetch` goes through the app
 * and the backend proxy), no forms, no nested frames. Images are allowed from data:, blob: and https:
 * so a plugin can show what it fetched. It is the first element in <head>, in force before anything
 * below it parses.
 */
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'">`;

/** The app's look inside the frame: the same variables the page uses, so raw HTML from a plugin sits naturally. */
const THEME_CSS = `:root{color-scheme:dark}body{margin:0;background:#0a0c0f;color:#e6e8ee;font:13px system-ui,-apple-system,sans-serif;--bg:#0a0c0f;--panel:#11151c;--line:#1e2430;--text:#e6e8ee;--muted:#7d8597;--accent:#41c892}a{color:var(--accent)}`;

/** at most this many missed messages are replayed after a gap; a plugin that wants more asks for it */
const CATCH_UP = 50;

/** every load of a plugin's code gets its own number, app-wide; see `gen` in host.ts */
let generation = 0;

export interface PluginFrameProps {
  plugin: PluginInfo;
  /** the live feed, for subscriptions and snapshots */
  messages: FeedMessage[];
  tokens: Record<string, TokenInfo>;
  actions: PluginContext['actions'];
  onTitle?: (t: string) => void;
  onSubtitle?: (t: string) => void;
  onBadge?: (n: number | null) => void;
  onSchema?: (s: SettingField[]) => void;
  onError?: (text: string) => void;
}

/**
 * One running plugin: a sandboxed iframe (opaque origin, scripts only, the CSP above) bootstrapped with
 * the bridge and the plugin's code as a data: module. Calls out of the frame go through this frame's own
 * host loop, which answers them from the router; feed events are pushed the other way. `PluginHost` owns
 * where it sits on screen — this component knows nothing about columns.
 */
export function PluginFrame({ plugin, messages, tokens, actions, onTitle, onSubtitle, onBadge, onSchema, onError }: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  /** the code that is live in the frame right now, and which load of it this is */
  const [boot, setBoot] = useState<{ code: string; gen: number } | null>(null);
  // everything the loop reads on each call, kept current without restarting the frame
  const latest = useRef({ messages, tokens, actions, onTitle, onSubtitle, onBadge, onSchema, onError });
  useLayoutEffect(() => {
    latest.current = { messages, tokens, actions, onTitle, onSubtitle, onBadge, onSchema, onError };
  });
  const manifest = plugin.manifest!;

  useEffect(() => {
    let dead = false;
    // the old document goes first: the frame's identity must never run ahead of the code inside it
    setBoot(null);
    api
      .pluginCode(plugin.id)
      .then((code) => !dead && setBoot({ code, gen: ++generation }))
      .catch((e) => latest.current.onError?.(e?.message ?? String(e)));
    return () => {
      dead = true;
    };
  }, [plugin.id, plugin.hash]);

  const srcdoc = useMemo(() => {
    if (!boot) return '';
    // base64 in a data: module: the plugin's own text never lands in the document's markup, so no
    // </script>, quote or line separator inside it can break out of the bootstrap
    const mod = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(boot.code)))}`;
    return `<!doctype html><html><head>${CSP_META}<meta charset="utf-8"><style>${THEME_CSS}</style></head><body><script>window.__otGen=${boot.gen}</script><script>${BRIDGE_SRC}</script><script type="module">import(${JSON.stringify(mod)}).then((m) => { window.__otStop = (m.default || m.main)(window.ot); }).catch((e) => window.ot.log('error', 'plugin failed to start: ' + (e && e.message || e)));</script></body></html>`;
  }, [boot]);

  // answer calls from this frame, and from this load of its code, only
  const gen = boot?.gen;
  useEffect(() => {
    if (gen === undefined) return;
    const ctx: PluginContext = {
      id: plugin.id,
      manifest,
      api,
      actions: {
        openToken: (a) => latest.current.actions.openToken(a),
        jump: (id) => latest.current.actions.jump(id),
        buy: (a) => latest.current.actions.buy(a),
        research: (a) => latest.current.actions.research(a),
        copy: (t) => latest.current.actions.copy(t),
        notify: (title, body) => latest.current.actions.notify(title, body),
      },
      snapshot: { messages: () => latest.current.messages, tokens: () => latest.current.tokens },
      ui: {
        setTitle: (t) => latest.current.onTitle?.(t),
        setSubtitle: (t) => latest.current.onSubtitle?.(t),
        badge: (n) => latest.current.onBadge?.(n),
        setSchema: (s) => latest.current.onSchema?.(s),
      },
    };
    const loop = createHostLoop({ ctx, gen, post: (msg) => frame.current?.contentWindow?.postMessage(msg, '*'), onError: (t) => latest.current.onError?.(t) });
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      void loop.handle(e.data);
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      loop.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, gen]);

  // Events start at the frame's first render: what came before is history the plugin asks for itself.
  const seen = useRef<string | null>(null);
  const tokenRefs = useRef(new Map<string, TokenInfo>());
  const tokensSeeded = useRef(false);
  useEffect(() => {
    // new code means a new document: diff from scratch
    seen.current = null;
    tokensSeeded.current = false;
    tokenRefs.current.clear();
  }, [gen]);
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!w || gen === undefined) return;
    const newest = messages[0];
    if (!newest) return;
    if (seen.current === null) {
      seen.current = newest.id;
      return;
    }
    const fresh: FeedMessage[] = [];
    for (const m of messages) {
      if (m.id === seen.current || fresh.length >= CATCH_UP) break;
      // what the feed hides is not the plugin's to read, pushed or pulled
      if (m.hidden) continue;
      fresh.push(m);
    }
    seen.current = newest.id;
    for (const m of fresh.reverse()) w.postMessage({ ot: 1, kind: 'event', name: 'message', data: m, gen }, '*');
  }, [messages, gen]);
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!w || gen === undefined) return;
    const seeding = !tokensSeeded.current;
    tokensSeeded.current = true;
    for (const [a, t] of Object.entries(tokens)) {
      if (tokenRefs.current.get(a) === t) continue;
      tokenRefs.current.set(a, t);
      if (!seeding) w.postMessage({ ot: 1, kind: 'event', name: 'token', data: t, gen }, '*');
    }
    // a token the feed dropped keeps no entry here either
    if (tokenRefs.current.size > Object.keys(tokens).length) for (const a of [...tokenRefs.current.keys()]) if (!(a in tokens)) tokenRefs.current.delete(a);
  }, [tokens, gen]);

  if (!boot) return null;
  return <iframe ref={frame} className="plugin-frame" sandbox="allow-scripts" srcDoc={srcdoc} title={manifest.name} />;
}
