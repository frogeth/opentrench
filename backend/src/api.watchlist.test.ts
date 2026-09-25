import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { WatchlistService } from './watchlist.js';

const HEADERS = { 'x-requested-with': 'opentrench', 'content-type': 'application/json' } as const;
const W = '0x' + '44'.repeat(20);

describe('watchlist API', () => {
  let server: Server;
  let base: string;
  let cfg: ConfigStore;

  beforeEach(async () => {
    cfg = new ConfigStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wlapi-')), 'config.json'));
    const hub = new MessageHub(500, async () => ({ symbol: 'WAT', marketCap: 5000, priceUsd: 1 }), { watchlist: () => cfg.get().watchlist });
    const watch = new WatchlistService({ cfg, hub });
    watch.start();
    const app = express();
    app.use('/api', createApi(cfg, hub, { syncColumnFeeds() {} } as any, undefined, undefined, watch));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterEach(() => void server.close());

  const call = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });

  it('adds and removes, and the config shows the list', async () => {
    let res = await call('POST', '/watchlist', { add: [W, 'junk'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watchlist: [{ address: W, addedMarketCap: 5000 }], rejected: ['junk'] });
    expect((await (await call('GET', '/config')).json()).watchlist).toMatchObject([{ address: W }]);
    res = await call('POST', '/watchlist', { remove: [W] });
    expect((await res.json()).watchlist).toEqual([]);
  });

  it('sets alerts on a watched token, 404 otherwise', async () => {
    await call('POST', '/watchlist', { add: [W] });
    const res = await call('PUT', `/watchlist/${W}/alerts`, { above: 1e6, movePct: 25 });
    expect(await res.json()).toMatchObject({ address: W, alerts: { above: 1e6, movePct: 25 } });
    expect(cfg.get().watchlist[0].alerts).toEqual({ above: 1e6, movePct: 25 });
    expect((await call('PUT', `/watchlist/0x${'55'.repeat(20)}/alerts`, { above: 1 })).status).toBe(404);
  });
});
