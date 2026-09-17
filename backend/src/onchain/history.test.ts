import { describe, expect, it, vi } from 'vitest';
import { createBlockFinder } from './history.js';

/** a chain with 2-second blocks, block n at time 1_000_000 + 2n, head 5000 */
const chain = (head = 5000, rate = 2) => {
  const calls: string[] = [];
  const f = vi.fn(async (_u: string, init: any) => {
    const tag = JSON.parse(init.body).params[0];
    const n = tag === 'latest' ? head : Number(BigInt(tag));
    calls.push(tag);
    if (n > head) return { ok: true, status: 200, json: async () => ({ result: null }) };
    return { ok: true, status: 200, json: async () => ({ result: { number: '0x' + n.toString(16), timestamp: '0x' + (1_000_000 + rate * n).toString(16) } }) };
  });
  return { f, calls };
};

describe('block at a timestamp', () => {
  it('finds the first block at or after the moment in a handful of reads, and reuses the head for a while', async () => {
    const { f, calls } = chain();
    let clock = 0;
    const at = createBlockFinder(f as any, () => clock);
    // the moment is exactly block 4000's time
    expect(await at('base', 'https://base', (1_000_000 + 8000) * 1000)).toBe(4000);
    expect(calls.length).toBeLessThanOrEqual(6);
    // a moment between blocks 3000 and 3001 → 3001 (the first block that saw it)
    const before = calls.length;
    expect(await at('base', 'https://base', (1_000_000 + 6001) * 1000)).toBe(3001);
    expect(calls.length - before).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c === 'latest')).toHaveLength(1);
    // a moment in the future / at the head is the head
    expect(await at('base', 'https://base', (1_000_000 + 99_999) * 1000)).toBe(5000);
  });
  it('a chain whose head cannot be read gives undefined', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: null }) }));
    expect(await createBlockFinder(f as any)('base', 'https://base', 1)).toBeUndefined();
  });
});
