import { describe, it, expect } from 'vitest';
import { decodeNoxaTokenInfo, fetchNadfun, fetchNoxa, fetchUbifun, nadfunCandidate, NADFUN, NOXA_FACTORIES, ubiPool, UBIFUN } from './evmpads.js';
import { createLaunchpadClassifier, PONS_V1_FACTORIES } from './launchpads.js';
import { CHAINS } from './onchain/chains.js';

const w = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexStr = (v: string) => {
  const b = Buffer.from(v, 'utf8');
  return w(b.length.toString(16)) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0');
};
const abiString = (v: string) => '0x' + w('20') + hexStr(v);
const rpc = (n: string) => CHAINS[n].rpc;
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', tokenURI: '0x3c130d90' };

/** A pretend network answering batched eth_calls from `calls` (`rpc|to|data` or `rpc|to|selector`), GETs from `gets`. */
function net(calls: Record<string, string>, gets: Record<string, unknown> = {}) {
  const asked: { url: string; to?: string; data?: string; redirect?: string }[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      const one = (req: any) => {
        const { to, data } = req.params[0];
        asked.push({ url, to: to.toLowerCase(), data, redirect: init.redirect });
        const hit = calls[`${url}|${to.toLowerCase()}|${data}`] ?? calls[`${url}|${to.toLowerCase()}|${data.slice(0, 10)}`];
        return hit === undefined ? { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } } : { jsonrpc: '2.0', id: req.id, result: hit };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    }
    asked.push({ url, redirect: init?.redirect });
    const g = gets[url];
    return g === undefined ? new Response('nope', { status: 404 }) : new Response(typeof g === 'string' ? g : JSON.stringify(g));
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

/** getTokenInfo in NOXA's shape: the Genius layout wrapped in one more tuple, socials (telegram, twitter, discord, website, farcaster). */
function noxaInfo(logo: string, socials: string[]) {
  const logoEnc = hexStr(logo);
  const descEnc = hexStr('d');
  const tails = socials.map(hexStr);
  let rel = 5 * 32;
  const heads = tails.map((t) => {
    const h = w(rel.toString(16));
    rel += t.length / 2;
    return h;
  });
  const logoOff = 4 * 32;
  const descOff = logoOff + logoEnc.length / 2;
  const socOff = descOff + descEnc.length / 2;
  return '0x' + w('20') + w('d'.repeat(40)) + w(logoOff.toString(16)) + w(descOff.toString(16)) + w(socOff.toString(16)) + logoEnc + descEnc + heads.join('') + tails.join('');
}
/** Pons V1 / NOXA getLaunchedToken: 13 words, exists at word 11 */
const v1Record = (token: string, exists = 1) => '0x' + w(token) + w('1') + w('0bd7d308f8e1639fab988df18a8011f41eacad73') + w('1') + w('1') + w('0') + w('0') + w('1') + w('1') + w('0') + w('2710') + w(exists.toString(16)) + w('0');

describe('NOXA Fun: an allowlisted factory must name the token', () => {
  const T = '0x6df429fa8ff554c05a1f10aea306e8b46e034663';
  const F = NOXA_FACTORIES[0].factory.toLowerCase();
  const RH = rpc('robinhood');
  const base = (over: Record<string, string> = {}) => ({
    [`${RH}|${T}|0x536dac9b`]: '0x' + w(F),
    [`${RH}|${F}|0x3cf28b5a`]: v1Record(T),
    [`${RH}|${T}|0xabb1dc44`]: noxaInfo('ipfs://QmTPn2MwR7CpoZpo74spmoYiJQi1mw5A78r3pF5T6XZwJj', ['https://t.me/Certicosign', 'https://x.com/Certicos_Sign', '', 'https://certicosign.com/', '']),
    [`${RH}|${T}|${SEL.name}`]: abiString('CERTICOS'),
    [`${RH}|${T}|${SEL.symbol}`]: abiString('CERTIC'),
    [`${RH}|${T}|0x665a11ca`]: '0x' + w(POOL),
    [`${RH}|${POOL}|0x0dfe1681`]: '0x' + w(WETH),
    [`${RH}|${POOL}|0xd21220a7`]: '0x' + w(T),
    ...over,
  });
  const POOL = '0xfbaeb5dd49473d8f4b4499fdbc5ed9c761240edd';
  const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

  it('a real launch: badge, page, socials in NOXA order, its v3 pool', async () => {
    expect(await fetchNoxa(T, net(base()).fetchImpl, 'robinhood')).toEqual({
      launchpad: 'noxa',
      launchpadUrl: `https://fun.noxa.fi/token/${T}`,
      network: 'robinhood',
      name: 'CERTICOS',
      symbol: 'CERTIC',
      imageUrl: '/api/ipfs/QmTPn2MwR7CpoZpo74spmoYiJQi1mw5A78r3pF5T6XZwJj',
      telegram: 'https://t.me/Certicosign',
      twitter: 'https://x.com/Certicos_Sign',
      website: 'https://certicosign.com/',
      pairAddress: '0xfbaeb5dd49473d8f4b4499fdbc5ed9c761240edd',
      dex: 'uniswap',
    });
  });

  it('the pool is used only when the record pairs a known quote and the pool holds exactly those two tokens', async () => {
    const FAKE_USDC = '0x' + '5a'.repeat(20);
    const fakePair = base({ [`${RH}|${F}|0x3cf28b5a`]: '0x' + v1Record(T).slice(2, 2 + 128) + w(FAKE_USDC) + v1Record(T).slice(2 + 192) });
    const out = await fetchNoxa(T, net(fakePair).fetchImpl, 'robinhood');
    expect(out?.launchpad).toBe('noxa');
    expect(out?.pairAddress).toBeUndefined();
    const wrongPool = await fetchNoxa(T, net(base({ [`${RH}|${POOL}|0x0dfe1681`]: '0x' + w(FAKE_USDC) })).fetchImpl, 'robinhood');
    expect(wrongPool?.pairAddress).toBeUndefined();
  });

  it('a MegaETH token naming a Robinhood NOXA factory is not NOXA (factories are per chain)', async () => {
    const MEGA = rpc('megaeth');
    const { fetchImpl } = net({ [`${MEGA}|${T}|0x536dac9b`]: '0x' + w(F), [`${MEGA}|${F}|0x3cf28b5a`]: v1Record(T) });
    expect(await fetchNoxa(T, fetchImpl, 'megaeth')).toBeUndefined();
  });

  it('a token claiming a NOXA factory that has no record of it, a Pons factory, or an unknown one is not NOXA', async () => {
    expect(await fetchNoxa(T, net(base({ [`${RH}|${F}|0x3cf28b5a`]: v1Record(T, 0) })).fetchImpl, 'robinhood')).toBeUndefined();
    expect(await fetchNoxa(T, net(base({ [`${RH}|${F}|0x3cf28b5a`]: v1Record('0x' + '12'.repeat(20)) })).fetchImpl, 'robinhood')).toBeUndefined();
    const pons = net(base({ [`${RH}|${T}|0x536dac9b`]: '0x' + w(PONS_V1_FACTORIES[1]) }));
    expect(await fetchNoxa(T, pons.fetchImpl, 'robinhood')).toBeUndefined();
    expect(pons.asked.some((a) => a.to === PONS_V1_FACTORIES[1].toLowerCase())).toBe(false);
    expect(await fetchNoxa(T, net(base({ [`${RH}|${T}|0x536dac9b`]: '0x' + w('99'.repeat(20)) })).fetchImpl, 'robinhood')).toBeUndefined();
    expect(await fetchNoxa(T, net(base({ [`${RH}|${T}|0x536dac9b`]: '0x' + 'ff'.repeat(12) + F.slice(2) })).fetchImpl, 'robinhood')).toBeUndefined();
  });

  it("drops a creator's hostile metadata and refuses token info without NOXA's wrapper", async () => {
    const evil = base({
      [`${RH}|${T}|0xabb1dc44`]: noxaInfo('javascript:alert(1)', ['tg://join', 'https://evil.example/x', '', 'file:///C:/x.exe', '']),
      [`${RH}|${T}|${SEL.name}`]: abiString('CERT\u202EICOS\u200B'),
    });
    const out = await fetchNoxa(T, net(evil).fetchImpl, 'robinhood');
    expect(out).toMatchObject({ launchpad: 'noxa', name: 'CERTICOS' });
    for (const k of ['imageUrl', 'telegram', 'twitter', 'website'] as const) expect(out?.[k]).toBeUndefined();
    expect(decodeNoxaTokenInfo('0x' + noxaInfo('ipfs://x', ['', '', '', '', '']).slice(66))).toBeUndefined();
    expect(decodeNoxaTokenInfo('0x' + w('20') + 'ff'.repeat(200))).toBeUndefined();
  });

  it('asks only the chain it was placed on; other chains are never touched', async () => {
    const { fetchImpl, asked } = net({});
    await fetchNoxa(T, fetchImpl, 'megaeth');
    expect(new Set(asked.map((a) => a.url))).toEqual(new Set([rpc('megaeth')]));
    const none = net({});
    await fetchNoxa(T, none.fetchImpl, 'base');
    expect(none.asked).toEqual([]);
  });
});

describe('Nad.fun: its curve contracts must know the token', () => {
  const T = '0x085e6b7f3b432d56d3aad9e022e2dafe200f7777';
  const MON = rpc('monad');
  const META = 'https://storage.nadapp.net/metadata/7b72e96d-ea83-4391-a121-14cf85732884.json';
  const PAIR = '0x04561a5a3c21589e985bbbaa8ac051ef10f833c1';
  const v2 = (token = T, graduated = 0) =>
    '0x' + w(token) + w('9e21d5c0978ab3a28b9af9ea85e09b6818ad7b42') + w('3bd359c1119da7da1d913d1c4d2b7c461115433a') + w('1').repeat(7) + w(graduated.toString(16)) + w('64') + w('0') + w('0') + w(PAIR) + w('1');
  const base = (over: Record<string, string> = {}) => ({
    [`${MON}|${NADFUN.v2.toLowerCase()}|0x61f029fb`]: v2(),
    [`${MON}|${T}|${SEL.tokenURI}`]: abiString(META),
    [`${MON}|${T}|${SEL.name}`]: abiString('NOM'),
    [`${MON}|${T}|${SEL.symbol}`]: abiString('NOM'),
    ...over,
  });

  it('never asks about an address without the 7777 suffix, or one placed on another chain', async () => {
    expect(nadfunCandidate('0x085e6b7f3b432d56d3aad9e022e2dafe200f1234')).toBe(false);
    const { fetchImpl, asked } = net(base());
    expect(await fetchNadfun('0x085e6b7f3b432d56d3aad9e022e2dafe200f1234', fetchImpl)).toBeUndefined();
    expect(await fetchNadfun(T, fetchImpl, 'bsc')).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('a V2 launch: badge, page, status, metadata from Nad.fun storage only', async () => {
    const { fetchImpl, asked } = net(base(), { [META]: { name: 'NOM', image_uri: 'https://storage.nadapp.net/coin/720dc0a7', website: '', twitter: 'nomcoin', is_nsfw: false } });
    expect(await fetchNadfun(T, fetchImpl)).toEqual({
      launchpad: 'nadfun',
      launchpadUrl: `https://nad.fun/tokens/${T}`,
      network: 'monad',
      launchpadNote: 'bonding',
      name: 'NOM',
      symbol: 'NOM',
      imageUrl: 'https://storage.nadapp.net/coin/720dc0a7',
      twitter: 'https://x.com/nomcoin',
    });
    expect(asked.filter((a) => !a.to)).toEqual([{ url: META, redirect: 'error' }]);
  });

  it('graduated: its pair becomes the pool', async () => {
    const out = await fetchNadfun(T, net(base({ [`${MON}|${NADFUN.v2.toLowerCase()}|0x61f029fb`]: v2(T, 1) })).fetchImpl);
    expect(out).toMatchObject({ launchpadNote: 'graduated', pairAddress: PAIR, dex: 'nadfun' });
  });

  it('a V2 record for another token, or all-zero records everywhere, is not Nad.fun', async () => {
    expect(await fetchNadfun(T, net(base({ [`${MON}|${NADFUN.v2.toLowerCase()}|0x61f029fb`]: v2('0x' + '12'.repeat(18) + '7777') })).fetchImpl)).toBeUndefined();
    const zeros = { [`${MON}|${NADFUN.v2.toLowerCase()}|0x61f029fb`]: '0x' + w('0').repeat(16), [`${MON}|${NADFUN.v1.toLowerCase()}|0x2cc3dc6e`]: '0x' + w('0').repeat(8) };
    expect(await fetchNadfun(T, net(zeros).fetchImpl)).toBeUndefined();
    const v1 = { ...zeros, [`${MON}|${NADFUN.v1.toLowerCase()}|0x2cc3dc6e`]: '0x' + w('17df1bbd0092f67a6b') + w('0').repeat(7), [`${MON}|${NADFUN.v1.toLowerCase()}|0x68a4c8b7`]: '0x' + w('1') };
    expect(await fetchNadfun(T, net(v1).fetchImpl)).toMatchObject({ launchpad: 'nadfun', launchpadNote: 'graduated' });
  });

  it('a tokenURI anywhere but Nad.fun storage is never fetched; NSFW images and hostile links are dropped', async () => {
    for (const uri of ['https://evil.example/m.json', 'http://storage.nadapp.net/metadata/7b72e96d-ea83-4391-a121-14cf85732884.json', 'https://storage.nadapp.net.evil.example/metadata/7b72e96d-ea83-4391-a121-14cf85732884.json', 'https://storage.nadapp.net/metadata/../../admin', 'file:///etc/passwd']) {
      const { fetchImpl, asked } = net(base({ [`${MON}|${T}|${SEL.tokenURI}`]: abiString(uri) }));
      expect((await fetchNadfun(T, fetchImpl))?.launchpad).toBe('nadfun');
      expect(asked.filter((a) => !a.to)).toEqual([]);
    }
    const nsfw = await fetchNadfun(T, net(base(), { [META]: { image_uri: 'https://storage.nadapp.net/coin/x', is_nsfw: true, website: 'javascript:alert(1)', telegram: 'tg://x', twitter: 'https://evil.example' } }).fetchImpl);
    for (const k of ['imageUrl', 'website', 'telegram', 'twitter'] as const) expect(nsfw?.[k]).toBeUndefined();
    for (const flag of ['true', 1, 'yes', null]) {
      const out = await fetchNadfun(T, net(base(), { [META]: { image_uri: 'https://storage.nadapp.net/coin/x', is_nsfw: flag } }).fetchImpl);
      expect(out?.imageUrl).toBeUndefined();
    }
    for (const uri of ['HTTPS://STORAGE.NADAPP.NET/metadata/7b72e96d-ea83-4391-a121-14cf85732884.json', `${META}?x`, `${META}#x`, 'https://storage.n\u0430dapp.net/metadata/7b72e96d-ea83-4391-a121-14cf85732884.json']) {
      const { fetchImpl, asked } = net(base({ [`${MON}|${T}|${SEL.tokenURI}`]: abiString(uri) }));
      await fetchNadfun(T, fetchImpl);
      expect(asked.filter((a) => !a.to)).toEqual([]);
    }
    // surrounding whitespace is trimmed: what is fetched is still exactly Nad.fun's storage URL
    const ws = net(base({ [`${MON}|${T}|${SEL.tokenURI}`]: abiString(`${META}\n`) }));
    await fetchNadfun(T, ws.fetchImpl);
    expect(ws.asked.filter((a) => !a.to).map((a) => a.url)).toEqual([META]);
    const huge = await fetchNadfun(T, net(base(), { [META]: { website: 'https://ok.example', pad: 'x'.repeat(70_000) } }).fetchImpl);
    expect(huge?.website).toBeUndefined();
  });
});

describe('UBI.fun: the Flaunch NFT must exist for the token', () => {
  const T = '0xfa3ffdf775cc3f6ac82cd258fb948a8a21e1749e';
  const ARC = rpc('arc');
  const USDC = '0x3600000000000000000000000000000000000000';
  const PM = UBIFUN.positionManager;
  // real poolKey for UBI (2026-09-28) and the pool id it hashes to (its slot0 is live on Arc's PoolManager)
  const KEY = '0x' + w(USDC) + w(T) + w('0') + w('3c') + w(PM);
  const POOL_ID = '0xcb39398862db54384d5bc8c98077e012a5ae7cb1dbc3c6fcaf256c5e10568ab8';
  const CID = 'QmbKB3e7YCch5HuUUud3J6UqKtR9cNhc54r8dy1mK7XLz2';
  const base = (over: Record<string, string> = {}) => ({
    [`${ARC}|${UBIFUN.flaunch}|0x7ca31724`]: '0x' + w('36'),
    [`${ARC}|${T}|0x87211ceb`]: '0x' + w(UBIFUN.flaunch),
    [`${ARC}|${PM}|0x55d1cb60`]: KEY,
    [`${ARC}|${T}|${SEL.tokenURI}`]: abiString(`ipfs://${CID}`),
    [`${ARC}|${T}|${SEL.name}`]: abiString('UBI'),
    [`${ARC}|${T}|${SEL.symbol}`]: abiString('UBI'),
    ...over,
  });

  it('computes the real v4 pool id from the pool key', () => {
    expect(ubiPool(KEY, T)).toEqual({ poolId: POOL_ID, quote: USDC });
    expect(ubiPool('0x' + w(USDC) + w('12'.repeat(20)) + w('0') + w('3c') + w(PM), T)).toBeUndefined();
    expect(ubiPool('0x' + w(USDC) + w(T) + w('0') + 'f'.repeat(64) + w(PM), T)).toBeUndefined();
    expect(ubiPool('0x' + w(USDC) + w(T) + w('1000000') + w('3c') + w(PM), T)).toBeUndefined();
    // a pool on some other hook, or a currency word with high bits set, is not UBI.fun's pool
    expect(ubiPool('0x' + w(USDC) + w(T) + w('0') + w('3c') + w('77'.repeat(20)), T)).toBeUndefined();
    expect(ubiPool('0x' + 'ff'.repeat(12) + USDC.slice(2) + w(T) + w('0') + w('3c') + w(PM), T)).toBeUndefined();
  });

  it('a real launch: badge, page, its v4 pool against USDC, metadata through our IPFS gateway', async () => {
    const gw = `https://gateway.pinata.cloud/ipfs/${CID}`;
    const { fetchImpl, asked } = net(base(), { [gw]: { image: 'ipfs://QmUqdY5EPyAcjxoBZMYQFYSiMAe3Dcy2n56AvgW2zM92PP', website: 'https://ubi.fun', twitter: 'https://x.com/ubidotfun', telegram: 'https://t.me/ubidotfun' } });
    expect(await fetchUbifun(T, fetchImpl)).toEqual({
      launchpad: 'ubifun',
      launchpadUrl: `https://ubi.fun/markets/${T}`,
      network: 'arc',
      pairAddress: POOL_ID,
      quoteAddress: USDC,
      quoteSymbol: 'USDC',
      dex: 'uniswap',
      name: 'UBI',
      symbol: 'UBI',
      imageUrl: '/api/ipfs/QmUqdY5EPyAcjxoBZMYQFYSiMAe3Dcy2n56AvgW2zM92PP',
      website: 'https://ubi.fun',
      twitter: 'https://x.com/ubidotfun',
      telegram: 'https://t.me/ubidotfun',
    });
    expect(asked.filter((a) => !a.to).map((a) => a.url)).toEqual([gw]);
  });

  it('no NFT, or a token naming another Flaunch, is not UBI.fun', async () => {
    expect(await fetchUbifun(T, net(base({ [`${ARC}|${UBIFUN.flaunch}|0x7ca31724`]: '0x' + w('0') })).fetchImpl)).toBeUndefined();
    expect(await fetchUbifun(T, net(base({ [`${ARC}|${T}|0x87211ceb`]: '0x' + w('77'.repeat(20)) })).fetchImpl)).toBeUndefined();
    expect(await fetchUbifun(T, net(base({ [`${ARC}|${UBIFUN.flaunch}|0x7ca31724`]: '0x' + 'zz'.repeat(32) })).fetchImpl)).toBeUndefined();
    const other = net({});
    expect(await fetchUbifun(T, other.fetchImpl, 'robinhood')).toBeUndefined();
    expect(other.asked).toEqual([]);
  });

  it('an http tokenURI is never fetched; a quote that is not Arc USDC gets no label', async () => {
    const { fetchImpl, asked } = net(base({ [`${ARC}|${T}|${SEL.tokenURI}`]: abiString('https://tracker.example/m.json') }));
    expect((await fetchUbifun(T, fetchImpl))?.launchpad).toBe('ubifun');
    expect(asked.filter((a) => !a.to)).toEqual([]);
    const FAKE = '0x' + '11'.repeat(20);
    const out = await fetchUbifun(T, net(base({ [`${ARC}|${PM}|0x55d1cb60`]: '0x' + w(FAKE) + w(T) + w('0') + w('3c') + w(PM) })).fetchImpl);
    expect(out).toMatchObject({ quoteAddress: FAKE });
    expect(out?.quoteSymbol).toBeUndefined();
  });
});

describe('node answers', () => {
  it('a body that is not JSON, not a list, too big, or answers other ids decides nothing', async () => {
    const T = '0x' + '1'.repeat(36) + '7777';
    const bodies = ['<html>', '{"result":"0x01"}', JSON.stringify([{ id: 99, result: '0x' + w('1') }]), 'x'.repeat(300_000)];
    for (const b of bodies) {
      const f = (async () => new Response(b)) as unknown as typeof fetch;
      expect(await fetchNadfun(T, f)).toBeUndefined();
      expect(await fetchUbifun(T, f)).toBeUndefined();
      expect(await fetchNoxa(T, f, 'robinhood')).toBeUndefined();
    }
    const short = (async (_u: string, init: any) => new Response(JSON.stringify(JSON.parse(init.body).map((r: any) => ({ id: r.id, result: '0x' + w('1').repeat(3) }))))) as unknown as typeof fetch;
    expect(await fetchNadfun(T, short)).toBeUndefined();
  });
});

describe('probe order', () => {
  it('NOXA right after Pons; Nad.fun and UBI.fun after Flap; every request refuses redirects', async () => {
    const order: string[] = [];
    const probe = (n: string) => async () => (order.push(n), undefined);
    await createLaunchpadClassifier({ pons: probe('pons'), noxa: probe('noxa'), genius: probe('genius'), flap: probe('flap'), nadfun: probe('nadfun'), ubifun: probe('ubifun'), virtuals: probe('virtuals'), log: () => {} })('0x' + '1'.repeat(36) + '7777', 'evm');
    expect(order).toEqual(['pons', 'noxa', 'genius', 'flap', 'nadfun', 'ubifun', 'virtuals']);
    const { fetchImpl, asked } = net({});
    await fetchNoxa('0x' + '1'.repeat(40), fetchImpl);
    await fetchNadfun('0x' + '1'.repeat(36) + '7777', fetchImpl);
    await fetchUbifun('0x' + '1'.repeat(40), fetchImpl);
    expect(asked.length).toBeGreaterThan(3);
    expect(asked.every((a) => a.redirect === 'error')).toBe(true);
  });
});
