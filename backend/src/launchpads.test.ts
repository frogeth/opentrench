import { describe, it, expect, vi } from 'vitest';
import { __resetStonksCache, classifyBySuffix, createLaunchpadClassifier, decodeStrings, fetchPons, fetchStonks, ipfsToHttp, mapBankrLaunch, mapClanker, mapFlap, mapPumpfun, mapStonksCoin, mapVirtuals, fetchArgus, fetchWarp, mapWarp, decodeDynamicStrings, mapPeach, fetchPeach, fetchDyor, mapSynthra, fetchSynthra, SYNTHRA_CHAINS } from './launchpads.js';

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


describe('Argus (Arc)', () => {
  const TOKEN = '0xc518663010994da18bbb1ecf2bba6f49e326342c';
  const w = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  const str = (s: string) => Buffer.from(s, 'utf8').toString('hex');
  /** ABI data for (string name, string symbol, bytes32 poolId, string image, string website, string twitter, string telegram) */
  const eventData = (fields: string[]) => {
    const heads: string[] = [];
    let tail = '';
    let off = 7 * 32;
    fields.forEach((f, i) => {
      if (i === 2) {
        heads.push(w('ab'));
        return;
      }
      heads.push(w(off.toString(16)));
      const hex = str(f);
      const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
      tail += w(f.length.toString(16)) + padded;
      off += 32 + padded.length / 2;
    });
    return '0x' + heads.join('') + tail;
  };
  const rpc = (over: { creatorOn?: number; bonded?: boolean; logs?: boolean }) =>
    (async (_url: string, init: any) => {
      const calls: any[] = JSON.parse(init.body);
      return new Response(
        JSON.stringify(
          calls.map((c) => {
            if (c.method === 'eth_call' && String(c.params[0].data).startsWith('0x1f2d8550')) {
              const i = ['0xb021be536808f551b31789422fd28a6c9c6e97da', '0xa5628a11c412596e1f63b75a2c0284f843c549d6', '0x07a688a001f416cc433c68ff56aa26bc5131cc6e', '0xa36c443a797771df82533b8b4a86f0affd970862', '0x7a17ab0106c46c0be30623f3eb7f299cc0058338', '0xbed9880a0ba12722ba4b8791c0b6f8c74338246c', '0x0f1c7cb26d6cd36bd4189e41947658b39437587a'].indexOf(String(c.params[0].to).toLowerCase());
              const creator = i === over.creatorOn ? 'ff9a533f8f2368232f6ef59de2cd81d228243524' : '';
              // 11 words: creator, tickStart, token0, locker, hook, splitter, buyTax 100, sellTax 100, positionId, tickBond, quote
              return { id: c.id, result: '0x' + w(creator) + w('0') + w('1') + w('8055') + w('bcb950001a99e05cc0d399b04a102af114ca2044') + w('1') + w('64') + w('64') + w('0') + w('0') + w('3600') };
            }
            if (c.method === 'eth_call' && String(c.params[0].data).startsWith('0xe88dc357')) return { id: c.id, result: '0x' + w(over.bonded ? '1' : '0') };
            if (c.method === 'eth_blockNumber') return { id: c.id, result: '0x1419b53' };
            if (c.method === 'eth_getLogs') return over.logs ? { id: c.id, result: [{ data: eventData(['1 USDC And A Dream', '1USDC', '', 'ipfs://QmImg', 'https://one.usdc', '@oneusdc', 't.me/oneusdc']) }] } : { id: c.id, error: { code: 4444, message: 'pruned history unavailable' } };
            return { id: c.id, result: '0x' };
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  it('a Portal that names a creator makes it an Argus token, bonding, with tax and launch metadata', async () => {
    const t = await fetchArgus(TOKEN, rpc({ creatorOn: 0, bonded: false, logs: true }));
    expect(t).toMatchObject({ launchpad: 'argus', launchpadUrl: `https://argus.world/token/${TOKEN}`, network: 'arc', launchpadNote: 'bonding · 1% / 1% tax', name: '1 USDC And A Dream', symbol: '1USDC', website: 'https://one.usdc' });
    expect(t!.imageUrl).toMatch(/QmImg/);
    expect(t!.twitter).toMatch(/oneusdc/);
  });
  it('graduated when the hook says bonded; pruned logs cost only the metadata', async () => {
    const t = await fetchArgus(TOKEN, rpc({ creatorOn: 1, bonded: true, logs: false }));
    expect(t).toMatchObject({ launchpad: 'argus', launchpadNote: 'graduated · 1% / 1% tax' });
    expect(t!.name).toBeUndefined();
  });
  it('no Portal knows it: not Argus', async () => {
    expect(await fetchArgus(TOKEN, rpc({}))).toBeUndefined();
    expect(await fetchArgus('not-an-address', rpc({}))).toBeUndefined();
  });
  it('decodeDynamicStrings reads the string members of a tuple', () => {
    expect(decodeDynamicStrings(eventData(['a', 'bb', '', 'ccc', '', '', 'dddd']), [0, 1, 3, 6])).toEqual(['a', 'bb', 'ccc', 'dddd']);
    expect(decodeDynamicStrings('0x00', [0])).toBeUndefined();
  });
});

describe('Warp (Arc)', () => {
  const live = { id: '0xd68d667fc31b77e41847fe140bf28dae4b85eede', address: '0xd68D667fc31b77E41847Fe140bF28Dae4B85eeDe', name: 'Warp Smoke Test', ticker: 'SMOKE', image: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=Warp', twitter: '', status: 'live', price: '1.16e-05', mcap: '11626.47', progress: '13.34', change24h: '37.68', liquidity: '3117.65', volume: '162243.44', createdAt: '1785368380000', migrated: false, pairAddress: null };
  it('maps a live curve token and a migrated one', () => {
    expect(mapWarp(live, live.address)).toMatchObject({ launchpad: 'warp', launchpadUrl: 'https://circlewarp.fun/trade/0xd68d667fc31b77e41847fe140bf28dae4b85eede', network: 'arc', name: 'Warp Smoke Test', symbol: 'SMOKE', priceUsd: 1.16e-5, marketCap: 11626.47, liquidity: 3117.65, change24h: 37.68, pairCreatedAt: 1785368380000, launchpadNote: 'bonding · 13% to $69K' });
    const done = mapWarp({ ...live, id: '0x384c60f98ecd4c26345499345c03d677e40f115e', address: '0x384c60F98ecd4C26345499345c03d677E40f115e', twitter: '@circlewarp', status: 'migrated', migrated: true, progress: '100', pairAddress: '0x507a494fdE26960cB36d50912cab83c71Ecc7ea7' }, '0x384c60f98ecd4c26345499345c03d677e40f115e');
    expect(done).toMatchObject({ launchpadNote: 'graduated to WarpDex', pairAddress: '0x507a494fde26960cb36d50912cab83c71ecc7ea7' });
    expect(done!.twitter).toMatch(/circlewarp/);
    expect(mapWarp({ error: 'Token not found' }, live.address)).toBeUndefined();
    // a token Warp's terminal merely indexes (another launchpad's, a pool's) is not a Warp launch
    expect(mapWarp({ ...live, status: 'external', source: 'v4', curve: null }, live.address)).toBeUndefined();
    expect(mapWarp({ ...live, address: '0x' + '1'.repeat(40) }, live.address)).toBeUndefined();
  });
  it('fetchWarp asks the read API and a 404 is not a Warp token', async () => {
    const fake = (async (url: string) => (url.endsWith('/api/tokens/' + live.id) ? new Response(JSON.stringify(live), { status: 200 }) : new Response(JSON.stringify({ error: 'Token not found' }), { status: 404 }))) as unknown as typeof fetch;
    expect((await fetchWarp(live.address, fake, 'https://api'))?.launchpad).toBe('warp');
    expect(await fetchWarp('0x' + '2'.repeat(40), fake, 'https://api')).toBeUndefined();
  });
});


describe('pump.fun mints without the vanity suffix', () => {
  it('a Solana address that does not end in "pump" is still asked of pump.fun', async () => {
    const asked: string[] = [];
    const cls = createLaunchpadClassifier({
      pumpfun: async (a) => {
        asked.push(a);
        return a === 'pfkK22P3jt3XDF8S2BzjscqXJ2dWFZXbLqoNFREf2Eh' ? { launchpad: 'pumpfun', launchpadUrl: 'https://pump.fun/coin/' + a, network: 'solana', imageUrl: 'https://img/x.png' } : undefined;
      },
      log: () => {},
    });
    expect((await cls('pfkK22P3jt3XDF8S2BzjscqXJ2dWFZXbLqoNFREf2Eh', 'sol'))?.imageUrl).toBe('https://img/x.png');
    expect(await cls('So11111111111111111111111111111111111111112', 'sol')).toBeUndefined();
    expect(asked).toHaveLength(2);
    // a letsbonk suffix still wins without a pump.fun call
    expect((await cls('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbonk', 'sol'))?.launchpad).toBe('letsbonk');
    expect(asked).toHaveLength(2);
  });
});


describe('Peach (Arc)', () => {
  const t = { token: '0x69a2950134c4c3a78cf293baaa831cd78923cc85', name: 'Peach Arc', symbol: 'PEACH', image_url: 'https://img/peach.png', x: 'https://x.com/peachlfg', status: 'BONDING', progress: '12.4', price_usd: '0.0000025', market_cap_usd: '2500', liquidity_usd: '10', volume_24h_usd: '3', price_change_24h: '0', created_at: '1789574529' };
  it('maps a bonding token and a graduated one', () => {
    expect(mapPeach(t, t.token)).toMatchObject({ launchpad: 'peach', launchpadUrl: `https://www.peach.ag/arc/tokens/${t.token}`, network: 'arc', name: 'Peach Arc', symbol: 'PEACH', imageUrl: 'https://img/peach.png', priceUsd: 0.0000025, marketCap: 2500, pairCreatedAt: 1789574529000, launchpadNote: 'bonding · 12%' });
    expect(mapPeach({ ...t, status: 'GRADUATED', progress: '100' }, t.token)?.launchpadNote).toBe('graduated');
    expect(mapPeach({ error: 'token not found' }, t.token)).toBeUndefined();
    expect(mapPeach({ ...t, token: '0x' + '1'.repeat(40) }, t.token)).toBeUndefined();
  });
  it('fetchPeach: a 404 is not a Peach token', async () => {
    const fake = (async (url: string) => (url.endsWith('/tokens/' + t.token) ? new Response(JSON.stringify(t), { status: 200 }) : new Response(JSON.stringify({ error: 'token not found' }), { status: 404 }))) as unknown as typeof fetch;
    expect((await fetchPeach(t.token, fake, 'https://api'))?.launchpad).toBe('peach');
    expect(await fetchPeach('0x' + '2'.repeat(40), fake, 'https://api')).toBeUndefined();
  });
});

describe('DYOR Launch (Arc)', () => {
  const TOKEN = '0x07704b06981ea962b87296362a1281484d160000';
  const CURVE = '0x1111111111111111111111111111111111111111';
  const w = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  const rpc = (over: { known?: boolean; older?: boolean; graduated?: boolean; raised?: bigint; target?: bigint }) =>
    (async (_url: string, init: any) => {
      const calls: any[] = JSON.parse(init.body);
      return new Response(
        JSON.stringify(
          calls.map((c) => {
            const data: string = c.params[0].data;
            if (data.startsWith('0x86e14352')) return over.known ? { id: c.id, result: '0x' + w(CURVE) } : { id: c.id, error: { code: 3, message: 'execution reverted', data: '0xcbdb7b30' } };
            if (data.startsWith('0x9fc66651')) return over.older ? { id: c.id, result: '0x' + w('11b') } : { id: c.id, error: { code: 3, message: 'execution reverted', data: '0xcbdb7b30' } };
            if (data.startsWith('0xe7c2b772')) return { id: c.id, result: '0x' + w(over.graduated ? '1' : '0') };
            if (data.startsWith('0xdcce240a')) return { id: c.id, result: '0x' + w((over.raised ?? 0n).toString(16)) };
            if (data.startsWith('0xbdf50293')) return { id: c.id, result: '0x' + w((over.target ?? 0n).toString(16)) };
            return { id: c.id, result: '0x' };
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  const chains = [{ network: 'arc', chainId: 5042, factory: '0xa2448256e2A2e2Fc02a8faff1Dbcc91C640FFcD8', rpc: 'https://rpc', reader: '0xDb3e73989EaE0a5132d668099C529F51A97EE8C3' }];
  it('the factory names a curve: DYOR token, with its progress or graduation', async () => {
    expect(await fetchDyor(TOKEN, rpc({ known: true, raised: 6163n, target: 18000n }), chains)).toEqual({ launchpad: 'dyor', launchpadUrl: `https://dyorswap.org/token?address=${TOKEN}&chainId=5042`, network: 'arc', launchpadNote: 'bonding · 34.2%' });
    expect((await fetchDyor(TOKEN, rpc({ known: true, graduated: true }), chains))?.launchpadNote).toBe('graduated');
    expect(await fetchDyor(TOKEN, rpc({ known: false }), chains)).toBeUndefined();
    // an earlier V2 launch: the current factory reverts, the site's reader still answers
    expect(await fetchDyor(TOKEN, rpc({ known: false, older: true }), chains)).toEqual({ launchpad: 'dyor', launchpadUrl: `https://dyorswap.org/token?address=${TOKEN}&chainId=5042`, network: 'arc' });
  });
});


describe('Synthra Launches (Arc, Robinhood)', () => {
  const BULL = { id: '0x4ff16c25fc5eb159297ebd5c6bd9fe816054be9d', name: 'USDCBULL', symbol: 'BULL', metadataURI: 'ipfs://bafkreigonn', createdAt: '1789578976', status: 'LIVE', progressBps: 1234, priceUsdc: '0.0000032898', marketCapUsdc: '3289.84', holderCount: 0, volumeUsdc: '494.99', pool: '0x12f0ecc5640605360a3e08c19ccf5d2093733927', lastTradeAt: '1789579095' };
  const meta = { success: true, data: { name: 'USDCBULL', symbol: 'BULL', socials: { x: 'https://x.com/usdcbull', telegram: 't.me/usdcbull', website: 'https://usdcbull.xyz' }, image: { full: 'https://api/image/full', thumb: 'https://api/image/thumb' } } };
  const fake = (over: { arc?: any; rh?: any; rate?: number }) =>
    (async (url: string, init?: any) => {
      if (url.includes('arc-mainnet')) return new Response(JSON.stringify({ data: { token: over.arc ?? null } }), { status: 200 });
      if (url.includes('robinhood-mainnet')) return new Response(JSON.stringify({ data: { token: over.rh ?? null } }), { status: 200 });
      if (url.includes('/quote-rate')) return new Response(JSON.stringify({ success: true, data: { rates: over.rate ? [{ chainId: 4663, rate: over.rate }] : [] } }), { status: 200 });
      if (url.includes('/metadata/')) return new Response(JSON.stringify(meta), { status: 200 });
      void init;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
  it('an Arc launch: badge, status, dollars straight from the curve, image and socials from the metadata service', async () => {
    const t = await fetchSynthra(BULL.id, fake({ arc: BULL }), SYNTHRA_CHAINS, 'https://api');
    expect(t).toMatchObject({ launchpad: 'synthra', network: 'arc', name: 'USDCBULL', symbol: 'BULL', launchpadNote: 'bonding · 12%', priceUsd: 0.0000032898, marketCap: 3289.84, pairAddress: '0x12f0ecc5640605360a3e08c19ccf5d2093733927', pairCreatedAt: 1789578976000, imageUrl: 'https://api/image/thumb', website: 'https://usdcbull.xyz' });
    expect(t!.twitter).toMatch(/usdcbull/);
    expect(t!.telegram).toMatch(/usdcbull/);
  });
  it('a Robinhood launch is priced in ETH: converted with the quote rate, or numbers left out without one', async () => {
    const rh = { ...BULL, status: 'GRADUATED', progressBps: 10000, priceUsdc: '0.000001', marketCapUsdc: '1' };
    const priced = await fetchSynthra(BULL.id, fake({ rh, rate: 2500 }), SYNTHRA_CHAINS, 'https://api');
    expect(priced).toMatchObject({ network: 'robinhood', launchpadNote: 'graduated', priceUsd: 0.0025, marketCap: 2500 });
    const unpriced = await fetchSynthra(BULL.id, fake({ rh }), SYNTHRA_CHAINS, 'https://api');
    expect(unpriced?.launchpadNote).toBe('graduated');
    expect(unpriced?.marketCap).toBeUndefined();
  });
  it('unknown to both subgraphs: not Synthra; a complete curve says so', async () => {
    expect(await fetchSynthra(BULL.id, fake({}), SYNTHRA_CHAINS, 'https://api')).toBeUndefined();
    expect(mapSynthra({ ...BULL, status: 'COMPLETE' }, SYNTHRA_CHAINS[0])?.launchpadNote).toBe('curve complete · graduating');
  });
});
