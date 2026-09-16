import { describe, expect, it } from 'vitest';
import { probeChains } from './rpcprobe.js';

const word = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0');
};
const ADDR = '0xc518663010994da18bbb1ecf2bba6f49e326342c';

describe('probeChains', () => {
  it('places a contract on the chain whose RPC has code for it, with symbol and name', async () => {
    const fake = (async (_url: string, init: any) => {
      const calls = JSON.parse(init.body);
      return new Response(JSON.stringify(calls.map((c: any) => ({ id: c.id, result: c.method === 'eth_getCode' ? '0x6080' : c.id === 1 ? word('SASHIMI') : word('Sashimi on Arc') }))), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await probeChains(ADDR, fake, [{ network: 'arc', rpc: 'https://rpc' }], 1)).toEqual({ network: 'arc', symbol: 'SASHIMI', name: 'Sashimi on Arc' });
  });
  it('an address with no code anywhere is nothing, and the miss is remembered', async () => {
    let n = 0;
    const fake = (async (_url: string, init: any) => {
      n++;
      const calls = JSON.parse(init.body);
      return new Response(JSON.stringify(calls.map((c: any) => ({ id: c.id, result: '0x' }))), { status: 200 });
    }) as unknown as typeof fetch;
    const chains = [{ network: 'arc', rpc: 'https://rpc-miss' }];
    expect(await probeChains('0x' + 'ab'.repeat(20), fake, chains, 1000)).toBeUndefined();
    expect(await probeChains('0x' + 'ab'.repeat(20), fake, chains, 2000)).toBeUndefined();
    expect(n).toBe(1);
  });
  it('a dead RPC or junk answer is a miss, never a throw', async () => {
    const dead = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await probeChains('0x' + 'cd'.repeat(20), dead, [{ network: 'arc', rpc: 'https://rpc-dead' }], 1)).toBeUndefined();
    const junk = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect(await probeChains('0x' + 'ef'.repeat(20), junk, [{ network: 'arc', rpc: 'https://rpc-junk' }], 1)).toBeUndefined();
  });
});
