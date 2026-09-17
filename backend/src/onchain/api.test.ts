import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ConfigStore } from '../config.js';
import { createEndpoints } from './endpoints.js';
import { createMarketApi } from './api.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'market-api-'));
const cfg = new ConfigStore(path.join(tmp, 'config.json'));
// an Alchemy that serves Base only, and only for the one good key
const alchemy = vi.fn(async (url: string) => (url === 'https://base-mainnet.g.alchemy.com/v2/goodkey_1234' ? { ok: true, status: 200, json: async () => ({ result: '0x2105' }) } : { ok: false, status: 401, json: async () => ({}) }));
const endpoints = createEndpoints(() => ({ alchemyKey: cfg.get().marketData.alchemyKey, rpc: cfg.get().rpc }), alchemy as any);
const pricer = { status: () => ({ base: { live: 3, skipped: 1, lastOkAt: 1 } }), isLive: () => false, reason: () => undefined, refresh: async () => {} };
const app = express();
app.use('/api', createMarketApi(cfg, endpoints, pricer as any));
let server: ReturnType<typeof app.listen>;
let base = '';
const j = (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-requested-with': 'opentrench' }) =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeAll(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('market api', () => {
  it('GET /market lists every chain with its source and the pricer counts', async () => {
    const r = await j('GET', '/market');
    expect(r.status).toBe(200);
    expect(r.body.alchemy.hasKey).toBe(false);
    const b = r.body.chains.find((c: any) => c.network === 'base');
    expect(b).toMatchObject({ name: 'Base', source: 'public', live: 3, skipped: 1, alchemy: true });
    expect(r.body.chains.find((c: any) => c.network === 'ethereum').alchemy).toBe(true);
  });
  it('writes need the app header', async () => {
    expect((await j('PUT', '/market/alchemy', { key: 'abcdefgh12345' }, {})).status).toBe(403);
    expect((await j('PUT', '/market/rpc', { chain: 'base', url: 'https://x' }, {})).status).toBe(403);
  });
  it('saving an Alchemy key probes it; the chains it serves switch to it; a dead key is refused and nothing is stored', async () => {
    const bad = await j('PUT', '/market/alchemy', { key: 'deaddeaddead' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/no chain/);
    expect(cfg.get().marketData.alchemyKey).toBeUndefined();
    expect((await j('PUT', '/market/alchemy', { key: 'not a key!' })).status).toBe(400);
    const ok = await j('PUT', '/market/alchemy', { key: 'goodkey_1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.alchemy).toMatchObject({ hasKey: true, chains: ['base'] });
    expect(ok.body.chains.find((c: any) => c.network === 'base').source).toBe('alchemy');
    expect(ok.body.chains.find((c: any) => c.network === 'ethereum').source).toBe('public');
    expect(cfg.get().marketData.alchemyKey).toBe('goodkey_1234');
    expect(cfg.masked().marketData).toEqual({ hasAlchemyKey: true });
    expect(JSON.stringify(cfg.masked())).not.toContain('goodkey');
    const off = await j('PUT', '/market/alchemy', { key: '' });
    expect(off.body.alchemy.hasKey).toBe(false);
    expect(cfg.get().marketData.alchemyKey).toBeUndefined();
  });
  it('a custom RPC must be https or local, for a known chain, and wins over everything', async () => {
    expect((await j('PUT', '/market/rpc', { chain: 'base', url: 'http://evil.example/rpc' })).status).toBe(400);
    expect((await j('PUT', '/market/rpc', { chain: 'base', url: 'https://' })).status).toBe(400);
    expect((await j('PUT', '/market/rpc', { chain: 'nope', url: 'https://x.y' })).status).toBe(400);
    const r = await j('PUT', '/market/rpc', { chain: 'base', url: 'https://my.node/rpc' });
    expect(r.status).toBe(200);
    expect(r.body.rpc).toEqual({ base: 'https://my.node/rpc' });
    expect(r.body.chains.find((c: any) => c.network === 'base').source).toBe('custom');
    expect(endpoints.urlFor('base')).toEqual({ url: 'https://my.node/rpc', source: 'custom' });
    const local = await j('PUT', '/market/rpc', { chain: 'solana', url: 'http://localhost:8899' });
    expect(local.status).toBe(200);
    const cleared = await j('PUT', '/market/rpc', { chain: 'base', url: '' });
    expect(cleared.body.rpc).toEqual({ solana: 'http://localhost:8899' });
  });
});
