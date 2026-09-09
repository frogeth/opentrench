import { useEffect, useState } from 'react';
import type { FeedMessage, ServerEvent, Status } from './types';

const MAX = 500;

export function useFeed() {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
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
          setMessages(ev.messages);
          setStatus(ev.status);
        } else if (ev.type === 'message') setMessages((m) => [...m.slice(-(MAX - 1)), ev.msg]);
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

  return { messages, status, wsOpen };
}
