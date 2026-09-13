import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { createSecurityBatchFetcher, createSecurityFetcher } from './security.js';
import { createHoverFetchers } from './hover.js';
import { createDefaultEnricher } from './enrich.js';
import { createMarketRefresher } from './refresh.js';
import { DEFAULT_COVE_AFFILIATE, type CoveOptions } from './cove.js';
import { Services } from './services.js';
import { createApi } from './api.js';
import { allowLocalOrigin, createFeedWss, isLoopbackHost, routeUpgrades } from './ws.js';
import { DiscordBridge } from './discord/bridge.js';
import { StateStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // backend/ (parent of src/ or dist/)
const PORT = Number(process.env.PORT ?? 3210);
const HOST = '127.0.0.1';

const cfg = new ConfigStore(process.env.TRENCHFEED_CONFIG ?? path.join(root, 'config.json'));
const hub: MessageHub = new MessageHub(500, createDefaultEnricher({ o1ApiKey: () => cfg.get().o1ApiKey }), {
  security: createSecurityFetcher(),
  securityBatch: createSecurityBatchFetcher(),
  // the affiliate is opentrench's own, always
  cove: (): CoveOptions => ({ amounts: cfg.get().cove.amounts, affiliateId: DEFAULT_COVE_AFFILIATE }),
  buy: () => ({ provider: cfg.get().buy.provider }),
  blacklist: () => cfg.get().blacklist,
  bots: () => cfg.get().bots,
  favorites: () => cfg.get().favorites,
});

// Live market numbers: every minute, refresh tokens called in the last 24h (30 per request).
const REFRESH_MS = 60_000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const refreshMarket = createMarketRefresher(
  (addr, info) => hub.updateMarket(addr, info),
  (m) => console.warn('[refresh]', m),
);
setInterval(() => {
  // newest calls first so a burst of new tokens never starves the ones people are watching
  const active = hub.activeTokens(ACTIVE_WINDOW_MS).sort((a, b) => b.lastCallTs - a.lastCallTs);
  void refreshMarket(active);
}, REFRESH_MS).unref();
// Holder security, near-live: every minute, refresh what is due. Fresh calls (< 1h) refresh
// every minute, < 6h every 5 minutes, < 24h every 30 minutes. EVM chains go out as one
// GoPlus request per chain; Solana is one RugCheck request per token, newest first, 15 per cycle.
const SEC_TIERS: [number, number][] = [
  [60 * 60 * 1000, 55 * 1000],
  [6 * 60 * 60 * 1000, 5 * 60 * 1000 - 5000],
  [24 * 60 * 60 * 1000, 30 * 60 * 1000 - 5000],
];
setInterval(() => {
  const now = Date.now();
  const due: string[] = [];
  let sol = 0;
  for (const t of hub.activeTokens(24 * 60 * 60 * 1000).sort((a, b) => b.lastCallTs - a.lastCallTs)) {
    if (!t.network) continue;
    const age = now - t.lastCallTs;
    const every = SEC_TIERS.find(([maxAge]) => age < maxAge)?.[1];
    if (every === undefined) continue;
    if (t.security && now - t.security.fetchedAt < every) continue;
    if (t.network === 'solana' && ++sol > 15) continue;
    due.push(t.address);
  }
  if (due.length) void hub.refreshSecurity(due);
}, 60 * 1000).unref();
const svc: Services = new Services(cfg, hub);
svc.startJ7();
svc.syncColumnFeeds();
const hover = createHoverFetchers();
const store = new StateStore(process.env.TRENCHFEED_STATE ?? path.join(root, 'state.json'));
hub.load(store.load());
// A mint that was in flight when the process died is still in flight on the chain: take those jobs
// back so their receipts are still watched and the one-mint-per-wallet guard still holds.
void svc.minter.restore(hub.restoredMintJobs);
hub.on('changed', () => store.schedule(() => hub.snapshot()));
// Desktop app: die with the parent. On Windows a killed/crashed Electron leaves the
// backend (this same exe running as node) orphaned, which then blocks the installer
// ("opentrench cannot be closed") and gets silently re-attached by every later launch.
const parentPid = Number(process.env.TRENCHFEED_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log('[backend] parent gone, exiting');
      store.flush();
      process.exit(0);
    }
  }, 2000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}

// Safety net: log rather than let an unexpected error take the whole backend down.
process.on('uncaughtException', (e) => console.error('[backend] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[backend] unhandled', e));

const app = express();
// This API drives the trading wallet and is reachable on 127.0.0.1, which a page on the open web can
// still address (a browser sends cross-origin requests there happily, and DNS rebinding turns an
// attacker's hostname into a loopback address). So: the Host must name this machine, and an Origin,
// when the client sends one, must be local. Non-browser clients send no Origin and are allowed.
app.use('/api', (req, res, next) => {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (host && !isLoopbackHost(host)) {
    res.status(403).type('text/plain').send('forbidden: opentrench only answers on localhost');
    return;
  }
  if (!allowLocalOrigin(req)) {
    res.status(403).type('text/plain').send('forbidden: cross-origin request');
    return;
  }
  next();
});
// Which build this backend is: the desktop app compares it with its own before attaching to a
// backend it did not start (a stale one from an older checkout rewrites column types it never knew).
const APP_VERSION =
  process.env.TRENCHFEED_APP_VERSION ??
  (() => {
    try {
      return String(JSON.parse(fs.readFileSync(path.resolve(root, '..', 'electron', 'package.json'), 'utf8')).version ?? 'dev');
    } catch {
      return 'dev';
    }
  })();
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));
app.use('/api', createApi(cfg, hub, svc, hover));

const dist = path.resolve(root, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  // Hashed assets can be cached forever; the HTML shell must never be, or a
  // rebuild keeps showing the old UI until a hard refresh.
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));
  app.get('*', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const server = http.createServer(app);
routeUpgrades(server, {
  '/ws': { wss: createFeedWss(hub), allow: allowLocalOrigin },
  '/bridge': { wss: svc.discord.wss, allow: DiscordBridge.allowOrigin },
});

server.listen(PORT, HOST, () => {
  console.log(`opentrench listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
