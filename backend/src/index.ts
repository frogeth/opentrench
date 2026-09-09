import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { fetchToken } from './dexscreener.js';
import { Services } from './services.js';
import { createApi } from './api.js';
import { attachWs } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // backend/ (parent of src/ or dist/)
const PORT = Number(process.env.PORT ?? 3210);
const HOST = '127.0.0.1';

const cfg = new ConfigStore(process.env.TRENCHFEED_CONFIG ?? path.join(root, 'config.json'));
const hub = new MessageHub(500, fetchToken);
const svc = new Services(cfg, hub);

const app = express();
app.use('/api', createApi(cfg, hub, svc));

const dist = path.resolve(root, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);
attachWs(server, hub);

server.listen(PORT, HOST, () => {
  console.log(`trenchfeed listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
