import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { buildSiweMessage, checkVerifyResponse, SIWE_STATEMENT, OpenSeaSession } from './session.js';
import { OPENSEA, GQL_URL } from './gql.js';

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

describe('OpenSeaSession', () => {
  function makeFake(addr: string) {
    const lower = addr.toLowerCase();
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    let nonceCalls = 0;
    let gqlCalls = 0;
    let failGqlOnce = false;

    const fetchImpl = (async (url: any, init: any = {}) => {
      const u = String(url);
      const headers: Record<string, string> = {};
      const h = init.headers ?? {};
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, body, headers });

      if (u.endsWith('/__api/auth/siwe/nonce')) {
        nonceCalls++;
        return new Response(JSON.stringify({ nonce: 'abcDEF123456' }), { status: 200, headers: [['content-type', 'application/json']] });
      }
      if (u.endsWith('/__api/auth/siwe/verify')) {
        expect(body.message.address).toBe(addr);
        expect(body.message.nonce).toBe('abcDEF123456');
        expect(body.chainArch).toBe('EVM');
        expect(body.signature).toMatch(/^0x[0-9a-fA-F]+$/);
        expect(headers.cookie).toContain(`connected-account-server-hint=${lower}`);
        return new Response(JSON.stringify({ user: { address: lower } }), {
          status: 200,
          headers: [
            ['set-cookie', 'access_token=tok; Path=/'],
            ['content-type', 'application/json'],
          ],
        });
      }
      if (u === GQL_URL) {
        gqlCalls++;
        expect(headers.cookie).toContain('access_token=tok');
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
      calls,
      get nonceCalls() { return nonceCalls; },
      get gqlCalls() { return gqlCalls; },
      failNextGql() { failGqlOnce = true; },
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
});
