/**
 * OpenSea's private web GraphQL (the one opensea.io itself uses), the way osnm-z talks to it:
 * `x-app-id: os2-web`, browser-like origin/referer, optional session cookie. Unofficial.
 */
export const OPENSEA = 'https://opensea.io';
export const GQL_URL = 'https://gql.opensea.io/graphql';
export const APP_ID = 'os2-web';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const BODY_LIMIT = 2 * 1024 * 1024;

export type OpenSeaErrorCode = 'rate_limited' | 'auth_required' | 'http' | 'graphql' | 'compat' | 'transport';
export class OpenSeaError extends Error {
  constructor(public code: OpenSeaErrorCode, message: string, public status?: number) {
    super(message);
  }
}

export interface GqlOptions {
  referer?: string;
  cookie?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function gql<T>(operationName: string, query: string, variables: Record<string, unknown>, opts: GqlOptions = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-app-id': APP_ID, origin: OPENSEA, referer: opts.referer ?? `${OPENSEA}/`, 'user-agent': UA, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (e: any) {
    throw new OpenSeaError('transport', e?.message ?? 'network error');
  }
  if (res.status === 401) throw new OpenSeaError('auth_required', 'OpenSea wants a signed-in wallet', 401);
  if (res.status === 429) throw new OpenSeaError('rate_limited', 'OpenSea rate limited the request', 429);
  if (!res.ok) throw new OpenSeaError('http', `OpenSea returned ${res.status}`, res.status);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > BODY_LIMIT) throw new OpenSeaError('compat', 'OpenSea response too large');
  let j: any;
  try {
    j = await res.json();
  } catch {
    throw new OpenSeaError('compat', 'OpenSea response was not JSON');
  }
  const authErr = j?.extensions?.auth?.error?.message;
  if (Array.isArray(j?.errors) && j.errors.length) {
    const first = j.errors[0];
    const code = String(first?.extensions?.code ?? '');
    if (/UNAUTHENTICATED|AUTH/.test(code)) throw new OpenSeaError('auth_required', String(first?.message ?? 'not signed in'));
    throw new OpenSeaError('graphql', String(first?.message ?? 'GraphQL error'));
  }
  if (authErr) throw new OpenSeaError('auth_required', String(authErr));
  if (!j || j.data === undefined || j.data === null) throw new OpenSeaError('compat', 'OpenSea response had no data');
  return j.data as T;
}
