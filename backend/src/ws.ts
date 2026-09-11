import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { MessageHub } from './hub.js';
import type { ServerEvent } from './types.js';

/** The feed socket (`/ws`): hello on connect, then every hub event. */
export function createFeedWss(hub: MessageHub): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(hub.hello()));
  });
  hub.on('event', (ev: ServerEvent) => {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  });
  return wss;
}

/**
 * One HTTP server, several WebSocket endpoints. Two `ws` servers attached to the same
 * HTTP server with different `path`s fight over upgrades (the first one aborts the
 * request with a 400), so upgrades are routed here by pathname instead.
 */
export function routeUpgrades(server: Server, routes: Record<string, { wss: WebSocketServer; allow?: (req: IncomingMessage) => boolean }>): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routes[pathname];
    if (!route || (route.allow && !route.allow(req))) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    route.wss.handleUpgrade(req, socket, head, (ws) => route.wss.emit('connection', ws, req));
  });
}

/** Back-compat helper: feed socket only. */
export function attachWs(server: Server, hub: MessageHub): void {
  routeUpgrades(server, { '/ws': { wss: createFeedWss(hub) } });
}
