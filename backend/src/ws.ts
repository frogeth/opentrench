import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { MessageHub } from './hub.js';
import type { ServerEvent } from './types.js';

export function attachWs(server: Server, hub: MessageHub): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(hub.hello()));
  });
  hub.on('event', (ev: ServerEvent) => {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}
