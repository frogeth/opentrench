import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Minter, toWei, type MinterDeps } from './minter.js';
import type { DropCollection } from './drops.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // hardhat #1, no funds anywhere
const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const col: DropCollection = { slug: 'chump', name: 'Chump', address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1', chain: 'robinhood', networkId: 4663, drop: { kind: 'Erc721SeaDropV1', address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1', stages: [{ kind: 'Erc721SeaDropV1Stage', type: 'PUBLIC_SALE', index: 0, startTime: '2026-09-12T20:00:48.000Z', endTime: '2026-09-14T20:00:48.000Z', maxPerWallet: 3 }] } };
const now = Date.parse('2026-09-13T00:00:00Z');

function deps(over: Partial<MinterDeps> = {}): MinterDeps {
  return {
    resolve: async () => col,
    eligibility: async () => ({ kind: 'Erc721SeaDropV1', minted: 1, stages: [{ type: 'PUBLIC_SALE', index: 0, eligible: true, maxPerWallet: 3, eligibleMax: 3, priceUnit: 0.002, priceUsd: 5, priceSymbol: 'ETH' }] }),
    mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data: '0x161ac21f' + ['9d2a003322874163cbb18f7f538a1aaea49b75d1', 'fee', '0', '2', '0', '0', '0', '0', '0'].map((h) => h.padStart(64, '0')).join(''), value: '4000000000000000', networkId: 4663, chain: 'robinhood' } }),
    rpc: () => ({
      getBalance: async () => 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      getTransactionCount: async () => 7,
      sendRawTransaction: async () => '0xhash',
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 99n, logs: [{ address: col.address, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + WALLET.slice(2).padStart(64, '0'), '0x' + (462).toString(16).padStart(64, '0')] }] }),
    }),
    now: () => now,
    sleep: async () => {},
    ...over,
  };
}

