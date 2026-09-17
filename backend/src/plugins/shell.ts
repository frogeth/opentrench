import { isLocalHost } from './hosts.js';

/** A proxied response as plugins see it. Bodies are text; binary sites are out of scope for v1. */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ProxyInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const BODY_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = [301, 302, 303, 307, 308];

/**
 * The desktop shell registers a local callback (`hello`) when it starts or attaches. Site-authenticated
 * fetches and sign-in windows go there, so cookies never leave the shell's session partitions. Without a
 * shell (a checkout running the backend on its own) fetches go out plain and sign-in is unavailable.
 */
export class ShellLink {
  private port: number | null = null;
  private token = '';

  constructor(private fetchImpl: typeof fetch = fetch) {}

  hello(port: number, token: string): void {
    this.port = port;
    this.token = token;
  }

  available(): boolean {
    return this.port !== null;
  }

  private async call(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`http://127.0.0.1:${this.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`shell unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`shell ${path} ${res.status}`);
    return await res.json();
  }

  /** Which of `sites` have a session in the shell right now. */
  async signedIn(sites: string[]): Promise<string[]> {
    if (!this.available() || sites.length === 0) return [];
    try {
      const answer = await this.call('/status', { sites });
      const listed: unknown[] = Array.isArray(answer?.signedIn) ? answer.signedIn : [];
      return sites.filter((site) => listed.includes(site));
    } catch {
      return []; // a shell that has gone away just means no sessions
    }
  }

  async signIn(site: string): Promise<void> {
    if (!this.available()) {
      throw new Error('signing in to a site needs the desktop app (the backend is running on its own)');
    }
    await this.call('/signin', { site });
  }

  /**
   * `viaShell`: the host is one of the plugin's sites and the shell is there → the shell fetches with that
   * site's cookies. Plain fetches follow redirects by hand (max 5) and refuse any hop to a local address;
   * bodies are capped at BODY_MAX.
   */
  async fetch(url: string, init: ProxyInit, viaShell: boolean): Promise<ProxyResponse> {
    if (viaShell && this.available()) {
      const r = await this.call('/fetch', { url, init });
      return { status: Number(r.status), headers: r.headers ?? {}, body: String(r.body ?? '').slice(0, BODY_MAX) };
    }
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(current);
      if (isLocalHost(u.hostname)) throw new Error('fetch must not point at a local address');
      const res = await this.fetchImpl(current, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      if (REDIRECT_STATUS.includes(res.status) && location) {
        if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
        current = new URL(location, current).toString();
        // 303, and 301/302 on POST, become GET without a body
        const method = (init.method ?? 'GET').toUpperCase();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          init = { ...init, method: 'GET', body: undefined };
        }
        continue;
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > BODY_MAX) throw new Error('response body too large');
      const body = (await res.text()).slice(0, BODY_MAX);
      return { status: res.status, headers, body };
    }
    throw new Error('too many redirects');
  }
}
