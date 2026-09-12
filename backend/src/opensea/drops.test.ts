import { describe, it, expect } from 'vitest';
import { parseLocator, mintErrorSentence, resolveCollection, decodeCollection, eligibility, mintAction } from './drops.js';
import { OpenSeaError } from './gql.js';
import type { OpenSeaSession } from './session.js';

function fakeFetch(handler: (body: any) => any): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const data = handler(body);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

// Real-shaped (40 hex char) addresses for fixtures that now go through decodeCollection's shape checks.
const COL_ADDR = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
const DEAD_ADDR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const OTHER_ADDR = '0xbadbadbadbadbadbadbadbadbadbadbadbadbadb';

describe('drops', () => {
  it('parses slugs, OpenSea URLs and addresses', () => {
    expect(parseLocator('chump-nft-310989788')).toEqual({ slug: 'chump-nft-310989788' });
    expect(parseLocator('https://opensea.io/collection/r3ordr/overview')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('https://opensea.io/collection/r3ordr?tab=items')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('0x9D2A003322874163CBB18F7F538A1AAEA49B75D1')).toEqual({ address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1' });
    expect(parseLocator('0X9d2a003322874163cbb18f7f538a1aaea49b75d1')).toEqual({ address: '0x9d2a003322874163cbb18f7f538a1aaea49b75d1' });
    expect(parseLocator('opensea.io/collection/r3ordr')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('www.opensea.io/collection/r3ordr/overview')).toEqual({ slug: 'r3ordr' });
    expect(parseLocator('https://example.com/x')).toBeUndefined();
    expect(parseLocator('')).toBeUndefined();
  });

  it('turns OpenSea error typenames into sentences, bounding unusual typenames and their count', () => {
    expect(mintErrorSentence(['InsufficientFundError'])).toMatch(/can't cover/);
    expect(mintErrorSentence(['SomethingNewError'])).toMatch(/SomethingNewError/);
    expect(mintErrorSentence([])).toBeUndefined();
    expect(mintErrorSentence(['x'.repeat(500)])).toMatch(/UnknownError/);
    const many = Array.from({ length: 20 }, (_, i) => `Error${i}`);
    const sentence = mintErrorSentence(many)!;
    expect(sentence.split('; ')).toHaveLength(8);
  });

  it('resolveCollection(address) picks the hit matching address AND chain, ignoring the bogus slug===address entry', async () => {
    const addr = '0xabc000000000000000000000000000000000000c';
    let lastOp = '';
    const fetchImpl = fakeFetch((body) => {
      lastOp = body.operationName;
      if (body.operationName === 'MintCollectionSearch') {
        return {
          collectionsByQuery: [
            { __typename: 'Collection', slug: addr, address: addr, chain: { identifier: 'ethereum', networkId: 1 } }, // bogus: slug === address
            { __typename: 'Collection', slug: 'real-slug-poly', address: addr, chain: { identifier: 'matic', networkId: 137 } },
            { __typename: 'Collection', slug: 'real-slug-eth', address: addr, chain: { identifier: 'ethereum', networkId: 1 } },
          ],
        };
      }
      if (body.operationName === 'MintCollectionMetadata') {
        expect(body.variables.slug).toBe('real-slug-eth');
        return {
          collectionBySlug: {
            __typename: 'Collection',
            slug: 'real-slug-eth',
            name: 'Real Slug',
            imageUrl: 'https://img',
            address: addr,
            chain: { identifier: 'ethereum', networkId: 1 },
            drop: null,
          },
        };
      }
      throw new Error(`unexpected op ${body.operationName}`);
    });
    const col = await resolveCollection(addr, 'ethereum', fetchImpl);
    expect(col.slug).toBe('real-slug-eth');
    expect(col.chain).toBe('ethereum');
    expect(col.networkId).toBe(1);
    expect(lastOp).toBe('MintCollectionMetadata');
  });

  it('resolveCollection(address, chain) requires a hit on that chain and never falls back to another chain', async () => {
    const addr = '0xabc000000000000000000000000000000000000c';
    const fetchImpl = fakeFetch((body) => {
      if (body.operationName === 'MintCollectionSearch') {
        return { collectionsByQuery: [{ __typename: 'Collection', slug: 'only-on-matic', address: addr, chain: { identifier: 'matic', networkId: 137 } }] };
      }
      throw new Error(`unexpected op ${body.operationName}`);
    });
    await expect(resolveCollection(addr, 'ethereum', fetchImpl)).rejects.toMatchObject({ code: 'compat', message: expect.stringContaining('ethereum') });
  });

  it('resolveCollection(address) rejects a search hit whose slug is not a plain slug', async () => {
    const addr = '0xabc000000000000000000000000000000000000c';
    const fetchImpl = fakeFetch((body) => {
      if (body.operationName === 'MintCollectionSearch') {
        return { collectionsByQuery: [{ __typename: 'Collection', slug: '../not-a-slug', address: addr, chain: { identifier: 'ethereum', networkId: 1 } }] };
      }
      throw new Error(`unexpected op ${body.operationName}`);
    });
    await expect(resolveCollection(addr, undefined, fetchImpl)).rejects.toMatchObject({ code: 'compat', message: expect.stringContaining('unusable') });
  });

  it('resolveCollection(address) rejects when OpenSea resolves the slug to a different contract address', async () => {
    const addr = '0xabc000000000000000000000000000000000000c';
    const fetchImpl = fakeFetch((body) => {
      if (body.operationName === 'MintCollectionSearch') {
        return { collectionsByQuery: [{ __typename: 'Collection', slug: 'real-slug', address: addr, chain: { identifier: 'ethereum', networkId: 1 } }] };
      }
      if (body.operationName === 'MintCollectionMetadata') {
        return { collectionBySlug: { __typename: 'Collection', slug: 'real-slug', name: 'Real Slug', address: OTHER_ADDR, chain: { identifier: 'ethereum', networkId: 1 }, drop: null } };
      }
      throw new Error(`unexpected op ${body.operationName}`);
    });
    await expect(resolveCollection(addr, undefined, fetchImpl)).rejects.toMatchObject({ code: 'compat', message: expect.stringContaining('different contract') });
  });

  it('resolveCollection(slug) throws a compat error naming the slug when collectionBySlug is null', async () => {
    const fetchImpl = fakeFetch((body) => {
      expect(body.operationName).toBe('MintCollectionMetadata');
      return { collectionBySlug: null };
    });
    await expect(resolveCollection('nope', undefined, fetchImpl)).rejects.toMatchObject({
      code: 'compat',
      message: expect.stringContaining('nope'),
    });
    // also confirm it's the right error class
    try {
      await resolveCollection('nope', undefined, fetchImpl);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpenSeaError);
    }
  });

  it('resolveCollection(slug) throws when the drop lives at a different address than the collection', async () => {
    const fetchImpl = fakeFetch((body) => {
      expect(body.operationName).toBe('MintCollectionMetadata');
      return {
        collectionBySlug: {
          __typename: 'Collection',
          slug: 'chump',
          name: 'Chump',
          address: COL_ADDR,
          chain: { identifier: 'ethereum', networkId: 1 },
          drop: { __typename: 'Erc721SeaDropV1', identifier: { contractAddress: OTHER_ADDR, chain: { identifier: 'ethereum' } }, stages: [] },
        },
      };
    });
    await expect(resolveCollection('chump', undefined, fetchImpl)).rejects.toMatchObject({ code: 'compat' });
  });

  it('decodeCollection produces drop: undefined when there is no drop', () => {
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'no-drop',
      name: 'No Drop',
      imageUrl: null,
      address: DEAD_ADDR.toUpperCase(),
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: null,
    });
    expect(col?.drop).toBeUndefined();
    expect(col?.address).toBe(DEAD_ADDR);
  });

  it('decodeCollection rejects malformed addresses and non-positive networkId', () => {
    expect(decodeCollection({ __typename: 'Collection', slug: 'x', name: 'X', address: '0xabc', chain: { identifier: 'ethereum', networkId: 1 }, drop: null })).toBeUndefined();
    expect(decodeCollection({ __typename: 'Collection', slug: 'x', name: 'X', address: COL_ADDR, chain: { identifier: 'ethereum', networkId: 0 }, drop: null })).toBeUndefined();
    expect(decodeCollection({ __typename: 'Collection', slug: 'x', name: 'X', address: COL_ADDR, chain: { identifier: 'ethereum', networkId: 1.5 }, drop: null })).toBeUndefined();
  });

  it('decodeCollection stageIndex truncates a fractional value', () => {
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'chump',
      name: 'Chump',
      address: COL_ADDR,
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: { __typename: 'Erc721SeaDropV1', identifier: { contractAddress: COL_ADDR }, stages: [{ __typename: 'PublicStage', stageType: 'PUBLIC_SALE', stageIndex: 1.7 }] },
    });
    expect(col?.drop?.stages[0].index).toBe(1);
  });

  it('eligibility decodes stages (including eligibleMinter) from a fake session, carrying the lowercased wallet address', async () => {
    let seenVariables: any;
    const fakeSession = {
      address: '0x1111111111111111111111111111111111111111'.slice(0, 42),
      gql: async (_chainId: number, _slug: string, operationName: string, _query: string, variables: any) => {
        expect(operationName).toBe('DropEligibilityQuery');
        seenVariables = variables;
        return {
          dropBySlug: {
            __typename: 'Erc721SeaDropV1',
            minterQuantityMinted: 2,
            stages: [
              {
                __typename: 'PublicStage',
                stageType: 'PUBLIC_SALE',
                stageIndex: 0,
                isEligible: true,
                eligibleMinterAddress: '0x1111111111111111111111111111111111111111',
                maxTotalMintableByWallet: 5,
                eligibleMaxTotalMintableByWallet: 3,
                eligiblePrice: { usd: 10, token: { unit: 0.01, symbol: 'ETH', contractAddress: null, chain: { identifier: 'ethereum' } } },
              },
            ],
          },
        };
      },
    } as unknown as OpenSeaSession;
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'chump',
      name: 'Chump',
      address: COL_ADDR,
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: null,
    })!;
    const e = await eligibility(fakeSession, col);
    expect(e.minted).toBe(2);
    expect(e.stages).toHaveLength(1);
    expect(e.stages[0]).toMatchObject({ type: 'PUBLIC_SALE', index: 0, eligible: true, maxPerWallet: 5, eligibleMax: 3, eligibleMinter: '0x1111111111111111111111111111111111111111', priceUnit: 0.01, priceUsd: 10, priceSymbol: 'ETH' });
    expect(seenVariables.address).toBe('0x1111111111111111111111111111111111111111');
  });

  it('mintAction returns tx only when the whole timeline is one MintAction with exactly one transaction, plus error typenames', async () => {
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'chump',
      name: 'Chump',
      address: COL_ADDR,
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: { __typename: 'Erc721SeaDropV1', identifier: { contractAddress: COL_ADDR, chain: { identifier: 'ethereum' } }, stages: [] },
    })!;

    const oneTxSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [{ __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: '1000', chain: { networkId: 1, identifier: 'ethereum' } } }],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const r1 = await mintAction(oneTxSession, col, 1);
    expect(r1.tx).toEqual({ to: '0xdead', data: '0xbeef', value: '1000', networkId: 1, chain: 'ethereum' });
    expect(r1.errors).toEqual([]);

    const noFundsSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: { actions: [], errors: [{ __typename: 'InsufficientFundError' }] },
      }),
    } as unknown as OpenSeaSession;
    const r2 = await mintAction(noFundsSession, col, 1);
    expect(r2.tx).toBeUndefined();
    expect(r2.errors).toEqual(['InsufficientFundError']);

    const twoTxSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [
            { __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: '1000', chain: { networkId: 1, identifier: 'ethereum' } } },
            { __typename: 'ApproveAction', transactionSubmissionData: { to: '0xfeed', data: '0xaaaa', value: '0', chain: { networkId: 1, identifier: 'ethereum' } } },
          ],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const r3 = await mintAction(twoTxSession, col, 1);
    expect(r3.tx).toBeUndefined();
    expect(r3.actionTypes).toEqual(['MintAction', 'ApproveAction']);

    // A MintAction alongside an action with no tx of its own must not produce a tx either — the
    // whole timeline must be exactly the one expected MintAction.
    const mixedSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [
            { __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: '1000', chain: { networkId: 1, identifier: 'ethereum' } } },
            { __typename: 'OtherAction' },
          ],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const r4 = await mintAction(mixedSession, col, 1);
    expect(r4.tx).toBeUndefined();

    await expect(mintAction(oneTxSession, col, 0)).rejects.toMatchObject({ code: 'compat' });
    await expect(mintAction(oneTxSession, col, 1.5)).rejects.toMatchObject({ code: 'compat' });
    await expect(mintAction(oneTxSession, col, 10001)).rejects.toMatchObject({ code: 'compat' });
  });

  it('pins the swap variables: native fromAsset, drop toAsset, string quantity, null recipient', async () => {
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'chump',
      name: 'Chump',
      address: COL_ADDR,
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: { __typename: 'Erc721SeaDropV1', identifier: { contractAddress: COL_ADDR, chain: { identifier: 'ethereum' } }, stages: [] },
    })!;
    let v: any;
    const session = { address: '0x2222222222222222222222222222222222222222', gql: async (_c: number, _s: string, _op: string, _q: string, variables: any) => { v = variables; return { swap: { actions: [], errors: [] } }; } } as unknown as OpenSeaSession;
    await mintAction(session, col, 3);
    expect(v.recipient).toBeNull();
    expect(v.address).toBe('0x2222222222222222222222222222222222222222');
    expect(v.fromAssets).toEqual([{ asset: { contractAddress: '0x0000000000000000000000000000000000000000', chain: col.chain }, quantity: null }]);
    expect(v.toAssets).toEqual([{ asset: { contractAddress: col.drop!.address, chain: col.chain, tokenId: '0' }, quantity: '3' }]);
  });

  it('normalises hex tx.value, treats a missing value as a free mint, and rejects garbage', async () => {
    const col = decodeCollection({
      __typename: 'Collection',
      slug: 'chump',
      name: 'Chump',
      address: COL_ADDR,
      chain: { identifier: 'ethereum', networkId: 1 },
      drop: { __typename: 'Erc721SeaDropV1', identifier: { contractAddress: COL_ADDR, chain: { identifier: 'ethereum' } }, stages: [] },
    })!;
    const hexSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [{ __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: '0x3e8', chain: { networkId: 1, identifier: 'ethereum' } } }],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const r = await mintAction(hexSession, col, 1);
    expect(r.tx?.value).toBe('1000');

    const freeSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [{ __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: null, chain: { networkId: 1, identifier: 'ethereum' } } }],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const rFree = await mintAction(freeSession, col, 1);
    expect(rFree.tx?.value).toBe('0');

    const badSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [{ __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: 'not-a-number', chain: { networkId: 1, identifier: 'ethereum' } } }],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const rBad = await mintAction(badSession, col, 1);
    expect(rBad.tx).toBeUndefined();

    const tooLongSession = {
      address: '0x2222222222222222222222222222222222222222',
      gql: async () => ({
        swap: {
          actions: [{ __typename: 'MintAction', transactionSubmissionData: { to: '0xdead', data: '0xbeef', value: '1'.repeat(79), chain: { networkId: 1, identifier: 'ethereum' } } }],
          errors: [],
        },
      }),
    } as unknown as OpenSeaSession;
    const rTooLong = await mintAction(tooLongSession, col, 1);
    expect(rTooLong.tx).toBeUndefined();
  });
});
