import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { buildSiweMessage, checkVerifyResponse, collectionUrl, SIWE_STATEMENT, OpenSeaSession } from './session.js';
import { GQL_URL } from './gql.js';

describe('siwe', () => {
  it('builds the exact text osnm-z signs', () => {
    const m = buildSiweMessage({ address: '0x7e6f846Efd40558042633c487ea6d9D67fA84178', uri: 'https://opensea.io/collection/x/overview', chainId: 4663, nonce: 'abcDEF123456', issuedAt: '2026-09-12T19:50:00.000Z' });
    expect(m).toBe(`opensea.io wants you to sign in with your Ethereum account:\n0x7e6f846Efd40558042633c487ea6d9D67fA84178\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io/collection/x/overview\nVersion: 1\nChain ID: 4663\nNonce: abcDEF123456\nIssued At: 2026-09-12T19:50:00.000Z`);
  });
  it('accepts a verify response for the same wallet only', () => {
    const body = { user: { address: '0x7e6f846efd40558042633c487ea6d9d67fa84178' } };
    expect(() => checkVerifyResponse(body, '0x7e6f846Efd40558042633c487ea6d9D67fA84178')).not.toThrow();
    expect(() => checkVerifyResponse(body, '0x0000000000000000000000000000000000000001')).toThrow(/different wallet/);
    expect(() => checkVerifyResponse({}, '0x7e6f846Efd40558042633c487ea6d9D67fA84178')).toThrow();
  });
});

describe('collectionUrl', () => {
  it('accepts a plain slug', () => {
    expect(collectionUrl('chump-nft-310989788')).toBe('https://opensea.io/collection/chump-nft-310989788/overview');
  });
  it('rejects anything that is not a plain token', () => {
    for (const bad of ['a\nb', '../etc', '', 'x'.repeat(201)]) {
      expect(() => collectionUrl(bad)).toThrow(/bad collection slug/);
    }
  });
});

describe('OpenSeaSession', () => {
  /** `verifyCookies[n]` is the access_token set-cookie value used on the (n+1)th successful
   * verify call (clamped to the last entry); `null` means the verify response sets no cookie. */
  function makeFake(addr: string, opts: { verifyCookies?: (string | null)[] } = {}) {
    const lower = addr.toLowerCase();
    const verifyCookies = opts.verifyCookies ?? ['tok'];
    let nonceCalls = 0;
    let verifyCalls = 0;
    let gqlCalls = 0;
    let failGqlOnce = false;
    let failNonceOnce = false;
    const gqlCookiesSeen: string[] = [];

    const fetchImpl = (async (url: any, init: any = {}) => {
      const u = String(url);
      const headers: Record<string, string> = {};
      const h = init.headers ?? {};
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
      const body = init.body ? JSON.parse(init.body) : undefined;

      if (u.endsWith('/__api/auth/siwe/nonce')) {
        nonceCalls++;
        if (failNonceOnce) {
          failNonceOnce = false;
          return new Response('', { status: 500 });
        }
        return new Response(JSON.stringify({ nonce: 'abcDEF123456' }), { status: 200, headers: [['content-type', 'application/json']] });
      }
      if (u.endsWith('/__api/auth/siwe/verify')) {
        expect(body.message.address).toBe(addr);
        expect(body.message.nonce).toBe('abcDEF123456');
        expect(body.chainArch).toBe('EVM');
        expect(body.signature).toMatch(/^0x[0-9a-fA-F]+$/);
        expect(headers.cookie).toContain(`connected-account-server-hint=${lower}`);
        const tok = verifyCookies[Math.min(verifyCalls, verifyCookies.length - 1)];
        verifyCalls++;
        const setCookie: [string, string][] = tok === null ? [] : [['set-cookie', `access_token=${tok}; Path=/`]];
        return new Response(JSON.stringify({ user: { address: lower } }), { status: 200, headers: [...setCookie, ['content-type', 'application/json']] });
      }
      if (u === GQL_URL) {
        gqlCalls++;
        gqlCookiesSeen.push(headers.cookie ?? '');
        if (failGqlOnce) {
          failGqlOnce = false;
          return new Response(JSON.stringify({}), { status: 401, headers: [['content-type', 'application/json']] });
        }
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: [['content-type', 'application/json']] });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    return {
      fetchImpl,
      get nonceCalls() { return nonceCalls; },
      get gqlCalls() { return gqlCalls; },
      get gqlCookiesSeen() { return gqlCookiesSeen; },
      failNextGql() { failGqlOnce = true; },
      failNextNonce() { failNonceOnce = true; },
    };
  }

  it('signs in once, reuses the session, and re-signs on a 401', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fake = makeFake(account.address);
    const session = new OpenSeaSession(account, fake.fetchImpl);

    const r1 = await session.gql<{ ok: boolean }>(4663, 'chump-nft-310989788', 'Op', 'query Op { ok }', {});
    expect(r1).toEqual({ ok: true });
    expect(fake.nonceCalls).toBe(1);

    const r2 = await session.gql<{ ok: boolean }>(4663, 'chump-nft-310989788', 'Op', 'query Op { ok }', {});
    expect(r2).toEqual({ ok: true });
    expect(fake.nonceCalls).toBe(1);

    fake.failNextGql();
    const r3 = await session.gql<{ ok: boolean }>(4663, 'chump-nft-310989788', 'Op', 'query Op { ok }', {});
    expect(r3).toEqual({ ok: true });
    expect(fake.nonceCalls).toBe(2);
  });

  it('shares one in-flight sign-in across concurrent callers', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fake = makeFake(account.address);
    const session = new OpenSeaSession(account, fake.fetchImpl);

    const [r1, r2, r3] = await Promise.all([
      session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {}),
      session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {}),
      session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {}),
    ]);
    expect([r1, r2, r3]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(fake.nonceCalls).toBe(1);
  });

  it('clears the in-flight sign-in promise after a failure, so the next call retries', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fake = makeFake(account.address);
    fake.failNextNonce();
    const session = new OpenSeaSession(account, fake.fetchImpl);

    await expect(session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {})).rejects.toThrow(/nonce failed/);
    expect(fake.nonceCalls).toBe(1);

    const r = await session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {});
    expect(r).toEqual({ ok: true });
    expect(fake.nonceCalls).toBe(2);
  });

  it('re-signs on a 401 and carries the fresh cookie on the retried request', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fake = makeFake(account.address, { verifyCookies: ['tok1', 'tok2'] });
    const session = new OpenSeaSession(account, fake.fetchImpl);

    await session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {});
    expect(fake.gqlCookiesSeen[0]).toContain('access_token=tok1');

    fake.failNextGql();
    await session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {});
    expect(fake.gqlCookiesSeen.at(-1)).toContain('access_token=tok2');
    expect(fake.nonceCalls).toBe(2);
  });

  it('requires a session cookie from the verify response', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fake = makeFake(account.address, { verifyCookies: [null] });
    const session = new OpenSeaSession(account, fake.fetchImpl);

    await expect(session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {})).rejects.toThrow(/no session cookie/);
  });

  it('wraps a rejected fetch during sign-in as a transport OpenSeaError', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const session = new OpenSeaSession(account, fetchImpl);

    await expect(session.gql<{ ok: boolean }>(4663, 'slug-a', 'Op', 'query Op { ok }', {})).rejects.toMatchObject({ code: 'transport' });
  });
});
