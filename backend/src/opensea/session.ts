import type { PrivateKeyAccount } from 'viem';
import { gql, OPENSEA, OpenSeaError, UA, type GqlOptions } from './gql.js';

export const SIWE_STATEMENT = 'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';

export function buildSiweMessage(p: { address: string; uri: string; chainId: number; nonce: string; issuedAt: string }): string {
  return `opensea.io wants you to sign in with your Ethereum account:\n${p.address}\n\n${SIWE_STATEMENT}\n\nURI: ${p.uri}\nVersion: 1\nChain ID: ${p.chainId}\nNonce: ${p.nonce}\nIssued At: ${p.issuedAt}`;
}

export function checkVerifyResponse(body: any, wallet: string): void {
  const got = String(body?.user?.address ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(got)) throw new OpenSeaError('compat', 'OpenSea sign-in response had no wallet');
  if (got !== wallet.toLowerCase()) throw new OpenSeaError('compat', 'OpenSea signed in a different wallet');
}

export const collectionUrl = (slug: string) => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(slug)) throw new OpenSeaError('compat', 'bad collection slug');
  return `${OPENSEA}/collection/${slug}/overview`;
};

/** A signed-in opensea.io session for one wallet: SIWE once, cookies kept in memory, re-signs on 401. */
export class OpenSeaSession {
  private jar = new Map<string, string>();
  private signedIn = false;
  private signInPromise: Promise<void> | null = null;
  constructor(private account: PrivateKeyAccount, private fetchImpl: typeof fetch = fetch) {}

  get address() {
    return this.account.address;
  }
  private cookie() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private take(res: Response) {
    for (const c of (res.headers as any).getSetCookie?.() ?? []) {
      const kv = String(c).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  private async post(url: string, body: unknown, referer: string) {
    const r = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: OPENSEA, referer, 'user-agent': UA, cookie: this.cookie() }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    this.take(r);
    return r;
  }

  /** Serialised: concurrent callers share the one in-flight sign-in instead of each signing in. */
  async signIn(chainId: number, slug: string): Promise<void> {
    if (this.signInPromise) return this.signInPromise;
    const p = this.doSignIn(chainId, slug);
    this.signInPromise = p;
    try {
      await p;
    } finally {
      this.signInPromise = null;
    }
  }

  private async doSignIn(chainId: number, slug: string): Promise<void> {
    this.signedIn = false;
    this.jar.clear();
    this.jar.set('connected-account-server-hint', this.account.address.toLowerCase());
    const uri = collectionUrl(slug);
    const nr = await this.post(`${OPENSEA}/__api/auth/siwe/nonce`, {}, uri);
    if (!nr.ok) throw new OpenSeaError('http', `OpenSea nonce failed (${nr.status})`, nr.status);
    const nonce = String(((await nr.json().catch(() => ({}))) as any).nonce ?? '');
    if (!/^[A-Za-z0-9]{8,256}$/.test(nonce)) throw new OpenSeaError('compat', 'OpenSea nonce looked wrong');
    const issuedAt = new Date().toISOString();
    const message = buildSiweMessage({ address: this.account.address, uri, chainId, nonce, issuedAt });
    const signature = await this.account.signMessage({ message });
    const vr = await this.post(`${OPENSEA}/__api/auth/siwe/verify`, { message: { domain: 'opensea.io', address: this.account.address, statement: SIWE_STATEMENT, uri, version: '1', chainId: String(chainId), nonce, issuedAt, accountType: 'Ethereum' }, signature, chainArch: 'EVM' }, uri);
    if (!vr.ok) throw new OpenSeaError('http', `OpenSea sign-in failed (${vr.status})`, vr.status);
    checkVerifyResponse(await vr.json().catch(() => ({})), this.account.address);
    this.signedIn = true;
  }

  /** gql with the session; signs in first when needed and once more on a 401. */
  async gql<T>(chainId: number, slug: string, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.signedIn) await this.signIn(chainId, slug);
    const opts: GqlOptions = { referer: collectionUrl(slug), cookie: this.cookie(), fetchImpl: this.fetchImpl };
    try {
      return await gql<T>(operationName, query, variables, opts);
    } catch (e) {
      if (!(e instanceof OpenSeaError) || e.code !== 'auth_required') throw e;
      await this.signIn(chainId, slug);
      return gql<T>(operationName, query, variables, { ...opts, cookie: this.cookie() });
    }
  }
}
