import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { MintChain, MintEvent } from './types.js';

/**
 * MintGo (mintgo.fun): live NFT mints on Ethereum, Robinhood Chain and Ink, read the way its
 * own page reads them: a browser-session cookie, then the realtime socket. Unofficial, so
 * every field access is defensive. Read-only.
 */
export const MINTGO = 'https://mintgo.fun';
const MAX = 300;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
/** MintGo checks these to decide a request came from its own page. */
export const SAME_ORIGIN_HEADERS: Record<string, string> = {
  'user-agent': UA,
  origin: MINTGO,
  referer: `${MINTGO}/`,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  accept: '*/*',
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const NUM_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    return s && NUM_RE.test(s) ? Number(s) : undefined;
  }
  return undefined;
};

export function chainFromCode(code: unknown): MintChain {
  const n = Number(code);
  return n === 2 ? 'robinhood' : n === 3 ? 'stable' : n === 4 ? 'ink' : n === 5 ? 'arc' : 'ethereum';
}

/** `[1, cursor, chainCode, contracts[], rows[]]` → events. Mirrors MintGo's expandCompactRealtimeBatch. */
export function decodeBatch(packet: unknown): MintEvent[] {
  if (!Array.isArray(packet) || Number(packet[0]) !== 1) return [];
  const chain = chainFromCode(packet[2]);
  const contracts: unknown[][] = Array.isArray(packet[3]) ? packet[3] : [];
  const rows: unknown[][] = Array.isArray(packet[4]) ? packet[4] : [];
  const out: MintEvent[] = [];
  for (const row of rows.slice(0, 500)) {
    if (!Array.isArray(row)) continue;
    const c = contracts[Number(row[4] ?? 0)];
    const id = str(row[0]) ?? (typeof row[0] === 'number' && Number.isFinite(row[0]) ? String(row[0]) : undefined);
    const address = str(c?.[0])?.toLowerCase();
    if (!id || !address || !Array.isArray(c)) continue;
    const flags = Number(row[11] ?? 0) || 0;
    const tokenIds = Array.isArray(row[5])
      ? row[5]
          .filter((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
          .map(String)
          .slice(0, 200)
      : [];
    const slug = str(c[4]);
    const deployer = str(c[8]);
    const surge = !!(flags & 128);
    out.push({
      id,
      chain,
      ts: Math.max(0, num(row[3]) ?? Date.now()),
      txHash: str(row[1]) ?? '',
      blockNumber: Math.max(0, num(row[2]) ?? 0),
      contract: {
        address,
        name: str(c[1]) ?? address.slice(0, 10),
        symbol: str(c[2]),
        image: str(c[3]),
        slug,
        // MintGo's own decoder: index 12 overrides, else the slug; index 5 is the collection's external URL (unused here)
        openSeaUrl: str(c[12]) ?? (slug ? `https://opensea.io/collection/${slug}` : undefined),
        projectUrl: str(c[6]),
        twitterUrl: str(c[7]),
        standard: str(c[11]),
        deployer: deployer ? { address: deployer, createdAgo: str(c[9]), projects: num(c[10]) } : undefined,
      },
      quantity: Math.max(num(row[6]) ?? 0, tokenIds.length, 1),
      tokenIds,
      tokenIdsTotal: flags & 64 ? num(row[21]) : undefined,
      minter: str(row[7]) ?? '',
      valueEth: num(row[10]),
      unitPriceEth: num(row[15]),
      priceConfirmed: !!(flags & 1),
      preview: !!(flags & 2),
      airdrop: !!(flags & 4),
      thirdParty: !!(flags & 8),
      functionName: str(row[12]),
      mintedSupply: num(row[13]),
      maxSupply: num(row[14]),
      surge: surge ? { mints: num(row[22]) ?? 0, events: num(row[23]) ?? 0, minters: num(row[24]) ?? 0, startedAt: num(row[29]) ?? 0 } : undefined,
    });
  }
  return out;
}

/** Shallow-copies `obj`, keeping only its own keys whose value is not `undefined`. */
function definedFieldsOf<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * Merge by id (MintGo re-sends a mint id as preview → confirmed, and a sparser later row must
 * not erase what the preview carried), else newest first; capped.
 */
export function upsertMint(list: MintEvent[], e: MintEvent, max = MAX): void {
  const i = list.findIndex((x) => x.id === e.id);
  if (i >= 0) {
    const prev = list[i];
    const merged: MintEvent = { ...prev, ...definedFieldsOf(e) };
    merged.contract = { ...prev.contract, ...definedFieldsOf(e.contract) };
    list[i] = merged;
    return;
  }
  list.unshift(e);
  if (list.length > max) list.length = max;
}

export type MintGoState = NonNullable<import('./types.js').Status['mintgo']>;

export class MintGoClient extends EventEmitter {
  state: MintGoState = 'disconnected';
  readonly recent: MintEvent[] = [];
  private cookie = '';
  private renewAt = 0;
  private cursor = '';
  private socket?: WebSocket;
  private attempts = 0;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private readonly clientId = Math.random().toString(36).slice(2, 12);

  constructor(private fetchImpl: typeof fetch = fetch) {
    super();
  }

  /** A browser session cookie; MintGo hands one to any request that looks same-origin. */
  async session(force = false): Promise<string> {
    if (!force && this.cookie && Date.now() < this.renewAt) return this.cookie;
    const r = await this.fetchImpl(`${MINTGO}/api/session`, { method: 'POST', headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`MintGo session refused (${r.status})`);
    const j: any = await r.json().catch(() => ({}));
    const cookies = (r.headers as any).getSetCookie?.() as string[] | undefined;
    const jar = (cookies ?? []).map((c) => c.split(';')[0]).filter((c) => /^mg_/.test(c));
    if (!j.ok || jar.length === 0) throw new Error('MintGo session response had no cookie');
    this.cookie = jar.join('; ');
    this.renewAt = Number(j.renewAfter) > Date.now() ? Number(j.renewAfter) : Date.now() + 20 * 60_000;
    return this.cookie;
  }

  /** GET one of MintGo's JSON endpoints with the session (used by the mint window later). */
  async get<T>(path: string): Promise<T> {
    const go = async () => this.fetchImpl(`${MINTGO}${path}`, { headers: { ...SAME_ORIGIN_HEADERS, cookie: await this.session() } });
    let r = await go();
    if (r.status === 401) {
      await this.session(true);
      r = await go();
    }
    if (!r.ok) throw new Error(`MintGo ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close(1000, 'stopped');
    this.socket = undefined;
    this.setState('disconnected');
  }

  private setState(s: MintGoState, err?: string) {
    if (this.state === s && !err) return;
    this.state = s;
    this.emit('state', s, err);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    let cookie: string;
    try {
      cookie = await this.session(this.attempts > 0);
    } catch (e: any) {
      this.setState('error', e?.message ?? String(e));
      return this.retry();
    }
    const url = new URL(`${MINTGO.replace('https', 'wss')}/api/realtime`);
    url.searchParams.set('scope', 'all');
    url.searchParams.set('client', this.clientId);
    if (/^\d+$/.test(this.cursor)) url.searchParams.set('since', this.cursor);
    const ws = new WebSocket(url, { headers: { ...SAME_ORIGIN_HEADERS, cookie } });
    this.socket = ws;
    ws.on('open', () => {
      this.attempts = 0;
    });
    ws.on('message', (data) => {
      let packet: unknown;
      try {
        const buf =
          data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.isBuffer(data) || Array.isArray(data)
              ? Buffer.concat(Array.isArray(data) ? data : [data])
              : Buffer.from(String(data));
        packet = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (!Array.isArray(packet)) return;
      const type = Number(packet[0]);
      if (type === 0) return;
      const cursor = String(packet[1] ?? '');
      if (/^\d+$/.test(cursor)) this.cursor = cursor;
      if (type === 1) {
        for (const e of decodeBatch(packet)) {
          upsertMint(this.recent, e);
          this.emit('mint', e);
        }
      } else if (type === 2) {
        const name = String(packet[3] ?? '');
        if (name === 'ready') this.setState('connected');
      }
    });
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      if (this.stopped) return;
      this.setState('error', `socket closed (${code}${reason?.length ? ` ${reason.toString()}` : ''})`);
      this.retry();
    });
    ws.on('error', (e) => {
      console.warn('[mintgo] socket error', e?.message ?? e);
    });
  }

  private retry() {
    if (this.stopped) return;
    this.attempts++;
    const delay = Math.min(5000, 250 * 2 ** Math.min(5, this.attempts - 1));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref();
  }
}
