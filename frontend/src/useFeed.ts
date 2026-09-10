import { useEffect, useRef, useState } from 'react';
import type { BotMessage, FeedMessage, ServerEvent, Status, TokenInfo } from './types';

const MAX = 500;

export function useFeed() {
  /** newest first */
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [tokens, setTokens] = useState<Record<string, TokenInfo>>({});
  const [status, setStatus] = useState<Status>({
    discord: 'disconnected',
    telegram: 'disconnected',
    loginStep: 'idle',
    error: {},
    favorites: [],
  });
  const [wsOpen, setWsOpen] = useState(false);
  const [ping, setPing] = useState<Extract<ServerEvent, { type: 'ping' }> | null>(null);
  /** live bot conversations (Cove), keyed by bot username; newest last, edits replace in place */
  const [botMsgs, setBotMsgs] = useState<Record<string, BotMessage[]>>({});
  const mergeBot = (bot: string, incoming: BotMessage[]) =>
    setBotMsgs((all) => {
      const cur = all[bot] ?? [];
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
      return { ...all, [bot]: [...byId.values()].sort((a, b) => a.id - b.id).slice(-200) };
    });
  const boot = useRef<string | null>(null);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setWsOpen(true);
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (ev.type === 'hello') {
          // A different server process may serve a different build: reload rather than run old assets.
          if (boot.current && ev.boot && ev.boot !== boot.current) {
            location.reload();
            return;
          }
          boot.current = ev.boot ?? boot.current;
          setMessages([...ev.messages].reverse());
          setTokens(Object.fromEntries(ev.tokens.map((t) => [t.address, t])));
          setStatus(ev.status);
        } else if (ev.type === 'message') {
          setMessages((m) => [ev.msg, ...m].slice(0, MAX));
        } else if (ev.type === 'token') {
          setTokens((t) => ({ ...t, [ev.token.address]: ev.token }));
        } else if (ev.type === 'tokens') {
          setTokens(Object.fromEntries(ev.tokens.map((t) => [t.address, t])));
        } else if (ev.type === 'msg') {
          setMessages((m) => m.map((x) => (x.id === ev.msgId ? { ...x, ...ev.patch } : x)));
        } else if (ev.type === 'reactions') {
          setMessages((m) => m.map((x) => (x.id === ev.msgId ? { ...x, reactions: ev.reactions } : x)));
        } else if (ev.type === 'bot') mergeBot(ev.bot, [ev.msg]);
        else if (ev.type === 'botDelete') {
          const gone = new Set(ev.ids);
          setBotMsgs((all) => Object.fromEntries(Object.entries(all).map(([b, list]) => [b, list.filter((m) => !gone.has(m.id))])));
        }
        else if (ev.type === 'ping') setPing(ev);
        else if (ev.type === 'status') setStatus(ev.status);
      };
      ws.onclose = () => {
        setWsOpen(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { messages, tokens, status, wsOpen, ping, botMsgs, mergeBot };
}
