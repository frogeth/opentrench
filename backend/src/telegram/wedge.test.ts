import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramWrapper } from './client.js';

/**
 * A wedged connection: updates keep arriving but no request is ever answered (getMe, getDialogs
 * hang). 2026-09-24 → 25 the backend sat like that for 19 h; the rail showed no Telegram chats.
 */
const never = () => new Promise<never>(() => {});

function wedged() {
  const w = new TelegramWrapper(1, 'hash', 'session');
  (w as any).state = 'connected';
  const client = { getMe: vi.fn(never), getDialogs: vi.fn(never), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  (w as any).client = client;
  const reconnect = vi.spyOn(w, 'connect').mockResolvedValue();
  return { w, client, reconnect };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a wedged Telegram connection', () => {
  it('is rebuilt from the saved session after two failed health probes in a row', async () => {
    const { w, reconnect } = wedged();
    const first = (w as any).healthCheck();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(reconnect).not.toHaveBeenCalled();
    expect(w.state).toBe('connecting');
    const second = (w as any).healthCheck();
    await vi.advanceTimersByTimeAsync(15_000);
    await second;
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not stack health checks while one is still waiting', async () => {
    const { w, client } = wedged();
    void (w as any).healthCheck();
    void (w as any).healthCheck();
    expect(client.getMe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
  });

  it('gives up on a dialog list that never comes, so the next caller asks again instead of waiting forever', async () => {
    const { w, client } = wedged();
    const first = expect(w.listDialogs()).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    void w.listDialogs().catch(() => {});
    expect(client.getDialogs).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
  });

  it('serves the last good dialog list while the connection is stuck', async () => {
    const { w } = wedged();
    const list = [{ id: '-1001', title: 'Green Garden', type: 'group' as const }];
    (w as any).dialogsCache = { at: Date.now() - 120_000, list };
    const p = w.listDialogs();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual(list);
  });
});
