import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import type { ServerEvent, TokenInfo } from './types.js';
import { MarketHistory, WatchlistService, checkAlerts, initialFired } from './watchlist.js';

const MIN = 60_000;
const A = 'tok';

describe('MarketHistory', () => {
  it('has no 1h change until it spans the hour, then measures from an hour ago', () => {
    const h = new MarketHistory();
    const t0 = 1_000_000;
    for (let m = 0; m <= 30; m++) h.add(A, 100 + m, t0 + m * MIN);
    expect(h.change1h(A, t0 + 30 * MIN)).toBeUndefined();
    for (let m = 31; m <= 70; m++) h.add(A, 100 + m, t0 + m * MIN);
    // an hour before minute 70 is minute 10: 110 → 170
    expect(h.change1h(A, t0 + 70 * MIN)).toBeCloseTo((170 / 110 - 1) * 100);
  });

  it('keeps one sample per 25s and forgets past 65 minutes', () => {
    const h = new MarketHistory();
    const t0 = 0;
    for (let s = 0; s < 60; s += 3) h.add(A, 1, t0 + s * 1000);
    expect(h.size(A)).toBe(3); // 0s, 27s, 54s
    h.add(A, 1, t0 + 70 * MIN);
    expect(h.size(A)).toBe(1);
  });

  it('ignores missing or silly market caps and can drop a token', () => {
    const h = new MarketHistory();
    h.add(A, 0, 0);
    h.add(A, NaN, MIN);
    expect(h.size(A)).toBe(0);
    h.add(A, 5, 0);
    h.drop(A);
    expect(h.size(A)).toBe(0);
  });
});

describe('checkAlerts', () => {
  const now = 10 * MIN;
  const fresh = (marketCap: number, change1h?: number) => ({ marketCap, change1h, priceAt: now - 5000 });

  it('fires above once, then re-arms only after dropping 3% under the line', () => {
    const a = { above: 1_000_000 };
    let r = checkAlerts(a, fresh(1_050_000), now);
    expect(r.hits).toEqual([{ kind: 'above', threshold: 1_000_000 }]);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(1_100_000), now);
    expect(r.hits).toEqual([]);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(990_000), now); // under the line but inside the margin
    expect(r.fired.above).toBe(true);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(960_000), now);
    expect(r.fired.above).toBeUndefined();
    r = checkAlerts({ ...a, fired: r.fired }, fresh(1_000_000), now);
    expect(r.hits).toEqual([{ kind: 'above', threshold: 1_000_000 }]);
  });

  it('fires below and re-arms 3% over the line', () => {
    const a = { below: 500_000 };
    let r = checkAlerts(a, fresh(480_000), now);
    expect(r.hits).toEqual([{ kind: 'below', threshold: 500_000 }]);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(510_000), now);
    expect(r.fired.below).toBe(true);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(520_000), now);
    expect(r.fired.below).toBeUndefined();
  });

  it('fires on a move either way and re-arms under half of it', () => {
    const a = { movePct: 30 };
    let r = checkAlerts(a, fresh(1, -31), now);
    expect(r.hits).toEqual([{ kind: 'move', threshold: 30 }]);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(1, 20), now);
    expect(r.fired.move).toBe(true);
    r = checkAlerts({ ...a, fired: r.fired }, fresh(1, 14), now);
    expect(r.fired.move).toBeUndefined();
    // no 1h figure yet: the move alert waits
    expect(checkAlerts(a, fresh(1), now).hits).toEqual([]);
  });

  it('does nothing on a stale or missing price', () => {
    const a = { above: 1 };
    expect(checkAlerts(a, { marketCap: 5, priceAt: now - 3 * MIN }, now)).toEqual({ hits: [], fired: {} });
    expect(checkAlerts(a, { marketCap: 5 }, now).hits).toEqual([]);
    expect(checkAlerts(a, { priceAt: now }, now).hits).toEqual([]);
    expect(checkAlerts({ above: 1, fired: { above: true } }, { marketCap: 0.5, priceAt: now - 3 * MIN }, now).fired).toEqual({ above: true });
  });
});

describe('initialFired', () => {
  it('starts an already-met alert as fired so it does not go off at once', () => {
    expect(initialFired({ above: 1_000_000, below: 10, movePct: 20 }, 2_000_000, 25)).toEqual({ above: true, move: true });
    expect(initialFired({ below: 500 }, 400)).toEqual({ below: true });
    expect(initialFired({ above: 5 }, undefined)).toEqual({});
  });
});

