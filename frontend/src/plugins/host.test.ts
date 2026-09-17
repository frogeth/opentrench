import { describe, expect, it, vi } from 'vitest';
import { createHostLoop } from './host';
import type { PluginContext } from './route';

function ctx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    id: 'hello-feed',
    manifest: { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: [], permissions: [], ui: true, description: '' },
    api: { pluginLog: vi.fn(async () => ({})) } as any,
    actions: { openToken: vi.fn(), jump: vi.fn(), buy: vi.fn(), research: vi.fn(), copy: vi.fn(), notify: vi.fn() },
    snapshot: { messages: () => [], tokens: () => ({}) },
    ui: { setTitle: vi.fn(), setSubtitle: vi.fn(), badge: vi.fn(), setSchema: vi.fn() },
    ...over,
  };
}

const call = (over: Record<string, unknown> = {}) => ({ ot: 1, kind: 'call', id: 1, method: 'ui.setTitle', args: ['hi'], ...over });

describe('createHostLoop', () => {
  it('answers a well-formed call with a result carrying the same id', async () => {
    const post = vi.fn();
    const c = ctx();
    await createHostLoop({ ctx: c, post }).handle(call({ id: 7 }));
    expect(c.ui.setTitle).toHaveBeenCalledWith('hi');
    expect(post).toHaveBeenCalledWith({ ot: 1, kind: 'result', id: 7, value: null });
  });

  it('ignores anything that is not an ot call envelope', async () => {
    const post = vi.fn();
    const c = ctx();
    const loop = createHostLoop({ ctx: c, post });
    for (const bad of [
      null,
      'hello',
      { ot: 2, kind: 'call', id: 1, method: 'ui.setTitle', args: [] },
      call({ kind: 'result' }),
      call({ id: '1' }),
      call({ id: 1.5 }),
      call({ method: 7 }),
      call({ args: 'hi' }),
    ])
      await loop.handle(bad);
    expect(post).not.toHaveBeenCalled();
    expect(c.ui.setTitle).not.toHaveBeenCalled();
  });

  it('refuses arguments over the cap before the router sees them', async () => {
    const post = vi.fn();
    const c = ctx();
    await createHostLoop({ ctx: c, post, argsMax: 100 }).handle(call({ args: ['x'.repeat(500)] }));
    expect(c.ui.setTitle).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ ot: 1, kind: 'result', id: 1, error: 'arguments too large' });
  });

  it('refuses arguments it cannot even measure', async () => {
    const post = vi.fn();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await createHostLoop({ ctx: ctx(), post }).handle(call({ args: [cycle] }));
    expect(post).toHaveBeenCalledWith({ ot: 1, kind: 'result', id: 1, error: 'arguments too large' });
  });

  it('spends a call budget and refills it over time', async () => {
    const post = vi.fn();
    const onError = vi.fn();
    let clock = 0;
    const c = ctx();
    const loop = createHostLoop({ ctx: c, post, budget: { perSecond: 2, burst: 3 }, onError, now: () => clock });
    for (let i = 0; i < 5; i++) await loop.handle(call({ id: i }));
    expect(post.mock.calls.map(([m]) => (m as { error?: string }).error)).toEqual([undefined, undefined, undefined, 'too many calls', 'too many calls']);
    expect(c.ui.setTitle).toHaveBeenCalledTimes(3);
    // two rejections in the same second are one complaint, not two
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('too many calls');
    // a second later the bucket holds two more
    clock = 1000;
    await loop.handle(call({ id: 9 }));
    await loop.handle(call({ id: 10 }));
    await loop.handle(call({ id: 11 }));
    expect(c.ui.setTitle).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a refused call still costs budget, and the budget is checked before the size', async () => {
    const post = vi.fn();
    const c = ctx();
    const loop = createHostLoop({ ctx: c, post, argsMax: 100, budget: { perSecond: 1, burst: 1 }, now: () => 0 });
    await loop.handle(call({ id: 1, args: ['x'.repeat(500)] }));
    await loop.handle(call({ id: 2 }));
    expect(post.mock.calls.map(([m]) => (m as { error?: string }).error)).toEqual(['arguments too large', 'too many calls']);
    expect(c.ui.setTitle).not.toHaveBeenCalled();
  });

  it('answers only the load of the code it was made for, and stamps what it sends', async () => {
    const post = vi.fn();
    const c = ctx();
    const loop = createHostLoop({ ctx: c, post, gen: 2 });
    await loop.handle(call({ id: 1, gen: 1 }));
    await loop.handle(call({ id: 2 }));
    expect(post).not.toHaveBeenCalled();
    expect(c.ui.setTitle).not.toHaveBeenCalled();
    await loop.handle(call({ id: 3, gen: 2 }));
    expect(post).toHaveBeenCalledWith({ ot: 1, kind: 'result', id: 3, gen: 2, value: null });
  });

  it('turns a value the frame cannot receive into an error for that call', async () => {
    const post = vi.fn((msg: unknown) => {
      if (msg && typeof msg === 'object' && 'value' in msg) throw new Error('could not be cloned');
    });
    await createHostLoop({ ctx: ctx(), post }).handle(call({ method: 'feed.messages', args: [{}] }));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toEqual({ ot: 1, kind: 'result', id: 1, error: 'result is not transferable' });
  });

  it('surfaces a refused permission and an unknown method to the host', async () => {
    const post = vi.fn();
    const onError = vi.fn();
    const loop = createHostLoop({ ctx: ctx(), post, onError });
    await loop.handle(call({ id: 1, method: 'actions.buy', args: ['0xabc'] }));
    await loop.handle(call({ id: 2, method: 'window.open', args: [] }));
    expect(post.mock.calls[0][0]).toMatchObject({ id: 1, error: expect.stringContaining('actions') });
    expect(post.mock.calls[1][0]).toMatchObject({ id: 2, error: 'unknown method window.open' });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith('unknown method window.open');
  });

  it('a bad argument answers the call without bothering the host', async () => {
    const post = vi.fn();
    const onError = vi.fn();
    await createHostLoop({ ctx: ctx(), post, onError }).handle(call({ method: 'ui.setTitle', args: [42] }));
    expect(post.mock.calls[0][0]).toMatchObject({ id: 1, error: 'title must be a string' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('says nothing more once disposed', async () => {
    const post = vi.fn();
    const loop = createHostLoop({ ctx: ctx(), post });
    loop.dispose();
    await loop.handle(call());
    expect(post).not.toHaveBeenCalled();
  });
});
