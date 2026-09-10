import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { createSecurityFetcher } from './security.js';
import { createHoverFetchers } from './hover.js';
import { createDefaultEnricher } from './enrich.js';
import { createMarketRefresher } from './refresh.js';
import type { CoveOptions } from './cove.js';
import { Services } from './services.js';
import { createApi } from './api.js';
import { attachWs } from './ws.js';
import { StateStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // backend/ (parent of src/ or dist/)
const PORT = Number(process.env.PORT ?? 3210);
const HOST = '127.0.0.1';

const cfg = new ConfigStore(process.env.TRENCHFEED_CONFIG ?? path.join(root, 'config.json'));
const hub: MessageHub = new MessageHub(500, createDefaultEnricher({ o1ApiKey: () => cfg.get().o1ApiKey }), {
  security: createSecurityFetcher(),
  cove: (): CoveOptions => ({ amounts: cfg.get().cove.amounts, affiliateId: svc.affiliateId() }),
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
// Holder security moves slowly: refresh every 10 minutes for tokens called in the last 6h.
setInterval(() => {
  for (const t of hub.activeTokens(6 * 60 * 60 * 1000).slice(0, 40)) {
    if (!t.security || Date.now() - t.security.fetchedAt > 9 * 60 * 1000) hub.refetchSecurity(t.address);
  }
}, 10 * 60 * 1000).unref();
const svc: Services = new Services(cfg, hub);
const hover = createHoverFetchers();
const store = new StateStore(process.env.TRENCHFEED_STATE ?? path.join(root, 'state.json'));
hub.load(store.load());
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

const app = express();
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
attachWs(server, hub);

server.listen(PORT, HOST, () => {
  console.log(`opentrench listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
