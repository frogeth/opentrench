import { describe, expect, it, vi } from 'vitest';
import { routeCall, type PluginContext } from './route';

/** the two shapes an address may take; the actions that name one to the user accept nothing else */
const EVM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function ctx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    id: 'hello-feed',
    manifest: { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: ['https://example.com'], permissions: ['storage'], ui: false, description: '' },
    api: {
      pluginPost: vi.fn(async () => ({ ok: true as const, id: 'x' })),
      pluginPatch: vi.fn(async () => ({})),
      pluginStorage: vi.fn(async () => ({ a: 1 })),
      pluginStorageSet: vi.fn(async () => ({})),
      pluginSettings: vi.fn(async () => ({ values: { limit: 3 }, schema: [{ key: 'limit', label: 'Limit', type: 'number' }] })),
      pluginFetch: vi.fn(async () => ({ status: 200, headers: {}, body: '{"ok":true}' })),
      pluginSites: vi.fn(async () => ({ sites: ['https://example.com'], signedIn: [], available: true })),
      pluginSignIn: vi.fn(async () => ({})),
      pluginLog: vi.fn(async () => ({})),
    } as any,
    actions: { openToken: vi.fn(), jump: vi.fn(), buy: vi.fn(), research: vi.fn(), copy: vi.fn(), notify: vi.fn() },
    snapshot: { messages: () => [{ id: 'm1', chatName: 'A' } as any], tokens: () => ({ '0xabc': { address: '0xabc' } as any }) },
    ui: { setTitle: vi.fn(), setSubtitle: vi.fn(), badge: vi.fn(), setSchema: vi.fn() },
    ...over,
  };
}

