import { describe, it, expect, vi } from 'vitest';
import {
  applyCreatorFields,
  createLaunchpadClassifier,
  CLANKER_FACTORIES,
  decodeClankerDeployment,
  decodeFlapRecord,
  decodeO1Rights,
  fetchClanker,
  fetchFlap,
  fetchIpfsJson,
  fetchO1,
  fetchPons,
  flapCandidate,
  FLAP_PORTALS,
  GENIUS_SEL,
  ipfsCid,
  O1_FACTORIES,
  PONS_V1_FACTORIES,
  PONS_V2_FACTORIES,
  readCapped,
  tgUrl,
  xUrl,
} from './launchpads.js';
import type { TokenInfo } from './types.js';
import { CHAINS } from './onchain/chains.js';

const w = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexStr = (v: string) => {
  const b = Buffer.from(v, 'utf8');
  return w(b.length.toString(16)) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0');
};
/** one ABI-encoded string return */
const abiString = (v: string) => '0x' + w('20') + hexStr(v);
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41' };
const REVERT = { error: { code: 3, message: 'execution reverted', data: '0xde6137d1' } };
const CID = 'bafkreieyo2r5es4ygcntiq46eoslozlshhqart4ihg7vhhdg7gozvqgjmu';

/**
 * A pretend network: eth_calls are answered from `calls` keyed `rpc|to|data` (or `rpc|to|selector`
 * for calls with arguments), plain GETs from `gets` by URL. Every request is recorded.
 */
function net(calls: Record<string, unknown>, gets: Record<string, unknown> = {}) {
  const asked: { url: string; to?: string; data?: string }[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      const answer = (req: any) => {
        const { to, data } = req.params[0];
        asked.push({ url, to: to.toLowerCase(), data });
        const hit = calls[`${url}|${to.toLowerCase()}|${data}`] ?? calls[`${url}|${to.toLowerCase()}|${data.slice(0, 10)}`];
        const payload = hit === undefined ? REVERT : typeof hit === 'string' ? { result: hit } : hit;
        return { jsonrpc: '2.0', id: req.id, ...(payload as object) };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    }
    asked.push({ url });
    const g = gets[url];
    if (g === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof g === 'string' ? g : JSON.stringify(g));
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}
const rpc = (n: string) => CHAINS[n].rpc;

describe('creator metadata guards', () => {
  it('an X link must be on x.com or twitter.com; a Telegram link on t.me', () => {
    expect(xUrl('@frog')).toBe('https://x.com/frog');
    expect(xUrl('x.com/frog/status/1')).toBe('https://x.com/frog/status/1');
    expect(xUrl('https://twitter.com/frog')).toBe('https://twitter.com/frog');
    for (const bad of ['https://evil.example/frog', 'https://x.com.evil.example/', 'https://evilx.com/a', 'javascript:alert(1)', 'file:///etc/passwd', 'x.com@evil.example', 'data:text/html,hi', 42, null]) expect(xUrl(bad)).toBeUndefined();
    expect(tgUrl('frogchat')).toBe('https://t.me/frogchat');
    expect(tgUrl('https://t.me/frogchat')).toBe('https://t.me/frogchat');
    for (const bad of ['tg://resolve?domain=x', 'https://t.me.evil.example/x', 'javascript:alert(1)', '\\\\host\\share', {}]) expect(tgUrl(bad)).toBeUndefined();
  });

  it('keeps only clean labels, web links and safe images, whatever the field holds', () => {
    const out: Partial<TokenInfo> = {};
    applyCreatorFields(out, {
      name: 'Real\u202Eyarg\u200B Coin\u0000',
      symbol: 'USDT\u2066\u2069EXTRA_LONG_SYMBOL_TEXT',
      image: 'javascript:alert(1)',
      website: 'file://attacker.example/share/x.exe',
      twitter: 'https://evil.example/x',
      telegram: 'tg://msg?text=x',
    });
    expect(out).toEqual({ name: 'Realyarg Coin', symbol: 'USDTEXTRA_LONG_S' });
    const types: Partial<TokenInfo> = {};
    applyCreatorFields(types, { name: { toString: () => 'x' }, symbol: ['A'], image: 7, website: { href: 'https://a' } });
    expect(types).toEqual({});
    const html: Partial<TokenInfo> = {};
    applyCreatorFields(html, { image: 'data:text/html;base64,PHNjcmlwdD4=', website: 'https://ok.example/a' });
    expect(html).toEqual({ website: 'https://ok.example/a' });
  });

  it('parses IPFS ids from any form but refuses paths that climb or odd ids', () => {
    expect(ipfsCid(`ipfs://${CID}`)).toEqual({ cid: CID, path: '' });
    expect(ipfsCid(`https://evil.example/ipfs/${CID}/meta.json`)).toEqual({ cid: CID, path: '/meta.json' });
    expect(ipfsCid(`https://${CID}.ipfs.dweb.link/a.json`)).toEqual({ cid: CID, path: '/a.json' });
    for (const bad of [`ipfs://${CID}/../../x`, `ipfs://${CID}?x=1`, 'ipfs://short', `http://evil.example/ipfs/${CID}`, `${CID}/%2e%2e`, 12]) expect(ipfsCid(bad)).toBeUndefined();
  });

  it('reads metadata JSON only from our own gateways, as an object, and never a big one', async () => {
    const gw = `https://gateway.pinata.cloud/ipfs/${CID}`;
    const ok = net({}, { [gw]: { name: 'A' } });
    expect(await fetchIpfsJson(`https://evil.example/ipfs/${CID}`, ok.fetchImpl)).toEqual({ name: 'A' });
    expect(ok.asked.map((a) => a.url)).toEqual([gw]);
    expect(await fetchIpfsJson(`ipfs://${CID}`, net({}, { [gw]: [1, 2] }).fetchImpl)).toBeUndefined();
    expect(await fetchIpfsJson(`ipfs://${CID}`, net({}, { [gw]: '<html>not json</html>' }).fetchImpl)).toBeUndefined();
    expect(await fetchIpfsJson(`ipfs://${CID}`, net({}, { [gw]: { pad: 'x'.repeat(70_000) } }).fetchImpl)).toBeUndefined();
  });

  it('stops reading a body past its cap, streamed or declared', async () => {
    const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(100_000)); c.close(); } }));
    expect(await readCapped(big, 1_000_000)).toBeUndefined();
    expect(await readCapped(new Response('x', { headers: { 'content-length': '5000000' } }), 1000)).toBeUndefined();
    expect(await readCapped(new Response('{"a":1}'), 1000)).toBe('{"a":1}');
  });
});

