import { describe, it, expect } from 'vitest';
import { decodeBatch, upsertMint } from './mintgo.js';
import type { MintEvent } from './types.js';

// A real frame captured from wss://mintgo.fun/api/realtime?scope=all on 2026-09-12 (two contracts, two rows).
const FRAME = [1, 1789121431284737, 2,
  [
    ['0x7986e0720706e0ed054a110d68067c78c1f1c235', 'FYSH', 'fyshverse', 'https://i2c.seadn.io/collection/fyshverse/logo.png', 'fyshverse', 'https://opensea.io/collection/fyshverse', 'https://fysh.xyz/', 'https://x.com/fyshverse', '', '', null, 'erc721'],
    ['0x9d2a003322874163cbb18f7f538a1aaea49b75d1', 'Chump NFT', 'chump-nft-310989788', 'https://i2c.seadn.io/collection/chump/logo.png', 'chump-nft-310989788', 'https://opensea.io/collection/chump-nft-310989788', '', '', '', '', null, 'erc721'],
  ],
  [
    ['0x44d7…e607-0x7986e0720706e0ed054a110d68067c78c1f1c235-47', '0x44d7e607', 61364140, 1789242409000, 0, ['558', '559', '560', '561', '562'], 5, '0xdbe88b310e5d121875f353421a33866adf34a111', '', '', '0', 2, 'mint', null, null, '', '', 'robinhood:mint:…', 1789242409763000, 5, 1, 0],
    ['0x6947…752f-0x9d2a003322874163cbb18f7f538a1aaea49b75d1-174', '0x6947752f', 61364140, 1789242409000, 1, ['462'], 1, '0xfa2e3c21af8ba3b7170fdbb796190685e00e6e8d', '0xfa2e3c21af8ba3b7170fdbb796190685e00e6e8d', '', '0.005', 19, 'mint', 120, 1000, '0.005', 'seadrop-wss', 'robinhood:mint:…', 1789242409763001, 1, 1, 0],
  ],
];