describe('routeCall', () => {
  it('reads the feed without any permission', async () => {
    expect(await routeCall(ctx(), { method: 'feed.messages', args: [{ limit: 5 }] })).toEqual([{ id: 'm1', chatName: 'A' }]);
    expect(await routeCall(ctx(), { method: 'feed.token', args: ['0xabc'] })).toEqual({ address: '0xabc' });
  });

  it('refuses feed.post, actions and storage without the permission, and allows them with it', async () => {
    await expect(routeCall(ctx(), { method: 'feed.post', args: [{ id: '1', chat: 'c', author: 'a', text: 't' }] })).rejects.toThrow('feed:write');
    await expect(routeCall(ctx(), { method: 'actions.openToken', args: ['0xabc'] })).rejects.toThrow('actions');
    const c = ctx({ manifest: { ...ctx().manifest, permissions: ['feed:write', 'actions', 'storage'] } });
    await routeCall(c, { method: 'feed.post', args: [{ id: '1', chat: 'c', author: 'a', text: 't' }] });
    expect(c.api.pluginPost).toHaveBeenCalledWith('hello-feed', { id: '1', chat: 'c', author: 'a', text: 't' });
    await routeCall(c, { method: 'actions.openToken', args: [EVM] });
    expect(c.actions.openToken).toHaveBeenCalledWith(EVM);
    expect(await routeCall(c, { method: 'storage.get', args: ['a'] })).toBe(1);
  });

  it('fetch returns the proxy result as plain data, sites map to the api', async () => {
    const r = await routeCall(ctx(), { method: 'fetch', args: ['https://example.com/x', { method: 'GET' }] });
    expect(r).toEqual({ status: 200, headers: {}, body: '{"ok":true}' });
    expect(await routeCall(ctx(), { method: 'sites.status', args: ['https://example.com'] })).toEqual({ signedIn: false, available: true });
  });

  it('the actions that name an address to the user take a contract address and nothing else', async () => {
    const c = ctx({ manifest: { ...ctx().manifest, permissions: ['actions'] } });
    for (const method of ['actions.openToken', 'actions.buy', 'actions.research']) {
      await routeCall(c, { method, args: [EVM] });
      await routeCall(c, { method, args: [SOL] });
      // a plugin must not be able to write the confirmation bar's text: it says only what it was given
      for (const bad of ['0xdac17f958d2ee523a2206206994597c13d831ec7 (verified)', 'not an address', '0xdead', `${EVM}0`, 'https://example.com', '0'])
        await expect(routeCall(c, { method, args: [bad] })).rejects.toThrow('contract address');
    }
    expect(c.actions.buy).toHaveBeenCalledTimes(2);
    expect(c.actions.buy).toHaveBeenCalledWith(EVM);
    expect(c.actions.buy).toHaveBeenLastCalledWith(SOL);
  });

  it('unknown methods and bad args are errors, never silent', async () => {
    await expect(routeCall(ctx(), { method: 'window.open', args: [] })).rejects.toThrow('unknown method');
    // the permission is checked before the argument, so this one has it and still fails on the argument
    const c = ctx({ manifest: { ...ctx().manifest, permissions: ['actions'] } });
    await expect(routeCall(c, { method: 'actions.copy', args: [123] })).rejects.toThrow('text');
    expect(c.actions.copy).not.toHaveBeenCalled();
  });

  it('settings.get hands the plugin its own answers, not the form the app renders', async () => {
    expect(await routeCall(ctx(), { method: 'settings.get', args: [] })).toEqual({ limit: 3 });
  });
  it('settings.schema takes a valid schema and refuses a bad key', async () => {
    const setSchema = vi.fn();
    const c = ctx({ ui: { setTitle: vi.fn(), setSubtitle: vi.fn(), badge: vi.fn(), setSchema } });
    const schema = [
      { key: 'limit', label: 'How many', type: 'number', default: 10 },
      { key: 'api-key', label: 'API key', type: 'secret' },
    ];
    expect(await routeCall(c, { method: 'settings.schema', args: [schema] })).toBe(null);
    expect(setSchema).toHaveBeenCalledWith(schema);
    await expect(routeCall(c, { method: 'settings.schema', args: [[{ key: 'no spaces', label: 'x', type: 'text' }]] })).rejects.toThrow('key');
    await expect(routeCall(c, { method: 'settings.schema', args: [[{ key: 'k', label: 'x', type: 'colour' }]] })).rejects.toThrow('type');
    await expect(routeCall(c, { method: 'settings.schema', args: ['nope'] })).rejects.toThrow('schema');
    for (const key of ['__proto__', 'constructor', 'prototype', 'ConStructor'])
      await expect(routeCall(c, { method: 'settings.schema', args: [[{ key, label: 'x', type: 'text' }]] })).rejects.toThrow('reserved');
    await expect(
      routeCall(c, { method: 'settings.schema', args: [[{ key: 'k', label: 'one', type: 'text' }, { key: 'k', label: 'two', type: 'text' }]] }),
    ).rejects.toThrow('twice');
    expect(setSchema).toHaveBeenCalledTimes(1);
  });

  it('fetch passes only strings through to the proxy and hands back truncated', async () => {
    const c = ctx();
    (c.api as any).pluginFetch = vi.fn(async () => ({ status: 206, headers: { 'content-type': 'text/plain' }, body: 'abc', truncated: true }));
    const r = await routeCall(c, {
      method: 'fetch',
      args: ['https://example.com/x', { method: 'POST', headers: { 'x-ok': 'yes', 'x-bad': 7 }, body: 'hi', credentials: 'include', signal: {} }],
    });
    expect(c.api.pluginFetch).toHaveBeenCalledWith('hello-feed', 'https://example.com/x', { method: 'POST', headers: { 'x-ok': 'yes' }, body: 'hi' });
    expect(r).toEqual({ status: 206, headers: { 'content-type': 'text/plain' }, body: 'abc', truncated: true });
  });

  it('feed.messages filters by chat id as well as name, and caps the limit', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, chatId: 'plugin:p:c', chatName: 'A' }) as any);
    const c = ctx({ snapshot: { messages: () => [...many, { id: 'other', chatId: 'telegram:9', chatName: 'B' } as any], tokens: () => ({}) } });
    const byId = (await routeCall(c, { method: 'feed.messages', args: [{ chat: 'plugin:p:c', limit: 3 }] })) as unknown[];
    expect(byId).toHaveLength(3);
    const byName = (await routeCall(c, { method: 'feed.messages', args: [{ chat: 'B' }] })) as { id: string }[];
    expect(byName.map((m) => m.id)).toEqual(['other']);
    expect((await routeCall(c, { method: 'feed.messages', args: [{ limit: 10_000 }] })) as unknown[]).toHaveLength(500);
  });

  it('feed.token for an address nobody called is null, not undefined', async () => {
    expect(await routeCall(ctx(), { method: 'feed.token', args: ['0xdead'] })).toBe(null);
  });

  it('looks tokens and storage up as data, so inherited members are misses', async () => {
    const c = ctx({ manifest: { ...ctx().manifest, permissions: ['storage'] } });
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(await routeCall(c, { method: 'feed.token', args: [key] })).toBe(null);
      expect(await routeCall(c, { method: 'storage.get', args: [key] })).toBe(null);
    }
  });

  it('feed.messages leaves out the messages the feed hides', async () => {
    const c = ctx({
      snapshot: {
        messages: () => [{ id: 'm1', chatName: 'A' }, { id: 'm2', chatName: 'A', hidden: true }, { id: 'm3', chatName: 'A' }] as any,
        tokens: () => ({}),
      },
    });
    const got = (await routeCall(c, { method: 'feed.messages', args: [{}] })) as { id: string }[];
    expect(got.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('ui.badge is a whole number 0..9999 and clears on null or nothing at all', async () => {
    const c = ctx();
    const badge = c.ui.badge as any;
    for (const [given, want] of [[3.7, 3], [-5, 0], [50_000, 9999], ['12', 12], [NaN, 0], [null, null], [undefined, null]] as const) {
      await routeCall(c, { method: 'ui.badge', args: [given] });
      expect(badge).toHaveBeenLastCalledWith(want);
    }
  });

  it('an empty title clears it rather than failing, a non-string still fails', async () => {
    const c = ctx();
    await routeCall(c, { method: 'ui.setTitle', args: [''] });
    expect(c.ui.setTitle).toHaveBeenCalledWith('');
    await expect(routeCall(c, { method: 'ui.setTitle', args: [7] })).rejects.toThrow('title');
  });

  it('a notification carries the plugin name, so it cannot pass for the app', async () => {
    const c = ctx({ manifest: { ...ctx().manifest, permissions: ['actions'] } });
    await routeCall(c, { method: 'actions.notify', args: ['Whale in', 'body'] });
    expect(c.actions.notify).toHaveBeenCalledWith('[Hello feed] Whale in', 'body');
  });

  it('a log the backend refuses never becomes an unhandled rejection', async () => {
    const c = ctx();
    (c.api as any).pluginLog = vi.fn(async () => {
      throw new Error('backend down');
    });
    expect(await routeCall(c, { method: 'log', args: ['info', 'hello', { a: 1 }] })).toBe(null);
    expect(c.api.pluginLog).toHaveBeenCalledWith('hello-feed', 'info', 'hello {"a":1}');
  });
});