describe('Flap: the Portal decides', () => {
  const TOKEN = '0x595460e4c6540ddc706ef9e7f2b34d4dad527777';
  const BSC = FLAP_PORTALS.find((p) => p.network === 'bsc')!.portal.toLowerCase();
  // real getTokenV8Safe answer shape (BSC, 2026-09-28): status 1, 10.7% progress, quoted in ZEC
  const record = (status = 1) =>
    '0x' + w(status.toString(16)) + w('1') + w('1') + w('1') + w('6') + w('1') + w('1') + w('1') + w('1') + w('1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb') + w('1') + w('0') + w('64') + w('0') + w('0') + w('17c2a29b56a1000') + w('0') + w('0');
  const gw = `https://flap.mypinata.cloud/ipfs/${CID}`;

  it('never asks about an address without a Flap vanity suffix', async () => {
    expect(flapCandidate('0x595460e4c6540ddc706ef9e7f2b34d4dad521234')).toBe(false);
    expect(flapCandidate(TOKEN)).toBe(true);
    const { fetchImpl, asked } = net({});
    expect(await fetchFlap('0x595460e4c6540ddc706ef9e7f2b34d4dad521234', fetchImpl)).toBeUndefined();
    expect(await fetchFlap('not-an-address7777', fetchImpl)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('a Portal record makes it Flap: its chain, its page, its progress, metadata through fixed gateways', async () => {
    const { fetchImpl, asked } = net(
      { [`${rpc('bsc')}|${BSC}|0x62fafcca`]: record(), [`${rpc('bsc')}|${TOKEN}|0x67605787`]: abiString(`https://ipfs.io/ipfs/${CID}`) },
      { [gw]: { name: 'Zubit', symbol: 'Zubit', image: 'bafkreib7wxue4y6x477qdslsj5z2hfgbijx6dsnqgbqjhvxx3ff4hmoy7a', twitter: 'https://x.com/zubit/status/1', website: '' } },
    );
    expect(await fetchFlap(TOKEN, fetchImpl)).toEqual({
      launchpad: 'flap',
      launchpadUrl: `https://flap.sh/bnb/${TOKEN}`,
      network: 'bsc',
      launchpadNote: 'bonding · 10.7%',
      name: 'Zubit',
      symbol: 'Zubit',
      imageUrl: '/api/ipfs/bafkreib7wxue4y6x477qdslsj5z2hfgbijx6dsnqgbqjhvxx3ff4hmoy7a',
      twitter: 'https://x.com/zubit/status/1',
    });
    // the token named ipfs.io; the metadata still came from our gateway list
    expect(asked.filter((a) => !a.to).map((a) => a.url)).toEqual([gw]);
  });

  it('a token that answers metaURI() but no Portal knows is not Flap', async () => {
    const { fetchImpl } = net({ [`${rpc('bsc')}|${TOKEN}|0x67605787`]: abiString(`ipfs://${CID}`) });
    expect(await fetchFlap(TOKEN, fetchImpl)).toBeUndefined();
  });

  it('refuses an Invalid status, a short record and a non-hex answer', async () => {
    expect(decodeFlapRecord(record(0))).toBeUndefined();
    expect(decodeFlapRecord(record(9))).toBeUndefined();
    expect(decodeFlapRecord(record().slice(0, 64 * 10))).toBeUndefined();
    expect(await fetchFlap(TOKEN, net({ [`${rpc('bsc')}|${BSC}|0x62fafcca`]: '0x' + 'zz'.repeat(18 * 32) }).fetchImpl)).toBeUndefined();
    expect(decodeFlapRecord(record(4))).toMatchObject({ status: 4 });
  });

  it('asks only the chain the token was placed on', async () => {
    const { fetchImpl, asked } = net({});
    await fetchFlap(TOKEN, fetchImpl, 'monad');
    expect(asked.map((a) => a.url)).toEqual([rpc('monad')]);
    const none = net({});
    await fetchFlap(TOKEN, none.fetchImpl, 'ethereum');
    expect(none.asked).toEqual([]);
  });

  it("drops a creator's hostile metadata", async () => {
    const { fetchImpl } = net(
      { [`${rpc('bsc')}|${BSC}|0x62fafcca`]: record(), [`${rpc('bsc')}|${TOKEN}|0x67605787`]: abiString(CID) },
      { [gw]: { name: '\u202Egnp.exe', symbol: 'A\u200BB', image: 'javascript:alert(1)', website: 'javascript:alert(1)', twitter: 'https://phish.example/x', telegram: 'tg://join?invite=x' } },
    );
    const out = await fetchFlap(TOKEN, fetchImpl);
    expect(out).toMatchObject({ launchpad: 'flap', name: 'gnp.exe', symbol: 'AB' });
    expect(out?.imageUrl).toBeUndefined();
    expect(out?.website).toBeUndefined();
    expect(out?.twitter).toBeUndefined();
    expect(out?.telegram).toBeUndefined();
  });

  it('a metaURI that climbs out of its CID is never fetched', async () => {
    const { fetchImpl, asked } = net({ [`${rpc('bsc')}|${BSC}|0x62fafcca`]: record(), [`${rpc('bsc')}|${TOKEN}|0x67605787`]: abiString(`ipfs://${CID}/../../admin`) });
    expect((await fetchFlap(TOKEN, fetchImpl))?.launchpad).toBe('flap');
    expect(asked.filter((a) => !a.to)).toEqual([]);
  });
});

describe('Clanker: the v4 factory decides', () => {
  const TOKEN = '0xee7af6452f8b31546976f4c38065581ea9dfac48';
  const RH = CLANKER_FACTORIES.find((f) => f.network === 'robinhood')!.factory.toLowerCase();
  // real tokenDeploymentInfo answer for FJORD on Robinhood (2026-09-28)
  const deployment = (token = TOKEN) => '0x' + w('20') + w(token) + w('48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc') + w('e4910b09709423afafd995dd76d8a81cf9134a09') + w('80') + w('0');
  const ZEROS = '0x' + w('20') + w('0') + w('0') + w('0') + w('80') + w('0');
  const tokenCalls = (meta: string, image = 'https://img.example/fjord.png') => ({
    [`${rpc('robinhood')}|${TOKEN}|${SEL.name}`]: abiString('Fjord'),
    [`${rpc('robinhood')}|${TOKEN}|${SEL.symbol}`]: abiString('FJORD'),
    [`${rpc('robinhood')}|${TOKEN}|0xaba83150`]: abiString(image),
    [`${rpc('robinhood')}|${TOKEN}|0x392f37e9`]: abiString(meta),
  });

  it('decodes the record and refuses zeros, a bad offset and a dirty address word', () => {
    expect(decodeClankerDeployment(deployment())).toBe(TOKEN);
    expect(decodeClankerDeployment(ZEROS)).toBeUndefined();
    expect(decodeClankerDeployment('0x' + w('40') + deployment().slice(66))).toBeUndefined();
    expect(decodeClankerDeployment('0x' + w('20') + 'ff'.repeat(12) + TOKEN.slice(2) + w('0').repeat(4))).toBeUndefined();
    expect(decodeClankerDeployment('0x1234')).toBeUndefined();
  });

  it('a record naming the token: badge on its chain, metadata off the token', async () => {
    const meta = JSON.stringify({ description: 'd', socialMediaUrls: [{ platform: 'x', url: 'https://x.com/fjord' }, { platform: 'website', url: 'https://fjord.example' }, { platform: 'telegram', url: 'https://t.me/fjord' }] });
    const { fetchImpl } = net({ [`${rpc('robinhood')}|${RH}|0x22adcdb1`]: deployment(), ...tokenCalls(meta) });
    expect(await fetchClanker(TOKEN, fetchImpl)).toEqual({
      launchpad: 'clanker',
      launchpadUrl: `https://www.clanker.world/clanker/${TOKEN}`,
      network: 'robinhood',
      name: 'Fjord',
      symbol: 'FJORD',
      imageUrl: 'https://img.example/fjord.png',
      twitter: 'https://x.com/fjord',
      website: 'https://fjord.example',
      telegram: 'https://t.me/fjord',
    });
  });

  it('zeros from every factory, or a record for another token, is not clanker', async () => {
    const zeros = Object.fromEntries(CLANKER_FACTORIES.map((f) => [`${rpc(f.network)}|${f.factory.toLowerCase()}|0x22adcdb1`, ZEROS]));
    expect(await fetchClanker(TOKEN, net(zeros).fetchImpl)).toBeUndefined();
    expect(await fetchClanker(TOKEN, net({ [`${rpc('robinhood')}|${RH}|0x22adcdb1`]: deployment('0x' + '12'.repeat(20)) }).fetchImpl)).toBeUndefined();
  });

  it("drops an admin's hostile image and metadata, and ignores metadata too big to be real", async () => {
    const evil = JSON.stringify({ socialMediaUrls: [{ platform: 'x', url: 'javascript:alert(1)' }, { platform: 'website', url: 'file:///C:/x.exe' }, { platform: 'telegram', url: 'https://evil.example' }] });
    const out = await fetchClanker(TOKEN, net({ [`${rpc('robinhood')}|${RH}|0x22adcdb1`]: deployment(), ...tokenCalls(evil, 'data:image/svg+xml,<svg onload=alert(1)>') }).fetchImpl);
    expect(out).toEqual({ launchpad: 'clanker', launchpadUrl: `https://www.clanker.world/clanker/${TOKEN}`, network: 'robinhood', name: 'Fjord', symbol: 'FJORD' });
    const huge = JSON.stringify({ socialMediaUrls: [{ platform: 'website', url: 'https://ok.example' }], pad: 'x'.repeat(20_000) });
    expect((await fetchClanker(TOKEN, net({ [`${rpc('robinhood')}|${RH}|0x22adcdb1`]: deployment(), ...tokenCalls(huge) }).fetchImpl))?.website).toBeUndefined();
    const notJson = await fetchClanker(TOKEN, net({ [`${rpc('robinhood')}|${RH}|0x22adcdb1`]: deployment(), ...tokenCalls('{"socialMediaUrls":') }).fetchImpl);
    expect(notJson?.launchpad).toBe('clanker');
  });

  it('asks only the placed chain, and never a chain it has no factory on', async () => {
    const { fetchImpl, asked } = net({});
    await fetchClanker(TOKEN, fetchImpl, 'base');
    expect(asked.map((a) => a.url)).toEqual([rpc('base')]);
    const bsc = net({});
    await fetchClanker(TOKEN, bsc.fetchImpl, 'bsc');
    expect(bsc.asked).toEqual([]);
  });
});

describe('o1: the factory decides, the API key only adds', () => {
  const TOKEN = '0x496a5980ca4fa2751ba0a4ca5566f1a2b26f9001';
  const RH = O1_FACTORIES.find((f) => f.network === 'robinhood')!.factory.toLowerCase();
  // real creatorRights answer for PAWFFLE (Robinhood, 2026-09-28)
  const rights = '0x' + w('f0a42c87f9887ba11a01f6ad9c68a925c4922d24') + w('f0a42c87f9887ba11a01f6ad9c68a925c4922d24') + w('0') + w('f0a42c87f9887ba11a01f6ad9c68a925c4922d24') + w('ce973e2bc93a5a4dfd7d4ff7a31ccc0e4221e6ac') + w('0');
  const gw = `https://gateway.pinata.cloud/ipfs/${CID}`;
  const base = (uri: string) => ({
    [`${rpc('robinhood')}|${RH}|0x39b372a1`]: rights,
    [`${rpc('robinhood')}|${TOKEN}|${SEL.name}`]: abiString('Pawffle'),
    [`${rpc('robinhood')}|${TOKEN}|${SEL.symbol}`]: abiString('PAWFFLE'),
    [`${rpc('robinhood')}|${TOKEN}|0xe8a3d485`]: abiString(uri),
  });

  it('decodes creatorRights and refuses one without a creator or a pool', () => {
    expect(decodeO1Rights(rights)).toEqual({ poolId: '0x' + w('ce973e2bc93a5a4dfd7d4ff7a31ccc0e4221e6ac') });
    expect(decodeO1Rights('0x' + w('0').repeat(6))).toBeUndefined();
    expect(decodeO1Rights('0x' + w('1').repeat(4) + w('0') + w('0'))).toBeUndefined();
  });

  it('recognised without a key: name and ticker off the token, metadata off IPFS', async () => {
    const { fetchImpl } = net(base(`ipfs://${CID}`), { [gw]: { image: 'ipfs://bafkreiekfpmqvlvgyuaqr2xljcjogog2vyij4knl0000000000000', twitter: 'pawffle' } });
    expect(await fetchO1(TOKEN, undefined, fetchImpl)).toEqual({
      launchpad: 'o1',
      launchpadUrl: 'https://launch.o1.exchange',
      network: 'robinhood',
      name: 'Pawffle',
      symbol: 'PAWFFLE',
      imageUrl: '/api/ipfs/bafkreiekfpmqvlvgyuaqr2xljcjogog2vyij4knl0000000000000',
      twitter: 'https://x.com/pawffle',
    });
  });

  it('never fetches a contractURI on a host the creator picked', async () => {
    const { fetchImpl, asked } = net(base('https://tracker.example/meta.json'));
    expect((await fetchO1(TOKEN, undefined, fetchImpl))?.symbol).toBe('PAWFFLE');
    expect(asked.filter((a) => !a.to)).toEqual([]);
  });

  it('a factory revert everywhere is not o1, key or no key', async () => {
    const { fetchImpl, asked } = net({});
    expect(await fetchO1(TOKEN, 'key', fetchImpl)).toBeUndefined();
    expect(asked.every((a) => a.to)).toBe(true); // the API is never asked about a token the chain does not know
  });

  it("with a key, the API's fields go through the same guards", async () => {
    const api = `https://api.launch.o1.exchange/v1/tokens/4663/${TOKEN}`;
    const { fetchImpl } = net(base(`ipfs://${CID}`), { [api]: { data: { token: { name: 'Paw\u202Effle', symbol: 'PAW', image_url: 'javascript:alert(1)', website: 'file:///x', x: 'https://evil.example', telegram: 'pawchat' } } } });
    expect(await fetchO1(TOKEN, 'key', fetchImpl)).toEqual({ launchpad: 'o1', launchpadUrl: 'https://launch.o1.exchange', network: 'robinhood', name: 'Pawffle', symbol: 'PAW', telegram: 'https://t.me/pawchat' });
  });
});

describe('Pons: the token names a factory, the factory must name the token', () => {
  const RH = rpc('robinhood');
  const V1_TOKEN = '0x4cbdeb8298b4e9d2f13e088ef11aa1aeda883498';
  const V1 = PONS_V1_FACTORIES[1].toLowerCase();
  const V2_TOKEN = '0xd548f526c1cb97498a33652952ee9728973d1eca';
  const V2 = PONS_V2_FACTORIES[0].toLowerCase();
  const CURVE = '0xad3bea4069cc212a576d44ae12a7bc466f58c621';
  const NOXA = '0xdd84fddea1206115b37dbbc0ba5721530e1ba9c5';
  // real V1 record for PONSCLAWS (13 words, exists at word 11)
  const v1Record = (token = V1_TOKEN) => '0x' + w(token) + w('9be930ddf889055e26d900b937cccc61428edc59') + w('0bd7d308f8e1639fab988df18a8011f41eacad73') + w('73991a25c818bf1f1128deaab1492d45638de0d3') + w('1c032') + w('0') + w('0') + w('1859121') + w('33b2e3c9fd0803ce8000000') + w('0') + w('2710') + w('1') + w('0');
  // real V2 record for WIGBAG (15 words, phase 0, native ETH)
  const v2Record = '0x' + w(V2_TOKEN) + w(CURVE) + w('4e948cbb41ada980414c28402f16297a4a915277') + w('4e948cbb41ada980414c28402f16297a4a915277') + w('0') + w('3a4965bf58a40000') + w('0') + w('c8') + w('c8') + w('0') + w('0') + w('0') + w('0') + w('0') + w('1');
  const info = (logo: string, socials: string[]) => {
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
    return '0x' + w('d'.repeat(40)) + w(logoOff.toString(16)) + w(descOff.toString(16)) + w(socOff.toString(16)) + logoEnc + descEnc + heads.join('') + tails.join('');
  };

  it('V1: badge, per-token page, creator metadata cleaned, and its v3 pool', async () => {
    const { fetchImpl } = net({
      [`${RH}|${V1_TOKEN}|0x536dac9b`]: '0x' + w(V1),
      [`${RH}|${V1}|0x3cf28b5a`]: v1Record(),
      [`${RH}|${V1_TOKEN}|${GENIUS_SEL.getTokenInfo}`]: info(`ipfs://${CID}`, ['@ponsclaws', 'javascript:alert(1)', '', 'https://pons.family/launchpad', '']),
      [`${RH}|${V1_TOKEN}|${SEL.name}`]: abiString('Pons\u202E Claws'),
      [`${RH}|${V1_TOKEN}|${SEL.symbol}`]: abiString('PONSCLAWS'),
      [`${RH}|${V1_TOKEN}|0x665a11ca`]: '0x' + w('084e3102d9e20fc0a9d13642ea9bfbd6248b072e'),
    });
    expect(await fetchPons(V1_TOKEN, fetchImpl)).toEqual({
      launchpad: 'pons',
      launchpadUrl: `https://www.ponsfamily.com/launchpad/${V1_TOKEN}`,
      network: 'robinhood',
      name: 'Pons Claws',
      symbol: 'PONSCLAWS',
      imageUrl: `/api/ipfs/${CID}`,
      twitter: 'https://x.com/ponsclaws',
      website: 'https://pons.family/launchpad',
      pairAddress: '0x084e3102d9e20fc0a9d13642ea9bfbd6248b072e',
      dex: 'uniswap',
    });
  });

  it('V2: the Genius-stack reader on Robinhood, the curve as its pool in ETH', async () => {
    const { fetchImpl } = net({
      [`${RH}|${V2_TOKEN}|0x536dac9b`]: '0x' + w(V2),
      [`${RH}|${V2}|0x3cf28b5a`]: v2Record,
      [`${RH}|${V2_TOKEN}|${SEL.name}`]: abiString('WIGBAG'),
      [`${RH}|${V2_TOKEN}|${SEL.symbol}`]: abiString('WIGBAG'),
      [`${RH}|${CURVE}|${GENIUS_SEL.realQuoteReserve}`]: '0x' + w((42n * 10n ** 16n).toString(16)),
    });
    expect(await fetchPons(V2_TOKEN, fetchImpl)).toEqual({
      launchpad: 'pons',
      launchpadUrl: `https://www.ponsfamily.com/launchpad/${V2_TOKEN}`,
      network: 'robinhood',
      launchpadNote: 'on the curve · 10.0% to graduation',
      name: 'WIGBAG',
      symbol: 'WIGBAG',
      pairAddress: CURVE,
      dex: 'pons',
      quoteSymbol: 'ETH',
    });
  });

  it('a NOXA token (same contracts, another factory) is not Pons, and its factory is never asked', async () => {
    const { fetchImpl, asked } = net({ [`${RH}|0x6df429fa8ff554c05a1f10aea306e8b46e034663|0x536dac9b`]: '0x' + w(NOXA) });
    expect(await fetchPons('0x6df429fa8ff554c05a1f10aea306e8b46e034663', fetchImpl)).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it('a token claiming a Pons factory the factory has no record of is not Pons', async () => {
    const liar = '0x' + '77'.repeat(20);
    const v1 = net({ [`${RH}|${liar}|0x536dac9b`]: '0x' + w(V1), [`${RH}|${V1}|0x3cf28b5a`]: '0x' + w('0').repeat(13) });
    expect(await fetchPons(liar, v1.fetchImpl)).toBeUndefined();
    const other = net({ [`${RH}|${liar}|0x536dac9b`]: '0x' + w(V1), [`${RH}|${V1}|0x3cf28b5a`]: v1Record() });
    expect(await fetchPons(liar, other.fetchImpl)).toBeUndefined();
    const v2 = net({ [`${RH}|${liar}|0x536dac9b`]: '0x' + w(V2), [`${RH}|${V2}|0x3cf28b5a`]: '0x' + w('0').repeat(15) });
    expect(await fetchPons(liar, v2.fetchImpl)).toBeUndefined();
  });

  it('a dirty or non-hex launchFactory answer is ignored', async () => {
    expect(await fetchPons(V1_TOKEN, net({ [`${RH}|${V1_TOKEN}|0x536dac9b`]: '0x' + 'ff'.repeat(12) + V1.slice(2) }).fetchImpl)).toBeUndefined();
    expect(await fetchPons(V1_TOKEN, net({ [`${RH}|${V1_TOKEN}|0x536dac9b`]: '0x' + 'zz'.repeat(32) }).fetchImpl)).toBeUndefined();
  });
});

describe('no launchpad or node answer is followed through a redirect', () => {
  it('every request the probes make refuses redirects', async () => {
    const inits: any[] = [];
    const f = (async (_url: string, init?: any) => (inits.push(init), new Response('{}'))) as unknown as typeof fetch;
    await fetchFlap('0x595460e4c6540ddc706ef9e7f2b34d4dad527777', f);
    await fetchClanker('0x' + '12'.repeat(20), f, 'base');
    await fetchO1('0x' + '12'.repeat(20), 'key', f, 'base');
    await fetchPons('0x' + '12'.repeat(20), f);
    await fetchIpfsJson(`ipfs://${CID}`, f);
    expect(inits.length).toBeGreaterThan(4);
    expect(inits.every((i) => i?.redirect === 'error')).toBe(true);
  });
});

describe('classifier: the placed chain reaches the probes', () => {
  it('passes the network hint through', async () => {
    const flap = vi.fn(async () => undefined);
    const classify = createLaunchpadClassifier({ flap, log: () => {} });
    await classify('0x' + '1'.repeat(36) + '7777', 'evm', 'monad');
    expect(flap).toHaveBeenCalledWith('0x' + '1'.repeat(36) + '7777', 'monad');
  });
});