describe('decodeBatch', () => {
  it('expands the compact frame into MintEvents', () => {
    const out = decodeBatch(FRAME);
    expect(out).toHaveLength(2);
    const [a, b] = out;
    expect(a.chain).toBe('robinhood');
    expect(a.contract).toMatchObject({ address: '0x7986e0720706e0ed054a110d68067c78c1f1c235', name: 'FYSH', slug: 'fyshverse', twitterUrl: 'https://x.com/fyshverse', projectUrl: 'https://fysh.xyz/', standard: 'erc721' });
    expect(a.quantity).toBe(5);
    expect(a.tokenIds).toEqual(['558', '559', '560', '561', '562']);
    expect(a.preview).toBe(true); // flags 2
    expect(a.priceConfirmed).toBe(false);
    expect(a.valueEth).toBe(0);
    expect(b.contract.name).toBe('Chump NFT');
    expect(b.priceConfirmed).toBe(true); // flags 19 = 1 | 2 | 16
    expect(b.preview).toBe(true);
    expect(b.unitPriceEth).toBe(0.005);
    expect(b.mintedSupply).toBe(120);
    expect(b.maxSupply).toBe(1000);
    expect(b.ts).toBe(1789242409000);
    expect(b.blockNumber).toBe(61364140);
  });
  it('maps chain codes and drops rows without id or contract', () => {
    expect(decodeBatch([1, 0, 4, [['0xabc', 'X']], [['id1', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0]]])[0].chain).toBe('ink');
    expect(decodeBatch([1, 0, 99, [['0xabc', 'X']], [['id1', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0]]])[0].chain).toBe('ethereum');
    expect(decodeBatch([1, 0, 1, [], [['id1', '0xt', 1, 2, 0, [], 1, '0xm']]])).toEqual([]);
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [['', '0xt', 1, 2, 0, [], 1, '0xm']]])).toEqual([]);
    expect(decodeBatch('garbage')).toEqual([]);
  });
  it('reads airdrop, third-party and surge flags', () => {
    const row = ['id', '0xt', 1, 2, 0, ['1'], 1, '0xm', '', '', '0', 4 | 8 | 128, 'mint', null, null, '', '', '', 0, 0, 0, 0, 7, 9, 3, 0, 0, 0, [], 1789000000000];
    const [e] = decodeBatch([1, 0, 1, [['0xabc', 'X']], [row]]);
    expect(e.airdrop).toBe(true);
    expect(e.thirdParty).toBe(true);
    expect(e.surge).toEqual({ mints: 7, events: 9, minters: 3, startedAt: 1789000000000 });
  });
  it('rejects malformed or too-short packets', () => {
    expect(decodeBatch([0, 1])).toEqual([]);
    expect(decodeBatch([2, 1, 1, 'ready', {}])).toEqual([]);
    expect(decodeBatch([1, 0, 1, null, null])).toEqual([]);
  });
  it('accepts a numeric row id', () => {
    const row = [12345, '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0];
    const [e] = decodeBatch([1, 0, 1, [['0xabc', 'X']], [row]]);
    expect(e.id).toBe('12345');
  });
  it('reads tokenIdsTotal only when the bit is set', () => {
    const base = ['id', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0'];
    const withFlag = [...base, 64, null, null, null, null, null, null, null, null, null, 900];
    const withoutFlag = [...base, 0, null, null, null, null, null, null, null, null, null, 900];
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [withFlag]])[0].tokenIdsTotal).toBe(900);
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [withoutFlag]])[0].tokenIdsTotal).toBeUndefined();
  });
  it('num() rejects junk numeric strings but keeps "0"', () => {
    const bad = ['id', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0x10', 0];
    const zero = ['id', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0];
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [bad]])[0].valueEth).toBeUndefined();
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [zero]])[0].valueEth).toBe(0);
  });
  it('openSeaUrl: index 12 overrides, else built from the slug (index 5 is unused)', () => {
    const row = ['id', '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0];
    const c1 = ['0xabc', 'X', '', '', 'fysh', 'https://opensea.io/collection/other'];
    const [a] = decodeBatch([1, 0, 1, [c1], [row]]);
    expect(a.contract.openSeaUrl).toBe('https://opensea.io/collection/fysh');
    const c2 = ['0xabc', 'X', '', '', 'fysh', 'https://opensea.io/collection/other', '', '', '', '', null, '', 'https://opensea.io/collection/override'];
    const [b] = decodeBatch([1, 0, 1, [c2], [row]]);
    expect(b.contract.openSeaUrl).toBe('https://opensea.io/collection/override');
  });
  it('caps tokenIds at 200 and rows at 500', () => {
    const manyIds = Array.from({ length: 300 }, (_, i) => String(i));
    const row = ['id', '0xt', 1, 2, 0, manyIds, 1, '0xm', '', '', '0', 0];
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], [row]])[0].tokenIds).toHaveLength(200);
    const rows = Array.from({ length: 600 }, (_, i) => [`id${i}`, '0xt', 1, 2, 0, [], 1, '0xm', '', '', '0', 0]);
    expect(decodeBatch([1, 0, 1, [['0xabc', 'X']], rows])).toHaveLength(500);
  });
});

describe('upsertMint', () => {
  const mk = (id: string, preview: boolean): MintEvent => ({ id, chain: 'ethereum', ts: 1, txHash: 't', blockNumber: 1, contract: { address: '0xa', name: 'A' }, quantity: 1, tokenIds: [], minter: '0xm', priceConfirmed: !preview, preview, airdrop: false, thirdParty: false });
  it('replaces a preview with its confirmed row and keeps newest first', () => {
    const list: MintEvent[] = [];
    upsertMint(list, mk('1', true), 300);
    upsertMint(list, mk('2', true), 300);
    upsertMint(list, mk('1', false), 300);
    expect(list.map((e) => e.id)).toEqual(['2', '1']);
    expect(list[1].preview).toBe(false);
  });
  it('caps the list', () => {
    const list: MintEvent[] = [];
    for (let i = 0; i < 5; i++) upsertMint(list, mk(String(i), false), 3);
    expect(list.map((e) => e.id)).toEqual(['4', '3', '2']);
  });
  it('merges a sparser confirmed row over its preview instead of replacing it', () => {
    const list: MintEvent[] = [];
    const preview: MintEvent = { ...mk('1', true), mintedSupply: 120, surge: { mints: 1, events: 1, minters: 1, startedAt: 1 } };
    upsertMint(list, preview, 300);
    const confirmed: MintEvent = { ...mk('1', false), mintedSupply: undefined, surge: undefined, preview: false };
    upsertMint(list, confirmed, 300);
    expect(list).toHaveLength(1);
    expect(list[0].preview).toBe(false);
    expect(list[0].mintedSupply).toBe(120);
    expect(list[0].surge).toEqual({ mints: 1, events: 1, minters: 1, startedAt: 1 });
  });
});
