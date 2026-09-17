import { describe, expect, it, vi } from 'vitest';
import { discoverEvm, discoverSolana, FACTORIES, QUOTES } from './discover.js';
import { findProgramAddress, utf8 } from './pda.js';
import { PROGRAMS, SOL_MINT } from './solana.js';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const P2 = '0xaaaa000000000000000000000000000000000001';
const P3 = '0xaaaa000000000000000000000000000000000002';
const endpoints = { urlFor: (n: string) => ({ url: `https://${n}`, source: 'public' as const }), probeAlchemy: async () => ({ hasKey: false, chains: [], probing: false }), alchemy: () => ({ hasKey: false, chains: [], probing: false }), sources: () => ({}) };
const node = (table: Record<string, string>) => vi.fn(async (_u: string, init: any) => {
  const body = JSON.parse(init.body);
  if (!Array.isArray(body)) return { ok: true, status: 200, json: async () => ({ result: { value: body.params[0].map((k: string) => (table[k] ? { owner: table[k].split('|')[0], data: [table[k].split('|')[1], 'base64'] } : null)) } }) };
  return { ok: true, status: 200, json: async () => body.map((b: any) => { const r = table[`${b.params[0].to}:${b.params[0].data}`] ?? table[`${b.params[0].to}:${b.params[0].data.slice(0, 10)}`]; return r ? { id: b.id, result: r } : { id: b.id, error: { message: 'execution reverted' } }; }) };
});

describe('discover', () => {
  it('asks the v2 and v3 factories for every quote and fee, and ranks the pools by the quote they hold', async () => {
    const { v2, v3 } = FACTORIES.base;
    const [weth, usdc] = QUOTES.base;
    const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const f = node({
      [`${v2}:0xe6a43905${pad(TOKEN)}${pad(weth.address)}`]: addr(P2),
      [`${v3}:0x1698ee82${pad(TOKEN)}${pad(usdc.address)}${pad('bb8')}`]: addr(P3), // 3000
      [`${weth.address}:0x70a08231${pad(P2)}`]: '0x' + word(2n * 10n ** 18n), // 2 WETH
      [`${usdc.address}:0x70a08231${pad(P3)}`]: '0x' + word(50_000n * 10n ** 6n), // 50k USDC
    });
    const out = await discoverEvm('base', TOKEN, { endpoints, fetch: f as any });
    expect(out).toEqual([
      { pairAddress: P3, quoteSymbol: 'USDC', quoteAddress: usdc.address, dex: 'uniswap', fee: 3000, depth: 50_000 },
      { pairAddress: P2, quoteSymbol: 'WETH', quoteAddress: weth.address, dex: 'uniswap', fee: undefined, depth: 2 },
    ]);
    // one factory batch: 2 quotes × (1 v2 + 4 fees)
    expect(JSON.parse((f.mock.calls[0] as any)[1].body)).toHaveLength(10);
  });
  it('an empty pool (zero quote) and a chain with no quotes yield nothing', async () => {
    const { v2 } = FACTORIES.base;
    const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const f = node({ [`${v2}:0xe6a43905${pad(TOKEN)}${pad(QUOTES.base[0].address)}`]: addr(P2), [`${QUOTES.base[0].address}:0x70a08231${pad(P2)}`]: '0x' + word(0n) });
    expect(await discoverEvm('base', TOKEN, { endpoints, fetch: f as any })).toEqual([]);
    expect(await discoverEvm('zora', TOKEN, { endpoints, fetch: f as any })).toEqual([]);
  });
  it('Solana: the pump.fun curve of the mint, unless it has graduated', async () => {
    const MINT = '2Dmta7fhheLqCBszyqcB1szf7nxx2eEsHM4dmEhFpump';
    const curve = findProgramAddress([utf8('bonding-curve'), MINT], PROGRAMS.pumpfun).address;
    const data = Buffer.alloc(151); data.writeBigUInt64LE(1n, 8); data.writeBigUInt64LE(1n, 16);
    const f = node({ [curve]: `${PROGRAMS.pumpfun}|${data.toString('base64')}` });
    expect(await discoverSolana(MINT, { endpoints, fetch: f as any })).toEqual({ pairAddress: curve, quoteSymbol: 'SOL', quoteAddress: SOL_MINT, dex: 'pumpfun' });
    data[48] = 1;
    const g = node({ [curve]: `${PROGRAMS.pumpfun}|${data.toString('base64')}` });
    expect(await discoverSolana(MINT, { endpoints, fetch: g as any })).toBeUndefined();
  });
});
