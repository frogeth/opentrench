import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpfsCache } from './ipfs.js';
import { createApi } from './api.js';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';

const CID = 'bafkreidqbq6z365bcx3acm5i4dxhrol5r6jttjaeukmyv6hvmteakv3b3i';
const answer = (mime: string, body = 'x') => ({ ok: true, headers: new Headers({ 'content-type': mime }), arrayBuffer: async () => new TextEncoder().encode(body).buffer }) as unknown as Response;

/** What is behind a CID is whatever a coin's creator uploaded, served from the app's own address. */
describe('IPFS proxy', () => {
  it('serves raster images and video only: never SVG or a page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'image/svg', 'application/javascript', '']) {
      const cache = new IpfsCache((async () => answer(bad, '<svg onload="alert(1)"/>')) as unknown as typeof fetch);
      expect(await cache.get(CID, ''), bad).toBeNull();
    }
    const png = new IpfsCache((async () => answer('image/png; charset=binary', 'PNG')) as unknown as typeof fetch);
    expect((await png.get(CID, ''))?.mime).toBe('image/png');
  });

  describe('route', () => {
    let server: Server;
    let base: string;
    beforeEach(async () => {
      const cfg = new ConfigStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ipfs-')), 'config.json'));
      const app = express();
      app.use('/api', createApi(cfg, new MessageHub(10), { syncColumnFeeds() {} } as any));
      server = app.listen(0);
      await new Promise((r) => server.once('listening', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });
    afterEach(() => void server.close());

    it('turns away a path that is not plain file names, before asking any gateway', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      // sent byte for byte: fetch would resolve %2e%2e itself (and so would a browser, which is why logo
      // paths with % never reach the page at all, see weblink.ts)
      const raw = (p: string) =>
        new Promise<number>((resolve, reject) => {
          const u = new URL(base);
          http.get({ host: u.hostname, port: u.port, path: `/api/ipfs/${CID}${p}`, headers: { 'x-requested-with': 'opentrench' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }).on('error', reject);
        });
      for (const p of ['/%2e%2e/%2e%2e/config', '/..%2f..%2fconfig', '/./x', '/a%00b', '/a;b', '/a%20b']) expect(await raw(p), p).toBe(404);
      // only the test's own requests went out: none to a gateway
      expect(fetchSpy.mock.calls.every(([u]) => String(u).startsWith('http://127.0.0.1:'))).toBe(true);
      fetchSpy.mockRestore();
    });
  });
});
