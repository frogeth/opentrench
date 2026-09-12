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

/** The hostnames that mean "this machine". `new URL()` keeps IPv6 literals bracketed. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when `host` (a Host header, so `name:port`) names this machine. */
export function isLoopbackHost(host: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * The backend binds to 127.0.0.1, but that alone does not stop a page on the open web from talking
 * to it: a browser will happily send cross-origin requests (and WebSocket upgrades, which CORS does
 * not cover at all) to localhost, carrying whatever the page wants with them — and this API can
 * spend the trading wallet. So an origin, when the client sends one, has to be local.
 *
 * A missing `origin` is allowed: that is a non-browser client (curl, the Electron main process, a
 * script), which a malicious web page cannot impersonate. `file:` pages send `origin: null`.
 */
export function allowLocalOrigin(req: { headers: { origin?: string | string[] } }): boolean {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return true; // not a browser
  if (origin === 'null' || origin === 'file://') return true; // a file: page (packaged Electron)
  try {
    const u = new URL(origin);
    return u.protocol === 'file:' || LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
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
  routeUpgrades(server, { '/ws': { wss: createFeedWss(hub), allow: allowLocalOrigin } });
}