describe('Minter', () => {
  it('quotes an open, eligible stage', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const job = await m.quote({ locator: 'chump', quantity: 2 });
    expect(job.state).toBe('ready');
    expect(job.wallet.toLowerCase()).toBe(WALLET);
    expect(job.stage).toMatchObject({ type: 'PUBLIC_SALE', index: 0, maxPerWallet: 3, alreadyMinted: 1 });
    expect(job.price).toEqual({ unitWei: '2000000000000000', totalWei: '4000000000000000', symbol: 'ETH', usd: 10 });
    expect(job.gas).toMatchObject({ limit: 300000, maxFeeWei: '2000000000', estimateWei: '600000000000000' });
    expect(job.balanceWei).toBe('1000000000000000000');
  });

  it('fails without a wallet, without an RPC, or when nothing is open', async () => {
    expect((await new Minter(() => undefined, () => ({}), deps()).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/wallet/);
    expect((await new Minter(() => KEY, () => ({}), deps({ resolve: async () => ({ ...col, chain: 'zora', networkId: 7777777 }) })).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/RPC/);
    const closed = deps({ now: () => Date.parse('2026-09-15T00:00:00Z') });
    expect((await new Minter(() => KEY, () => ({}), closed).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/no open stage/);
  });

  it('fails on quantity over the remaining allowance and on a poor balance', async () => {
    expect((await new Minter(() => KEY, () => ({}), deps()).quote({ locator: 'chump', quantity: 3 })).error).toMatch(/2 more/);
    const poor = deps({ rpc: () => ({ ...deps().rpc('x'), getBalance: async () => 1n }) });
    expect((await new Minter(() => KEY, () => ({}), poor).quote({ locator: 'chump', quantity: 1 })).error).toMatch(/needs/);
  });

  it('sends a validated mint and reads the minted ids from the receipt', async () => {
    const sent: string[] = [];
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), sendRawTransaction: async ({ serializedTransaction }: any) => { sent.push(serializedTransaction); return '0xhash'; } }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const states: string[] = [];
    m.on('job', (j) => states.push(j.state));
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const done = await m.send(q.id);
    expect(done.state).toBe('confirmed');
    expect(done.txHash).toBe('0xhash');
    expect(done.blockNumber).toBe(99);
    expect(done.tokenIds).toEqual(['462']);
    expect(sent[0]).toMatch(/^0x02/); // EIP-1559 envelope
    expect(states).toEqual(['ready', 'sending', 'pending', 'confirmed']);
  });

  it('fails a send whose calldata does not validate', async () => {
    const bad = deps({ mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data: '0x4b61cd6f' + '0'.repeat(576), value: '0', networkId: 4663, chain: 'robinhood' } }) });
    const m = new Minter(() => KEY, () => ({}), bad);
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/selector/);
  });

  it('converts unit prices to wei exactly', () => {
    expect(toWei(0.002)).toBe(2000000000000000n);
    expect(toWei(0)).toBe(0n);
    expect(toWei(1.5)).toBe(1500000000000000000n);
  });

  it('fails a send on a job older than two minutes', async () => {
    let t = now;
    const d = deps({ now: () => t });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    t = now + 3 * 60_000;
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/older than two minutes/);
  });

  it('fails a send when the wallet key changed since the quote', async () => {
    let key = KEY;
    const m = new Minter(() => key, () => ({}), deps());
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    key = '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e';
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/wallet changed/);
  });

  it('fails a send whose receipt reverted, keeping the tx hash', async () => {
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), getTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 99n, logs: [] }) }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/reverted/);
    expect(r.txHash).toBe('0xhash');
  });

  it('fails a send whose receipt never appears', async () => {
    let t = now;
    const d = deps({
      now: () => { const v = t; t += 60_000; return v; },
      rpc: () => ({ ...deps().rpc('x'), getTransactionReceipt: async () => { throw new Error('not found'); } }),
    });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/no receipt/);
  });

  it('throws on a second send of the same job', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    await m.send(q.id);
    await expect(m.send(q.id)).rejects.toThrow(/quote is/);
  });

  it('emits job copies: mutating an emitted job does not change minter.jobs', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    let captured: any;
    m.on('job', (j) => { captured = j; });
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    captured.state = 'mutated-away';
    const stored = m.jobs.find((j) => j.id === q.id)!;
    expect(stored.state).not.toBe('mutated-away');
  });

  it('caps jobs at 100', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    for (let i = 0; i < 105; i++) await m.quote({ locator: 'chump', quantity: 1 });
    expect(m.jobs.length).toBe(100);
  });

  it('fails a non-ERC721 drop kind as not supported', async () => {
    const d = deps({ resolve: async () => ({ ...col, drop: { ...col.drop!, kind: 'Erc1155SeaDropV2' } }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const r = await m.quote({ locator: 'chump', quantity: 1 });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/not supported/);
  });

  it('refuses a quote whose gas price is above the chain ceiling', async () => {
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n * 1_000_000n }) }) });
    const r = await new Minter(() => KEY, () => ({}), d).quote({ locator: 'chump', quantity: 1 });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/ceiling/);
  });

  it('refuses a send whose gas price drifted more than 2x from the quote', async () => {
    let n = 0;
    const fees = () => (++n === 1 ? { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n } : { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 3_000_000n });
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), estimateFeesPerGas: async () => fees() }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    expect(q.state).toBe('ready');
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/moved too far/);
    expect(r.txHash).toBeUndefined();
    // the quoted gas is left untouched when the send is refused
    expect(r.gas).toMatchObject({ maxFeeWei: '1000000000', maxPriorityWei: '1000000' });
  });

  it('confirms a mint even when a receipt log is malformed, with no token ids', async () => {
    const logs = [{ address: col.address, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + WALLET.slice(2).padStart(64, '0'), 'not-a-token-id'] }];
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), getTransactionReceipt: async () => ({ status: 'success', blockNumber: 99n, logs }) }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('confirmed');
    expect(r.tokenIds).toEqual([]);
    expect(r.blockNumber).toBe(99);
  });

  it('reads token ids out of checksummed-case receipt topics', async () => {
    const logs = [{
      address: '0x9D2A003322874163CbB18f7F538a1aAEa49B75D1',
      topics: ['0xDDF252AD1BE2C89B69C2B068FC378DAA952BA7F163C4A11628F55A4DF523B3EF', '0x' + '0'.repeat(64), '0x' + WALLET.slice(2).toUpperCase().padStart(64, '0'), '0x' + (462).toString(16).padStart(64, '0')],
    }];
    const d = deps({ rpc: () => ({ ...deps().rpc('x'), getTransactionReceipt: async () => ({ status: 'success', blockNumber: 2n ** 60n, logs }) }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('confirmed');
    expect(r.tokenIds).toEqual(['462']);
    expect(r.blockNumber).toBe(0); // an absurd block height becomes 0, never NaN
  });

  it('fails a send when the collection resolves to something else', async () => {
    let n = 0;
    const d = deps({ resolve: async () => (++n === 1 ? col : { ...col, address: '0x1111111111111111111111111111111111111111' }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/collection changed/);
  });

  it('fails a send when the drop contract is no longer the collection contract', async () => {
    let n = 0;
    const d = deps({ resolve: async () => (++n === 1 ? col : { ...col, drop: { ...col.drop!, address: '0x1111111111111111111111111111111111111111' } }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.error).toMatch(/collection changed/);
  });

  it('refuses a chain that is not in the table, even with an RPC override for it', async () => {
    const d = deps({ resolve: async () => ({ ...col, chain: 'zora', networkId: 7777777 }) });
    const r = await new Minter(() => KEY, () => ({ zora: 'https://zora.example' }), d).quote({ locator: 'chump', quantity: 1 });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/minting on zora is not supported yet/);
  });

  it("refuses a collection whose networkId disagrees with our chain table", async () => {
    const d = deps({ resolve: async () => ({ ...col, networkId: 9999 }) });
    const r = await new Minter(() => KEY, () => ({}), d).quote({ locator: 'chump', quantity: 1 });
    expect(r.error).toMatch(/chain id mismatch/);
  });

  it('never puts an RPC URL or its api key into the job error or the log', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    try {
      const d = deps({ resolve: async () => { throw new Error('HTTP request failed: https://rpc.example/v2/SECRETKEY returned 503'); } });
      const r = await new Minter(() => KEY, () => ({}), d).quote({ locator: 'chump', quantity: 1 });
      expect(r.state).toBe('failed');
      expect(r.error).not.toContain('SECRETKEY');
      expect(r.error).not.toContain('rpc.example');
      expect(r.error).toMatch(/OpenSea RPCs/);
      for (const line of logs) expect(line).not.toContain('SECRETKEY');
      expect(logs.join('\n')).toContain('<rpc>');
    } finally {
      spy.mockRestore();
    }
  });

  it('says nothing was sent when a send fails before broadcast', async () => {
    const d = deps({ mintAction: async () => { throw new Error('boom at https://rpc.example/KEY'); } });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 1 });
    const r = await m.send(q.id);
    expect(r.error).toMatch(/nothing was sent/);
    expect(r.error).not.toContain('rpc.example');
  });

  it('allows only one in-flight mint per wallet', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const a = await m.quote({ locator: 'chump', quantity: 1 });
    const b = await m.quote({ locator: 'chump', quantity: 1 });
    m.jobs.find((j) => j.id === a.id)!.state = 'pending';
    const r = await m.send(b.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/still pending/);
  });

  it('refuses eligibility returned for a different drop type', async () => {
    const d = deps({ eligibility: async () => ({ kind: 'Erc1155SeaDropV2', minted: 0, stages: [{ type: 'PUBLIC_SALE', index: 0, eligible: true, eligibleMax: 3, priceUnit: 0.002 }] }) });
    const r = await new Minter(() => KEY, () => ({}), d).quote({ locator: 'chump', quantity: 1 });
    expect(r.error).toMatch(/different drop type/);
  });

  it('refuses a stage whose eligible minter is another wallet', async () => {
    const d = deps({ eligibility: async () => ({ kind: 'Erc721SeaDropV1', minted: 0, stages: [{ type: 'PUBLIC_SALE', index: 0, eligible: true, eligibleMax: 3, eligibleMinter: '0x2222222222222222222222222222222222222222', priceUnit: 0.002 }] }) });
    const r = await new Minter(() => KEY, () => ({}), d).quote({ locator: 'chump', quantity: 1 });
    expect(r.error).toMatch(/eligible minter is another wallet/);
  });

  it('fails a send whose valid calldata carries twice the quoted value', async () => {
    const data = '0x161ac21f' + ['9d2a003322874163cbb18f7f538a1aaea49b75d1', 'fee', '0', '2', '0', '0', '0', '0', '0'].map((h) => h.padStart(64, '0')).join('');
    const d = deps({ mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data, value: '8000000000000000', networkId: 4663, chain: 'robinhood' } }) });
    const m = new Minter(() => KEY, () => ({}), d);
    const q = await m.quote({ locator: 'chump', quantity: 2 });
    const r = await m.send(q.id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/does not match the quoted price/);
  });

  it('clamps the quantity and rejects one that is not a number', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const nan = await m.quote({ locator: 'chump', quantity: Number.NaN });
    expect(nan.error).toMatch(/1 to 99/);
    const big = await m.quote({ locator: 'chump', quantity: 1e9 });
    expect(big.quantity).toBe(99);
    expect(big.error).toMatch(/not 99/);
  });

  it('never evicts a job whose transaction is still in flight', async () => {
    const m = new Minter(() => KEY, () => ({}), deps());
    const first = await m.quote({ locator: 'chump', quantity: 1 });
    m.jobs.find((j) => j.id === first.id)!.state = 'pending';
    for (let i = 0; i < 105; i++) await m.quote({ locator: 'chump', quantity: 1 });
    expect(m.jobs.length).toBe(100);
    expect(m.jobs.find((j) => j.id === first.id)).toBeDefined();
  });

  it('never logs the private key', async () => {
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    const spyErr = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    try {
      const bad = deps({ mintAction: async () => ({ actionTypes: ['MintAction'], errors: [], tx: { to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', data: '0x4b61cd6f' + '0'.repeat(576), value: '0', networkId: 4663, chain: 'robinhood' } }) });
      const m = new Minter(() => KEY, () => ({}), bad);
      const q = await m.quote({ locator: 'chump', quantity: 1 });
      await m.send(q.id);
      const needle = KEY.slice(4, 20);
      for (const line of logs) expect(line).not.toContain(needle);
    } finally {
      spyLog.mockRestore();
      spyWarn.mockRestore();
      spyErr.mockRestore();
    }
  });
});