describe('WatchlistService', () => {
  const W = '0x' + '22'.repeat(20);
  const V = '0x' + '33'.repeat(20);
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wl-')), 'config.json');

  function setup(opts: { fetch?: Partial<TokenInfo>; now?: { t: number } } = {}) {
    const cfg = new ConfigStore(tmpFile());
    const clock = opts.now ?? { t: 1_000_000 };
    const fetcher = vi.fn(async () => opts.fetch);
    const hub = new MessageHub(500, fetcher, { watchlist: () => cfg.get().watchlist, retryDelaysMs: [] });
    const sent: string[] = [];
    const svc = new WatchlistService({ cfg, hub, now: () => clock.t, sendSelf: async (m) => void sent.push(m), bootGapMs: 0 });
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    svc.start();
    return { cfg, hub, svc, events, sent, clock, fetcher };
  }
  const market = (hub: MessageHub, address: string, marketCap: number, at: number) => hub.updateMarket(address, { marketCap, priceAt: at, priceSource: 'chain' });

  it('adds contracts found in any text, looks them up, adopts them and broadcasts', async () => {
    const { cfg, hub, svc, events } = setup({ fetch: { symbol: 'WAT', network: 'base', marketCap: 5000, priceUsd: 1 } });
    const r = await svc.add([`look at ${W} and ${V}`, 'nothing here', W]);
    expect(r).toEqual({ added: [W, V], rejected: ['nothing here'] });
    expect(cfg.get().watchlist).toEqual([
      { address: W, chain: 'evm', network: 'base', addedAt: 1_000_000, addedMarketCap: 5000 },
      { address: V, chain: 'evm', network: 'base', addedAt: 1_000_000, addedMarketCap: 5000 },
    ]);
    expect(hub.getToken(W)?.symbol).toBe('WAT');
    expect(events.filter((e) => e.type === 'watchlist').at(-1)).toMatchObject({ entries: cfg.get().watchlist });
    // adding again is a no-op
    expect(await svc.add([W])).toEqual({ added: [], rejected: [] });
  });

  it('remove drops the entry and broadcasts', async () => {
    const { cfg, svc, events } = setup({ fetch: { marketCap: 1, priceUsd: 1 } });
    await svc.add([W, V]);
    svc.remove([W.toUpperCase().replace('0X', '0x')]);
    expect(cfg.get().watchlist.map((e) => e.address)).toEqual([V]);
    expect(events.filter((e) => e.type === 'watchlist').at(-1)).toMatchObject({ entries: [{ address: V }] });
  });

  it('fills in the market cap at add time from the first price when the lookup had none', async () => {
    const { cfg, hub, svc } = setup();
    await svc.add([W]);
    expect(cfg.get().watchlist[0].addedMarketCap).toBeUndefined();
    market(hub, W, 7000, 1_000_000);
    expect(cfg.get().watchlist[0].addedMarketCap).toBe(7000);
  });

  it('fires an alert once as a ping and a Telegram DM, and keeps the fired state', async () => {
    const { cfg, hub, svc, sent, clock } = setup({ fetch: { symbol: 'WAT', marketCap: 900_000, priceUsd: 1 } });
    await svc.add([W]);
    expect(svc.setAlerts(W, { above: 1_000_000, telegram: true })?.alerts).toEqual({ above: 1_000_000, telegram: true });
    market(hub, W, 1_100_000, clock.t);
    clock.t += 30_000;
    market(hub, W, 1_200_000, clock.t);
    const alerts = hub.mentions().filter((m) => m.alert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].msg.text).toBe('$WAT crossed above $1M');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('$WAT crossed above $1M');
    expect(cfg.get().watchlist[0].alerts?.fired).toEqual({ above: true });
  });

  it('an alert set while its condition holds starts fired', async () => {
    const { hub, svc, clock } = setup({ fetch: { marketCap: 2_000_000, priceUsd: 1 } });
    await svc.add([W]);
    expect(svc.setAlerts(W, { above: 1_000_000, fired: {} })?.alerts).toEqual({ above: 1_000_000, fired: { above: true } });
    market(hub, W, 2_100_000, clock.t);
    expect(hub.mentions().filter((m) => m.alert)).toHaveLength(0);
    // clearing every threshold removes the alerts
    expect(svc.setAlerts(W, {})?.alerts).toBeUndefined();
  });

  it('publishes its own 1h change once it has an hour of samples', async () => {
    const { hub, svc, clock } = setup({ fetch: { marketCap: 100, priceUsd: 1 } });
    await svc.add([W]);
    for (let m = 0; m <= 60; m++) {
      market(hub, W, 100 + m, clock.t);
      clock.t += MIN;
    }
    market(hub, W, 200, clock.t);
    expect(svc.ownsChange1h(W)).toBe(true);
    expect(hub.getToken(W)?.change1h).toBeCloseTo(98);
  });

  it('puts watched tokens back in the hub at boot', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ watchlist: [{ address: W, chain: 'evm', addedAt: 1 }] }));
    const cfg = new ConfigStore(file);
    const hub = new MessageHub(500, undefined, { watchlist: () => cfg.get().watchlist });
    new WatchlistService({ cfg, hub }).start();
    expect(hub.getToken(W)).toMatchObject({ address: W, calls: [], lastCallTs: 0 });
  });
});
