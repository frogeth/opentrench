import { evmBlock, type FetchLike } from './rpc.js';

/**
 * Which block a chain was at when something happened. Chains keep steady block times, so from
 * two known (block, time) samples the block at a timestamp is an interpolation, refined with a
 * couple of reads until the block's own timestamp brackets the moment. A few requests per
 * lookup, then one for every later lookup on the same chain in the same minute.
 */
export interface BlockAt {
  (network: string, url: string, tsMs: number): Promise<number | undefined>;
}

interface Sample {
  number: number;
  ts: number;
}

export function createBlockFinder(fetchImpl: FetchLike = fetch as unknown as FetchLike, now: () => number = Date.now): BlockAt {
  const heads = new Map<string, { at: number; head: Sample }>();
  const rates = new Map<string, number>(); // seconds per block
  const known = new Map<string, Sample[]>();
  const HEAD_TTL_MS = 30_000;
  const remember = (network: string, s: Sample) => {
    const list = known.get(network) ?? [];
    list.push(s);
    if (list.length > 64) list.shift();
    known.set(network, list);
  };
  const hex = (n: number) => '0x' + n.toString(16);
  return async (network, url, tsMs) => {
    const ts = Math.floor(tsMs / 1000);
    let h = heads.get(network);
    if (!h || now() - h.at > HEAD_TTL_MS) {
      const head = await evmBlock(url, 'latest', fetchImpl);
      if (!head) return undefined;
      h = { at: now(), head };
      heads.set(network, h);
      remember(network, head);
    }
    if (ts >= h.head.ts) return h.head.number;
    // a sample already bracketing the moment closely enough (same block time)
    const samples = known.get(network) ?? [];
    let rate = rates.get(network);
    if (rate === undefined) {
      // measure: a block well behind the head
      const back = Math.max(0, h.head.number - 1000);
      const b = await evmBlock(url, hex(back), fetchImpl);
      if (!b || b.number === h.head.number) return undefined;
      rate = Math.max(0.05, (h.head.ts - b.ts) / (h.head.number - b.number));
      rates.set(network, rate);
      remember(network, b);
    }
    // interpolate from the nearest known sample, refine until the block brackets ts
    let guess = Math.max(0, Math.round(h.head.number - (h.head.ts - ts) / rate));
    for (let i = 0; i < 8; i++) {
      const s = samples.find((x) => x.number === guess) ?? (await evmBlock(url, hex(guess), fetchImpl));
      if (!s) return undefined;
      if (!samples.includes(s)) remember(network, s);
      const diff = s.ts - ts; // seconds the block is past the moment
      if (diff >= 0 && diff < rate * 1.5) return s.number; // the first block at or after ts, near enough
      if (diff >= 0 && guess > 0) {
        const prev = await evmBlock(url, hex(guess - 1), fetchImpl);
        if (prev) remember(network, prev);
        if (!prev || prev.ts < ts) return s.number; // s is the first block at/after ts
        guess = Math.max(0, guess - Math.max(1, Math.round(diff / rate)));
        continue;
      }
      // block is before ts: step forward
      const step = Math.max(1, Math.round(-diff / rate));
      guess = Math.min(h.head.number, guess + step);
    }
    return guess;
  };
}
