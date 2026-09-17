import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedMessage, PluginInfo, TokenInfo } from '../types';
import { api } from '../api';
import { BRIDGE_SRC } from './bridge';
import { createHostLoop } from './host';
import type { PluginContext, SettingField } from './route';

/** The app's look inside the frame: the same variables the page uses, so raw HTML from a plugin sits naturally. */
const THEME_CSS = `:root{color-scheme:dark}body{margin:0;background:#0a0c0f;color:#e6e8ee;font:13px system-ui,-apple-system,sans-serif;--bg:#0a0c0f;--panel:#11151c;--line:#1e2430;--text:#e6e8ee;--muted:#7d8597;--accent:#41c892}a{color:var(--accent)}`;

/** at most this many missed messages are replayed after a gap; a plugin that wants more asks for it */
const CATCH_UP = 50;

export interface PluginFrameProps {
  plugin: PluginInfo;
  /** the live feed, for subscriptions and snapshots */
  messages: FeedMessage[];
  tokens: Record<string, TokenInfo>;
  actions: PluginContext['actions'];
  /** a column shows the frame; a hidden host does not */
  visible: boolean;
  onTitle?: (t: string) => void;
  onSubtitle?: (t: string) => void;
  onBadge?: (n: number | null) => void;
  onSchema?: (s: SettingField[]) => void;
  onError?: (text: string) => void;
}

/**
 * One running plugin: a sandboxed iframe (opaque origin, scripts only) bootstrapped with the bridge and the
 * plugin's code as a data: module. Calls out of the frame go through this frame's own host loop, which
 * answers them from the router; feed events are pushed the other way.
 */
export function PluginFrame({ plugin, messages, tokens, actions, visible, onTitle, onSubtitle, onBadge, onSchema, onError }: PluginFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [code, setCode] = useState<string | null>(null);
  // everything the loop reads on each call, kept current without restarting the frame
  const latest = useRef({ messages, tokens, actions, onTitle, onSubtitle, onBadge, onSchema, onError });
  latest.current = { messages, tokens, actions, onTitle, onSubtitle, onBadge, onSchema, onError };
  const manifest = plugin.manifest!;

  useEffect(() => {
    let dead = false;
    api
      .pluginCode(plugin.id)
      .then((c) => !dead && setCode(c))
      .catch((e) => latest.current.onError?.(e?.message ?? String(e)));
    return () => {
      dead = true;
    };
  }, [plugin.id, plugin.hash]);

  const srcdoc = useMemo(() => {
    if (code === null) return '';
    const mod = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${THEME_CSS}</style></head><body><script>${BRIDGE_SRC}</script><script type="module">import(${JSON.stringify(mod)}).then((m) => { window.__otStop = (m.default || m.main)(window.ot); }).catch((e) => window.ot.log('error', 'plugin failed to start: ' + (e && e.message || e)));</script></body></html>`;
  }, [code]);

  // answer calls from this frame only, through a loop of its own
  useEffect(() => {
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
    const loop = createHostLoop({ ctx, post: (msg) => frame.current?.contentWindow?.postMessage(msg, '*'), onError: (t) => latest.current.onError?.(t) });
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
  }, [plugin.id, plugin.hash]);

  // Events start at the frame's first render: what came before is history the plugin asks for itself.
  const seen = useRef<string | null>(null);
  const tokenRefs = useRef(new Map<string, TokenInfo>());
  const tokensSeeded = useRef(false);
  useEffect(() => {
    // new code means a new document: diff from scratch
    seen.current = null;
    tokensSeeded.current = false;
    tokenRefs.current.clear();
  }, [code]);
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!w || code === null) return;
    const newest = messages[0];
    if (!newest) return;
    if (seen.current === null) {
      seen.current = newest.id;
      return;
    }
    const fresh: FeedMessage[] = [];
    for (const m of messages) {
      if (m.id === seen.current || fresh.length >= CATCH_UP) break;
      fresh.push(m);
    }
    seen.current = newest.id;
    for (const m of fresh.reverse()) w.postMessage({ ot: 1, kind: 'event', name: 'message', data: m }, '*');
  }, [messages, code]);
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!w || code === null) return;
    const seeding = !tokensSeeded.current;
    tokensSeeded.current = true;
    for (const [a, t] of Object.entries(tokens)) {
      if (tokenRefs.current.get(a) === t) continue;
      tokenRefs.current.set(a, t);
      if (!seeding) w.postMessage({ ot: 1, kind: 'event', name: 'token', data: t }, '*');
    }
  }, [tokens, code]);

  if (code === null) return visible ? <div className="empty">loading plugin…</div> : null;
  return <iframe ref={frame} className={`plugin-frame${visible ? '' : ' plugin-frame-hidden'}`} sandbox="allow-scripts" srcDoc={srcdoc} title={manifest.name} />;
}
