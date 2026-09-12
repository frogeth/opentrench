import { describe, it, expect } from 'vitest';
import { gql, OpenSeaError } from './gql.js';

const fakeFetch = (ok: boolean, status: number, body: unknown, captured?: { init?: RequestInit }) =>
  (async (url: string, init?: RequestInit) => {
    if (captured) captured.init = init;
    return {
      ok,
      status,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;

describe('gql', () => {
  it('maps 401 to auth_required', async () => {
    await expect(gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(false, 401, {}) })).rejects.toMatchObject({
      code: 'auth_required',
    });
  });

  it('maps 429 to rate_limited', async () => {
    await expect(gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(false, 429, {}) })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps 500 to http with status', async () => {
    await expect(gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(false, 500, {}) })).rejects.toMatchObject({
      code: 'http',
      status: 500,
    });
  });

  it('maps a GraphQL errors array to graphql with the message', async () => {
    const body = { errors: [{ message: 'boom', extensions: { code: 'BAD_USER_INPUT' } }] };
    await expect(gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(true, 200, body) })).rejects.toMatchObject({
      code: 'graphql',
      message: 'boom',
    });
  });

  it('maps a null data body to compat', async () => {
    await expect(gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(true, 200, { data: null }) })).rejects.toMatchObject({
      code: 'compat',
    });
  });

  it('returns data on success', async () => {
    const data = await gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(true, 200, { data: { x: 1 } }) });
    expect(data).toEqual({ x: 1 });
  });

  it('sends x-app-id, origin, and the given cookie/referer', async () => {
    const captured: { init?: RequestInit } = {};
    await gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(true, 200, { data: {} }, captured), cookie: 'session=abc', referer: 'https://opensea.io/collections' });
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['x-app-id']).toBe('os2-web');
    expect(headers.origin).toBe('https://opensea.io');
    expect(headers.cookie).toBe('session=abc');
    expect(headers.referer).toBe('https://opensea.io/collections');
  });

  it('throws OpenSeaError instances', async () => {
    try {
      await gql('Q', 'query Q {x}', {}, { fetchImpl: fakeFetch(false, 401, {}) });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpenSeaError);
    }
  });
});
