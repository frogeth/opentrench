import { describe, it, expect, vi } from 'vitest';
import {
  __resetStonksCache,
  classifyBySuffix,
  createLaunchpadClassifier,
  decodeStrings,
  fetchPons,
  fetchStonks,
  ipfsToHttp,
  mapBankrLaunch,
  mapClanker,
  mapFlap,
  mapPumpfun,
  mapStonksCoin,
  mapVirtuals,
} from './launchpads.js';

const A = '0xa419Bb493ed5059f28dfd84348A2F93D70ECf003';

function encStrings(strs: string[]): string {
  // minimal ABI encoder for a tuple of dynamic strings
  const words: string[] = [];
  const tails: string[] = [];
  let off = 32 * strs.length;
  for (const s of strs) {
    const bytes = Buffer.from(s, 'utf8');
    words.push(off.toString(16).padStart(64, '0'));
    const padded = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    tails.push(bytes.length.toString(16).padStart(64, '0') + padded);
    off += 32 + Math.ceil(bytes.length / 32) * 32;
  }
  return '0x' + words.join('') + tails.join('');
}

describe('launchpads', () => {
  it('classifies Solana mints by suffix', () => {
    expect(classifyBySuffix('AbCdpump', 'sol')).toMatchObject({ launchpad: 'pumpfun', launchpadUrl: 'https://pump.fun/coin/AbCdpump' });
    expect(classifyBySuffix('AbCdbonk', 'sol')?.launchpad).toBe('letsbonk');
    expect(classifyBySuffix('AbCd', 'sol')).toBeUndefined();
    expect(classifyBySuffix('0xpump', 'evm')).toBeUndefined();
  });

  it('turns ipfs uris and gateway urls into proxy urls', () => {
    expect(ipfsToHttp('ipfs://bafyabc')).toBe('/api/ipfs/bafyabc');
    expect(ipfsToHttp('ipfs://bafyabc/logo.png')).toBe('/api/ipfs/bafyabc/logo.png');
    expect(ipfsToHttp('https://ipfs.io/ipfs/QmSkPm?x=1')).toBe('/api/ipfs/QmSkPm');
    expect(ipfsToHttp('https://bafkreiabcdefghijklmnopqrstuvwxyz0123456789abcd.ipfs.dweb.link/a.png')).toBe('/api/ipfs/bafkreiabcdefghijklmnopqrstuvwxyz0123456789abcd/a.png');
    expect(ipfsToHttp('https://x.example/a.png')).toBe('https://x.example/a.png');
    expect(ipfsToHttp('')).toBeUndefined();
  });

  it('maps a pump.fun coin (bonding tokens have mcap but no pair)', () => {
    expect(
      mapPumpfun({ mint: 'Mintpump', name: 'Fantasy', symbol: 'FIX', image_uri: 'https://ipfs.io/ipfs/QmImg', usd_market_cap: 312596.2, created_timestamp: 1788983429000, twitter: null, website: 'https://fix.fun' }),
    ).toEqual({
      launchpad: 'pumpfun',
      launchpadUrl: 'https://pump.fun/coin/Mintpump',
      network: 'solana',
      name: 'Fantasy',
      symbol: 'FIX',
      imageUrl: '/api/ipfs/QmImg',
      marketCap: 312596.2,
      pairCreatedAt: 1788983429000,
      website: 'https://fix.fun',
    });
    expect(mapPumpfun({ statusCode: 404 })).toBeUndefined();
  });

  it('maps a Virtuals agent', () => {
    expect(
      mapVirtuals({ id: 1199, name: 'aixbt', symbol: 'AIXBT', chain: 'BASE', image: { url: 'https://cdn/x.png' }, socials: { VERIFIED_LINKS: { TWITTER: 'https://x.com/aixbt_agent' } }, lpCreatedAt: '2024-11-02T05:26:35.000Z' }, '0xabc'),
    ).toEqual({
      launchpad: 'virtuals',
      launchpadUrl: 'https://app.virtuals.io/virtuals/aixbt',
      network: 'base',
      name: 'aixbt',
      symbol: 'AIXBT',
      imageUrl: 'https://cdn/x.png',
      twitter: 'https://x.com/aixbt_agent',
      pairCreatedAt: Date.parse('2024-11-02T05:26:35.000Z'),
    });
  });

  it('maps Flap metadata and a Clanker search hit', () => {
    expect(mapFlap({ image: 'ipfs://QmF', twitter: '@flapper', telegram: 'flapchat', website: 'https://flap.example' }, 'bsc', '0xABC')).toEqual({
      launchpad: 'flap',
      launchpadUrl: 'https://flap.sh/token/0xabc',
      network: 'bsc',
      imageUrl: '/api/ipfs/QmF',
      twitter: 'https://x.com/flapper',
      telegram: 'https://t.me/flapchat',
      website: 'https://flap.example',
    });
    expect(
      mapClanker({ data: [{ contract_address: '0xABC', name: 'Clank', symbol: 'CLK', chain_id: 4663, img_url: 'https://i/c.png', socialLinks: [{ name: 'Website', link: 'https://c.example' }, { name: 'X', link: 'https://x.com/clk' }] }] }, '0xabc'),
    ).toEqual({
      launchpad: 'clanker',
      launchpadUrl: 'https://www.clanker.world/clanker/0xabc',
      network: 'robinhood',
      name: 'Clank',
      symbol: 'CLK',
      imageUrl: 'https://i/c.png',
      website: 'https://c.example',
      twitter: 'https://x.com/clk',
    });
    expect(mapClanker({ data: [] }, '0xabc')).toBeUndefined();
  });

  it('maps a Bankr launch with its ipfs image', () => {
    expect(
      mapBankrLaunch({ tokenAddress: A, tokenName: 'Bitcat', tokenSymbol: 'BITCAT', chain: 'robinhood', imageUri: 'ipfs://bafyimg', deployer: { xUsername: 'dev' } }, A),
    ).toEqual({
      launchpad: 'bankr',
      launchpadUrl: `https://bankr.bot/launches/${A.toLowerCase()}`,
      name: 'Bitcat',
      symbol: 'BITCAT',
      network: 'robinhood',
      twitter: 'https://x.com/dev',
      imageUrl: '/api/ipfs/bafyimg',
    });
  });

  it('maps a Stonks coin and finds it in the cached list', async () => {
    __resetStonksCache();
    const coin = { token: A, name: 'Honter', symbol: 'BODEN', image: 'https://pinata/x', created_at: '1788966469', twitter: '@boden', telegram: 'bodenchat', website: null };
    expect(mapStonksCoin(coin, A)).toEqual({
      launchpad: 'stonks',
      launchpadUrl: `https://www.thestonks.exchange/token/${A.toLowerCase()}`,
      network: 'base',
      name: 'Honter',
      symbol: 'BODEN',
      imageUrl: 'https://pinata/x',
      twitter: 'https://x.com/boden',
      telegram: 'https://t.me/bodenchat',
      pairCreatedAt: 1788966469000,
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [coin] } as any;
    }) as unknown as typeof fetch;
    expect((await fetchStonks(A, fetchImpl, 1000))?.launchpad).toBe('stonks');
    expect(await fetchStonks('0x' + '1'.repeat(40), fetchImpl, 2000)).toBeUndefined();
    expect(calls).toHaveLength(1); // second lookup served from cache
  });

  it('decodes abi string tuples', () => {
    expect(decodeStrings(encStrings(['a', 'hello world', '']), 3)).toEqual(['a', 'hello world', '']);
    expect(decodeStrings('0x', 1)).toBeUndefined();
  });

  it('reads a Pons token off the contract and rejects non-Pons tokens', async () => {
    const answers: Record<string, string> = {
      '0x53cd512a': encStrings(['@ponscat', 'ponschat', '', 'https://pons.cat', '']),
      '0xfb7f21eb': encStrings(['ipfs://bafylogo']),
      '0x06fdde03': encStrings(['Pons Cat']),
      '0x95d89b41': encStrings(['PCAT']),
    };
    const fetchImpl = (async (_url: string, init: any) => {
      const data = JSON.parse(init.body).params[0].data;
      return { ok: true, json: async () => ({ result: answers[data] ?? '0x' }) } as any;
    }) as unknown as typeof fetch;
    expect(await fetchPons(A, fetchImpl)).toEqual({
      launchpad: 'pons',
      launchpadUrl: 'https://www.ponsfamily.com/launchpad',
      network: 'robinhood',
      twitter: 'https://x.com/ponscat',
      telegram: 'https://t.me/ponschat',
      website: 'https://pons.cat',
      imageUrl: '/api/ipfs/bafylogo',
      name: 'Pons Cat',
      symbol: 'PCAT',
    });
    const revert = (async () => ({ ok: true, json: async () => ({ error: { code: 3, message: 'execution reverted' } }) })) as unknown as typeof fetch;
    expect(await fetchPons(A, revert)).toBeUndefined();
  });

  it('runs probes in order and stops at the first hit', async () => {
    const bankr = vi.fn(async () => undefined);
    const stonks = vi.fn(async () => ({ launchpad: 'stonks' as const, launchpadUrl: 'u' }));
    const pons = vi.fn();
    const classify = createLaunchpadClassifier({ bankr, stonks, pons, log: () => {} });
    expect((await classify(A, 'evm'))?.launchpad).toBe('stonks');
    expect(pons).not.toHaveBeenCalled();
    expect((await classify('Mintpump', 'sol'))?.launchpad).toBe('pumpfun');
    expect(bankr).toHaveBeenCalledTimes(1);
  });

  it('pump.fun mints get the full pump.fun record when the API answers, suffix badge otherwise', async () => {
    const withApi = createLaunchpadClassifier({ pumpfun: async () => ({ launchpad: 'pumpfun' as const, launchpadUrl: 'u', symbol: 'FIX', marketCap: 5 }), log: () => {} });
    expect(await withApi('Mintpump', 'sol')).toMatchObject({ symbol: 'FIX', marketCap: 5 });
    const noApi = createLaunchpadClassifier({ pumpfun: async () => undefined, log: () => {} });
    expect((await noApi('Mintpump', 'sol'))?.launchpadUrl).toBe('https://pump.fun/coin/Mintpump');
    const dead = createLaunchpadClassifier({
      pumpfun: async () => {
        throw new Error('down');
      },
      log: () => {},
    });
    expect((await dead('Mintpump', 'sol'))?.launchpad).toBe('pumpfun');
  });

  it('survives a throwing probe', async () => {
    const classify = createLaunchpadClassifier({
      bankr: async () => {
        throw new Error('boom');
      },
      pons: async () => ({ launchpad: 'pons' as const, launchpadUrl: 'u' }),
      log: () => {},
    });
    expect((await classify(A, 'evm'))?.launchpad).toBe('pons');
  });
});
