import { describe, expect, it } from 'vitest';
import { MarketHistory, checkAlerts, initialFired } from './watchlist.js';

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
