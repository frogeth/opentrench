import { describe, expect, it, vi } from 'vitest';
import { decodeMetaplex, identifyEvm, identifySolana } from './identity.js';
import { SEL } from './pools.js';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const abiString = (s: string) => '0x' + word(32n) + word(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const endpoints = { urlFor: (n: string) => ({ url: `https://${n}`, source: 'public' as const }), probeAlchemy: async () => ({ hasKey: false, chains: [], probing: false }), alchemy: () => ({ hasKey: false, chains: [], probing: false }), sources: () => ({}) };

describe('identity', () => {
  it('asks every EVM chain at once; the chains whose decimals() answers hold the contract, preferred first', async () => {
    const tables: Record<string, Record<string, string>> = {
      'https://base': { [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n), [`${TOKEN}:${SEL.symbol}`]: abiString('DOG'), [`${TOKEN}:0x06fdde03`]: abiString('Dog Coin'), [`${TOKEN}:${SEL.totalSupply}`]: '0x' + word(10n ** 27n) },
      'https://ink': { [`${TOKEN}:${SEL.decimals}`]: '0x' + word(6n), [`${TOKEN}:${SEL.symbol}`]: abiString('DOG') },
      'https://bsc': { [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n) }, // decimals but no name: not a token we can show
    };
    const f = vi.fn(async (url: string, init: any) => ({ ok: true, status: 200, json: async () => JSON.parse(init.body).map((b: any) => { const r = tables[url]?.[`${b.params[0].to}:${b.params[0].data}`]; return r ? { id: b.id, result: r } : { id: b.id, error: { message: 'execution reverted' } }; }) }));
    const hits = await identifyEvm(TOKEN, { endpoints, fetch: f as any, prefer: ['ink'] });
    expect(hits.map((h) => h.network)).toEqual(['ink', 'base']);
    expect(hits[1]).toEqual({ network: 'base', name: 'Dog Coin', symbol: 'DOG', decimals: 18, totalSupply: 1e9 });
    expect(hits[0].totalSupply).toBeUndefined();
    expect(f.mock.calls.length).toBeGreaterThan(10); // every EVM chain, in parallel
    expect(await identifyEvm('nope', { endpoints, fetch: f as any })).toEqual([]);
  });
  it('decodes Metaplex metadata strings with their NUL padding', () => {
    const name = 'Another Retarded Chain', symbol = 'ARC', uri = 'https://m.example/x';
    const enc = (s: string, pad: number) => { const b = Buffer.alloc(4 + pad); b.writeUInt32LE(pad, 0); b.write(s, 4); return b; };
    const d = Buffer.concat([Buffer.alloc(65), enc(name, 32), enc(symbol, 10), enc(uri, 200)]);
    expect(decodeMetaplex(new Uint8Array(d))).toEqual({ name, symbol, uri });
    expect(decodeMetaplex(new Uint8Array(10))).toBeUndefined();
  });
  it('a Solana mint: decimals and supply from the mint, name and ticker from its metadata PDA', async () => {
    const MINT = '2Dmta7fhheLqCBszyqcB1szf7nxx2eEsHM4dmEhFpump';
    const mint = Buffer.alloc(82); mint.writeBigUInt64LE(1_000_000_000_000_000n, 36); mint[44] = 6;
    const enc = (s: string, pad: number) => { const b = Buffer.alloc(4 + pad); b.writeUInt32LE(pad, 0); b.write(s, 4); return b; };
    const md = Buffer.concat([Buffer.alloc(65), enc('Another Retarded Chain', 32), enc('ARC', 10), enc('ipfs://x', 200)]);
    const f = vi.fn(async (_u: string, init: any) => {
      const keys = JSON.parse(init.body).params[0] as string[];
      return { ok: true, status: 200, json: async () => ({ result: { value: keys.map((k) => (k === MINT ? { owner: 'Tok', data: [mint.toString('base64'), 'base64'] } : { owner: 'meta', data: [md.toString('base64'), 'base64'] })) } }) };
    });
    const id = await identifySolana(MINT, { endpoints, fetch: f as any });
    expect(id).toEqual({ network: 'solana', name: 'Another Retarded Chain', symbol: 'ARC', decimals: 6, totalSupply: 1e9, metadataUri: 'ipfs://x' });
    // the second key asked for is the metadata PDA of the mint
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).params[0][1]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
