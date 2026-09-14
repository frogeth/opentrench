import { describe, expect, it, vi } from 'vitest';
import { __resetRateLimit, fetchGeckoTerminalMulti, fetchOhlcv, gtThrottled } from './geckoterminal.js';

describe('fetchOhlcv', () => {
  it('names the token so GT returns its side of the pool, and the page boundary', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [] } } }) }) as any);
    await fetchOhlcv('solana', 'DBsTYngQkjsHqaiNNbnEpqDYp5GyYhzFaaW6s5UWQUn9', '1m', 5, fetchImpl, 1_700_000_060, 'B3STjzr94bn61TF9qXhAiK98HwypNoyMc8tr78f3QuCQ');
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('/networks/solana/pools/DBsTYngQkjsHqaiNNbnEpqDYp5GyYhzFaaW6s5UWQUn9/ohlcv/minute?');
    expect(url).toContain('&before_timestamp=1700000060');
    expect(url).toContain('&token=B3STjzr94bn61TF9qXhAiK98HwypNoyMc8tr78f3QuCQ');
  });
  it('leaves the side to GT only when no token is given', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [] } } }) }) as any);
    await fetchOhlcv('base', 'pool', '5m', 10, fetchImpl);
    expect(String(fetchImpl.mock.calls[0][0])).not.toMatch(/token=|before_timestamp=/);
  });

  it('after a 429, candles stand aside for a minute while market lookups still go out', async () => {
    __resetRateLimit();
    const calls: string[] = [];
    let status = 429;
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: status === 200, status, json: async () => ({ data: [] }) } as any;
    });
    await expect(fetchGeckoTerminalMulti('base', ['0xa'], fetchImpl)).rejects.toThrow('429');
    expect(gtThrottled()).toBe(true);
    status = 200;
    await expect(fetchOhlcv('base', 'pool', '1m', 5, fetchImpl)).rejects.toThrow('reserved for market data');
    expect(calls.length).toBe(1); // the candle request never left the machine
    await fetchGeckoTerminalMulti('base', ['0xa'], fetchImpl);
    expect(calls.length).toBe(2); // market data still asks
    __resetRateLimit();
    await fetchOhlcv('base', 'pool', '1m', 5, fetchImpl);
    expect(calls.length).toBe(3);
  }, 20_000); // the queue spaces real requests 2.5s apart
});
