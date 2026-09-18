// Process entry: env → options, one http server, clean exit on SIGTERM/SIGINT
// (Fly and Docker both send SIGTERM; pending room files are flushed on the way out).
import http from 'node:http';
import { createRelay } from './relay.js';

const int = (name: string): number | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(v)}`);
  return n;
};

const port = int('PORT') ?? 8080;
const relay = createRelay({
  accessCode: process.env.RELAY_ACCESS_CODE || undefined,
  maxRooms: int('RELAY_MAX_ROOMS'),
  maxMembers: int('RELAY_MAX_MEMBERS'),
  dataDir: process.env.RELAY_DATA_DIR || undefined,
  bufferHours: int('RELAY_BUFFER_HOURS'),
  log: (m) => console.log(m),
});

const server = http.createServer();
relay.attach(server);
server.listen(port, '0.0.0.0', () => console.log(`opentrench relay v1 listening on :${port} (rooms: ${relay.rooms()})`));

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`opentrench relay: ${signal}, shutting down`);
  relay.close();
  server.close(() => process.exit(0));
  // connections are already terminated; do not let a slow close hold the exit
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
