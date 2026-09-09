import { useEffect, useState } from 'react';
import type { FeedMessage, ServerEvent, Status, TokenInfo } from './types';

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
  });
  const [wsOpen, setWsOpen] = useState(false);

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
          setMessages([...ev.messages].reverse());
          setTokens(Object.fromEntries(ev.tokens.map((t) => [t.address, t])));
          setStatus(ev.status);
        } else if (ev.type === 'message') {
          setMessages((m) => [ev.msg, ...m].slice(0, MAX));
        } else if (ev.type === 'token') {
          setTokens((t) => ({ ...t, [ev.token.address]: ev.token }));
        } else if (ev.type === 'reactions') {
          setMessages((m) => m.map((x) => (x.id === ev.msgId ? { ...x, reactions: ev.reactions } : x)));
        } else if (ev.type === 'status') setStatus(ev.status);
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

  return { messages, tokens, status, wsOpen };
}
