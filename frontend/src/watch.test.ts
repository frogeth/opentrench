import { describe, expect, it } from 'vitest';
import type { TokenInfo, WatchEntry } from './types';
import { lastCall, parseUsd, pct, sinceAdded, sortRows, usdInput, type WatchRow } from './watch';

const entry = (address: string, addedAt: number, addedMarketCap?: number): WatchEntry => ({ address, chain: 'evm', addedAt, ...(addedMarketCap ? { addedMarketCap } : {}) });
const token = (address: string, extra: Partial<TokenInfo> = {}): TokenInfo => ({ chain: 'evm', address, seen: 0, calledIn: [], calls: [], firstSeenTs: 0, lastCallTs: 0, ...extra });

describe('watch helpers', () => {
  it('since added is the market cap move from the add', () => {
    expect(sinceAdded(entry('a', 0, 1000), token('a', { marketCap: 2500 }))).toBe(150);
    expect(sinceAdded(entry('a', 0), token('a', { marketCap: 2500 }))).toBeUndefined();
    expect(sinceAdded(entry('a', 0, 1000))).toBeUndefined();
  });

  it('last call is the newest one', () => {
    const calls = [5, 9, 7].map((ts) => ({ author: `u${ts}`, chatName: 'c', source: 'discord' as const, msgId: String(ts), ts }));
    expect(lastCall(token('a', { calls }))?.author).toBe('u9');
    expect(lastCall(token('a'))).toBeUndefined();
  });

  it('sorts by any header, and rows without a value sink either way', () => {
    const rows: WatchRow[] = [
      { e: entry('a', 1), t: token('a', { marketCap: 50, symbol: 'Bee' }) },
      { e: entry('b', 3), t: token('b', { symbol: 'ant' }) },
      { e: entry('c', 2), t: token('c', { marketCap: 10, symbol: 'Cat' }) },
    ];
    const order = (key: any, dir: 'asc' | 'desc') => sortRows(rows, { key, dir }).map((r) => r.e.address);
    expect(order('added', 'desc')).toEqual(['b', 'c', 'a']);
    expect(order('marketCap', 'desc')).toEqual(['a', 'c', 'b']);
    expect(order('marketCap', 'asc')).toEqual(['c', 'a', 'b']);
    expect(order('symbol', 'asc')).toEqual(['b', 'a', 'c']);
  });

  it('parses dollar amounts the way people type them', () => {
    expect(parseUsd('1.2m')).toBe(1_200_000);
    expect(parseUsd(' $500K ')).toBe(500_000);
    expect(parseUsd('2,500,000')).toBe(2_500_000);
    expect(parseUsd('1b')).toBe(1e9);
    expect(parseUsd('')).toBeUndefined();
    expect(parseUsd('lots')).toBeNull();
    expect(parseUsd('0')).toBeNull();
    expect(usdInput(1_200_000)).toBe('1.2m');
    expect(usdInput(500_000)).toBe('500k');
    expect(usdInput(undefined)).toBe('');
  });

  it('formats percents', () => {
    expect(pct(12.345)).toBe('+12.3%');
    expect(pct(-150.4)).toBe('-150%');
    expect(pct(undefined)).toBeNull();
  });
});
