import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, __resetOsmintQuoteThrottle } from './api.js';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import type { MintJob } from './types.js';

/** Canned minter: quote() always returns a 'ready' job (chain='ethereum', wallet from the key), send() just records the id. */
class FakeMinter {
  jobs: MintJob[] = [];
  sentIds: string[] = [];
  private n = 0;
  async quote(req: { locator: string; chain?: string; quantity: number }): Promise<MintJob> {
    const id = `mfake${++this.n}`;
    const job: MintJob = {
      id,
      ts: 1,
      updatedAt: 1,
      state: 'ready',
      collection: { slug: 'slug', name: req.locator, address: '0xabc', chain: req.chain ?? 'ethereum', networkId: 1, dropKind: 'Erc721SeaDropV1' },
      quantity: req.quantity,
      wallet: '0x1111111111111111111111111111111111111111',
    };
    this.jobs.push(job);
    return job;
  }
  async send(jobId: string): Promise<MintJob> {
    this.sentIds.push(jobId);
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('no such quote');
    job.state = 'pending';
    return job;
  }
}

function makeStubServices(cfg: ConfigStore) {
  return {
    minter: new FakeMinter(),
    openseaMasked: () => {
      const o = cfg.get().opensea;
      return { hasWallet: !!o.walletKey, walletAddress: o.walletKey ? '0xDEADBEEF' : undefined, rpc: o.rpc, chains: [] };
    },
    rankings: { latest: {} },
    syncColumnFeeds() {},
    j7Recent: () => [],
    mintsRecent: () => [],
  };
}

async function startApp(cfg: ConfigStore, svc: ReturnType<typeof makeStubServices>) {
  const hub = new MessageHub();
  const app = express();
  app.use('/api', createApi(cfg, hub, svc as any));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}/api` };
}

describe('osmint + opensea settings API', () => {
  let file: string;
  let cfg: ConfigStore;
  let svc: ReturnType<typeof makeStubServices>;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    // the quote throttle is module-scoped (shared across every test in this process); reset it so
    // one test's quote call never makes the next test's first quote look like a rapid repeat
    __resetOsmintQuoteThrottle();
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-osmint-')), 'config.json');
    cfg = new ConfigStore(file);
    svc = makeStubServices(cfg);
    ({ server, base } = await startApp(cfg, svc));
  });

  afterEach(() => {
    server.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rejects a bad wallet key', async () => {
    const res = await fetch(`${base}/opensea/wallet`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'not-a-key' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/0x followed by 64 hex/);
    expect(cfg.get().opensea.walletKey).toBeUndefined();
  });

  it('accepts a good wallet key and clears it with an empty string', async () => {
    const good = '0x' + '11'.repeat(32);
    const res = await fetch(`${base}/opensea/wallet`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: good }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasWallet).toBe(true);
    expect(body.walletAddress).toBe('0xDEADBEEF');
    expect(cfg.get().opensea.walletKey).toBe(good);

    const clear = await fetch(`${base}/opensea/wallet`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '' }),
    });
    const clearBody = await clear.json();
    expect(clearBody.hasWallet).toBe(false);
    expect(cfg.get().opensea.walletKey).toBeUndefined();
  });

  it('rejects a plaintext http RPC but accepts https', async () => {
    const evil = await fetch(`${base}/opensea/rpc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'ethereum', url: 'http://evil.example.com' }),
    });
    expect(evil.status).toBe(500);
    expect(cfg.get().opensea.rpc.ethereum).toBeUndefined();

    const ok = await fetch(`${base}/opensea/rpc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'ethereum', url: 'https://x.example.com' }),
    });
    expect(ok.status).toBe(200);
    expect(cfg.get().opensea.rpc.ethereum).toBe('https://x.example.com');
  });

  it('rejects a bad chain identifier for RPC overrides', async () => {
    const res = await fetch(`${base}/opensea/rpc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'Not Valid!', url: 'https://x.example.com' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects an RPC override for a chain that is not in our table', async () => {
    const res = await fetch(`${base}/opensea/rpc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'zora', url: 'https://zora.example.com' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/unknown chain/);
    expect(cfg.get().opensea.rpc.zora).toBeUndefined();
  });

  it('rejects a quote with quantity 0', async () => {
    const res = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-1', quantity: 0 }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/quantity/i);
  });

  it('rejects a quote with an empty locator', async () => {
    const res = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: '  ', quantity: 1 }),
    });
    expect(res.status).toBe(500);
  });

  it('quotes through the fake minter and returns the canned ready job', async () => {
    const res = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-310989788', quantity: 2 }),
    });
    expect(res.status).toBe(200);
    const job = (await res.json()) as MintJob;
    expect(job.state).toBe('ready');
    expect(job.quantity).toBe(2);
    expect(svc.minter.jobs.map((j) => j.id)).toContain(job.id);
  });

  it('rejects a second quote within 1.5 seconds as "slow down"', async () => {
    const first = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-1', quantity: 1 }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-2', quantity: 1 }),
    });
    expect(second.status).toBe(500);
    const body = await second.json();
    expect(body.error).toMatch(/slow down/);
  });

  it('rejects a send with a malformed job id', async () => {
    const res = await fetch(`${base}/osmint/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: '../not-an-id' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/bad job id/);
  });

  it('rejects a send for a job id that does not exist', async () => {
    const res = await fetch(`${base}/osmint/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'mnonexistent' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/no such quote/);
  });

  it('accepts a send for a ready job and records the id on the fake minter', async () => {
    const q = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-1', quantity: 1 }),
    });
    const job = (await q.json()) as MintJob;
    const res = await fetch(`${base}/osmint/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // send() runs fire-and-forget; give the microtask queue a tick to record it
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.minter.sentIds).toContain(job.id);
  });

  it('rejects a send for a job that is not ready', async () => {
    const q = await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-1', quantity: 1 }),
    });
    const job = (await q.json()) as MintJob;
    // force it out of 'ready' as the real Minter would once sending starts
    const stored = svc.minter.jobs.find((j) => j.id === job.id)!;
    stored.state = 'sending';
    const res = await fetch(`${base}/osmint/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/quote is sending/);
  });

  it('GET /osmint/jobs returns the minter jobs list', async () => {
    await fetch(`${base}/osmint/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: 'chump-nft-1', quantity: 1 }),
    });
    const res = await fetch(`${base}/osmint/jobs`);
    const jobs = (await res.json()) as MintJob[];
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('GET /opensea reflects config state', async () => {
    const res = await fetch(`${base}/opensea`);
    const body = await res.json();
    expect(body.hasWallet).toBe(false);
  });
});
