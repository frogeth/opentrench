import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { defaultEnricher } from './enrich.js';
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
const hub: MessageHub = new MessageHub(500, defaultEnricher, {
  cove: (): CoveOptions => ({ amounts: cfg.get().cove.amounts, affiliateId: svc.affiliateId() }),
  blacklist: () => cfg.get().blacklist,
});
const svc: Services = new Services(cfg, hub);
const store = new StateStore(process.env.TRENCHFEED_STATE ?? path.join(root, 'state.json'));
hub.load(store.load());
hub.on('changed', () => store.schedule(() => hub.snapshot()));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}

const app = express();
app.use('/api', createApi(cfg, hub, svc));

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
  console.log(`trenchfeed listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
