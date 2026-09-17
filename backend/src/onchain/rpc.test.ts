import { describe, expect, it, vi } from 'vitest';
import { evmCalls, evmCallsDetailed, evmChainId, isRevert, solanaAccounts, solanaAlive } from './rpc.js';
import { createQuoteSource } from './quotes.js';

const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));

describe('evm batch calls', () => {
  it('sends one batch, aligns results by id, leaves errors undefined', async () => {
    const f = reply([
      { jsonrpc: '2.0', id: 1, result: '0x' + '2'.padStart(64, '0') },
      { jsonrpc: '2.0', id: 0, result: '0x' + '1'.padStart(64, '0') },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'execution reverted' } },
    ]);
    const r = await evmCalls('https://rpc', [
      { to: '0xa', data: '0x01' },
      { to: '0xb', data: '0x02' },
      { to: '0xc', data: '0x03' },
    ], f);
    expect(r).toEqual(['0x' + '1'.padStart(64, '0'), '0x' + '2'.padStart(64, '0'), undefined]);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body).toHaveLength(3);
    expect(body[2]).toMatchObject({ method: 'eth_call', params: [{ to: '0xc', data: '0x03' }, 'latest'] });
  });
  it('ignores ids outside the batch and empty "0x" results, and throws on HTTP failure', async () => {
    const r = await evmCalls('https://rpc', [{ to: '0xa', data: '0x01' }], reply([{ id: 7, result: '0x1' }, { id: 0, result: '0x' }]));
    expect(r).toEqual([undefined]);
    await expect(evmCalls('https://rpc', [{ to: '0xa', data: '0x01' }], reply({}, false))).rejects.toThrow('rpc 500');
  });
  it('splits long batches into chunks of 40 and keeps alignment', async () => {
    const f = vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body) as { id: number }[];
      return { ok: true, status: 200, json: async () => body.map((b) => ({ id: b.id, result: '0x' + b.id.toString(16).padStart(64, '0') })) };
    });
    const calls = Array.from({ length: 85 }, (_, i) => ({ to: '0xa', data: '0x' + i.toString(16) }));
    const r = await evmCalls('https://rpc', calls, f as any);
    expect(f).toHaveBeenCalledTimes(3);
    expect(r[84]).toBe('0x' + (84).toString(16).padStart(64, '0'));
    expect(r[40]).toBe('0x' + (40).toString(16).padStart(64, '0'));
  });
  it('a node that caps batches ("maximum 10 calls") is re-asked in chunks of that size, and remembers it', async () => {
    const f = vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body) as { id: number }[];
      if (body.length > 10) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', error: { code: -32014, message: 'maximum 10 calls in 1 batch' }, id: null }) };
      return { ok: true, status: 200, json: async () => body.map((b) => ({ id: b.id, result: '0x' + b.id.toString(16).padStart(64, '0') })) };
    });
    const calls = Array.from({ length: 25 }, (_, i) => ({ to: '0xa', data: '0x' + i.toString(16) }));
    const r = await evmCalls('https://capped.example', calls, f as any);
    expect(r[24]).toBe('0x' + (24).toString(16).padStart(64, '0'));
    expect(f).toHaveBeenCalledTimes(4); // one refused 25, then 10 + 10 + 5
    await evmCalls('https://capped.example', calls.slice(0, 12), f as any);
    expect(f).toHaveBeenCalledTimes(6); // straight to 10 + 2
  });
  it('any other batch-level refusal throws, and per-call errors carry the node\'s message', async () => {
    await expect(evmCalls('https://rpc', [{ to: '0xa', data: '0x01' }], reply({ jsonrpc: '2.0', error: { message: 'rate limited' }, id: null }))).rejects.toThrow('rate limited');
    const d = await evmCallsDetailed('https://rpc', [{ to: '0xa', data: '0x01' }, { to: '0xb', data: '0x02' }], reply([{ id: 0, error: { message: 'execution reverted' } }, { id: 1, result: '0x' }]));
    expect(d).toEqual([{ error: 'execution reverted' }, { error: 'empty result' }]);
    expect(isRevert('execution reverted')).toBe(true);
    expect(isRevert('empty result')).toBe(true);
    expect(isRevert('too many requests')).toBe(false);
    expect(isRevert(undefined)).toBe(false);
  });
  it('reads eth_chainId, undefined when the endpoint is not an EVM node', async () => {
    expect(await evmChainId('https://rpc', reply({ id: 1, result: '0x2105' }))).toBe(8453);
    expect(await evmChainId('https://rpc', reply({ error: 'nope' }))).toBeUndefined();
    expect(await evmChainId('https://rpc', reply({}, false))).toBeUndefined();
  });
});

describe('solana', () => {
  it('decodes base64 account data and marks missing accounts', async () => {
    const f = reply({ result: { value: [{ data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'] }, null] } });
    const r = await solanaAccounts('https://sol', ['A', 'B'], f);
    expect([...r[0]!]).toEqual([1, 2, 3]);
    expect(r[1]).toBeUndefined();
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).params[0]).toEqual(['A', 'B']);
  });
  it('getVersion tells a Solana node from anything else', async () => {
    expect(await solanaAlive('https://sol', reply({ result: { 'solana-core': '2.1.0' } }))).toBe(true);
    expect(await solanaAlive('https://sol', reply({ result: '0x1' }))).toBe(false);
  });
});

describe('quotes', () => {
  it('stables are a dollar, natives come from one CoinGecko call, unknown symbols are undefined', async () => {
    const f = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ ethereum: { usd: 3000 }, solana: { usd: 150 } }) }));
    const q = createQuoteSource(f as any);
    expect(q.usd('USDC')).toBe(1);
    expect(q.usd('usdt')).toBe(1);
    await q.refresh();
    expect(q.usd('WETH')).toBe(3000);
    expect(q.usd('ETH')).toBe(3000);
    expect(q.usd('SOL')).toBe(150);
    expect(q.usd('PEPE')).toBeUndefined();
    expect(q.usd('BNB')).toBeUndefined(); // not in the reply: no stale invention
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as any)[0]).toContain('ids=');
    expect((f.mock.calls[0] as any)[0]).toContain('binancecoin');
  });
  it('keeps the last good prices when CoinGecko fails', async () => {
    let ok = true;
    const f = vi.fn(async () => ({ ok, status: ok ? 200 : 429, json: async () => ({ ethereum: { usd: 3000 } }) }));
    const log = vi.fn();
    const q = createQuoteSource(f as any, log);
    await q.refresh();
    ok = false;
    await q.refresh();
    expect(q.usd('ETH')).toBe(3000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('429'));
  });
});
