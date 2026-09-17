import { describe, expect, it, vi } from 'vitest';
import { createEndpoints } from './endpoints.js';
import { CHAINS } from './chains.js';

// an Alchemy that serves Base (8453) and Solana, answers the wrong id for Ethereum, and 401s the rest
const alchemy = vi.fn(async (url: string, init: any) => {
  const method = JSON.parse(init.body).method;
  if (url.startsWith('https://base-mainnet')) return { ok: true, status: 200, json: async () => ({ result: '0x2105' }) };
  if (url.startsWith('https://eth-mainnet')) return { ok: true, status: 200, json: async () => ({ result: '0x2105' }) };
  if (url.startsWith('https://solana-mainnet') && method === 'getVersion') return { ok: true, status: 200, json: async () => ({ result: { 'solana-core': '2.1' } }) };
  return { ok: false, status: 401, json: async () => ({}) };
});

describe('endpoints', () => {
  it('public by default, custom wins, Alchemy only after a probe shows it serves the chain', async () => {
    let cfg = { alchemyKey: undefined as string | undefined, rpc: {} as Record<string, string> };
    const log = vi.fn();
    const ep = createEndpoints(() => cfg, alchemy as any, log);
    expect(ep.urlFor('base')).toEqual({ url: CHAINS.base.rpc, source: 'public' });
    expect(ep.urlFor('nope')).toBeUndefined();

    cfg = { alchemyKey: 'k', rpc: {} };
    expect(ep.urlFor('base')!.source).toBe('public'); // not probed yet
    const st = await ep.probeAlchemy('k');
    expect(st.chains.sort()).toEqual(['base', 'solana']);
    expect(st.error).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ethereum answered chain id 8453'));
    expect(ep.urlFor('base')).toEqual({ url: 'https://base-mainnet.g.alchemy.com/v2/k', source: 'alchemy' });
    expect(ep.urlFor('solana')!.source).toBe('alchemy');
    expect(ep.urlFor('ethereum')!.source).toBe('public');
    expect(ep.urlFor('robinhood')!.source).toBe('public'); // Alchemy does not serve it

    cfg = { alchemyKey: 'k', rpc: { base: 'https://my.base' } };
    expect(ep.urlFor('base')).toEqual({ url: 'https://my.base', source: 'custom' });
    expect(ep.sources().base).toBe('custom');
    expect(ep.sources().solana).toBe('alchemy');
  });
  it('a key that answers nowhere reports an error; clearing the key forgets the chains', async () => {
    const dead = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    let cfg = { alchemyKey: 'bad' as string | undefined, rpc: {} };
    const ep = createEndpoints(() => cfg, dead as any);
    const st = await ep.probeAlchemy('bad');
    expect(st.chains).toEqual([]);
    expect(st.error).toMatch(/no chain/);
    expect(ep.urlFor('base')!.source).toBe('public');
    cfg = { alchemyKey: undefined, rpc: {} };
    expect((await ep.probeAlchemy(undefined)).hasKey).toBe(false);
  });
});
