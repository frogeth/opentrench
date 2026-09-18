// Process entry: env → options, one http server, clean exit on SIGTERM/SIGINT
// (Fly and Docker both send SIGTERM; pending room files are flushed on the way out).
import http from 'node:http';
import { readEnv } from './env.js';
import { createRelay } from './relay.js';

const { port, options } = readEnv(process.env, (m) => console.warn(`opentrench relay: ${m}`));
const relay = createRelay({ ...options, log: (m) => console.log(m) });

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
