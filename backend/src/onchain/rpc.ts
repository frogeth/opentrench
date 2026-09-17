/**
 * Thin JSON-RPC clients: one batch request per chain per tick, no library. Every call is a plain
 * `fetch` so tests hand in their own. Errors come back per item (an undefined result) so one bad
 * pool never spoils the batch.
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EvmCall {
  to: string;
  data: string;
}

const CHUNK = 40;
const TIMEOUT_MS = 8000;
/** batch sizes public RPCs told us they allow ("maximum 10 calls in 1 batch"), by url */
const chunkFor = new Map<string, number>();

async function post(fetchImpl: FetchLike, url: string, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  return res.json();
}

export interface EvmResult {
  result?: string;
  /** the node's error message for this call (a revert, or a per-call rate limit) */
  error?: string;
}
const errText = (e: unknown): string => (typeof e === 'string' ? e : typeof (e as any)?.message === 'string' ? (e as any).message : JSON.stringify(e ?? 'error')).slice(0, 200);

/** One batched eth_call round; results align with `calls`. A batch-level error throws, so the caller sees the node is refusing us. */
export async function evmCallsDetailed(url: string, calls: EvmCall[], fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<EvmResult[]> {
  const out: EvmResult[] = calls.map(() => ({}));
  let start = 0;
  while (start < calls.length) {
    const chunk = chunkFor.get(url) ?? CHUNK;
    const slice = calls.slice(start, start + chunk);
    const body = slice.map((c, i) => ({ jsonrpc: '2.0', id: start + i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }));
    const json = await post(fetchImpl, url, body);
    if (!Array.isArray(json)) {
      // a single object back for a batch is the node refusing the batch as a whole
      const msg = errText((json as any)?.error ?? json);
      const max = /maximum (\d+) calls/i.exec(msg);
      if (max && Number(max[1]) > 0 && Number(max[1]) < chunk) {
        chunkFor.set(url, Number(max[1]));
        continue; // same slice again, smaller
      }
      throw new Error(msg);
    }
    for (const item of json as any[]) {
      const id = Number(item?.id);
      if (!Number.isInteger(id) || id < start || id >= start + slice.length) continue;
      const r = item?.result;
      if (typeof r === 'string' && /^0x[0-9a-fA-F]*$/.test(r) && r.length > 2) out[id] = { result: r };
      else out[id] = { error: item?.error !== undefined ? errText(item.error) : 'empty result' };
    }
    start += slice.length;
  }
  return out;
}

/** evmCallsDetailed without the errors: undefined where the node returned one. */
export async function evmCalls(url: string, calls: EvmCall[], fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<(string | undefined)[]> {
  return (await evmCallsDetailed(url, calls, fetchImpl)).map((r) => r.result);
}

/** a node error that says the call itself is wrong (rather than the node being busy) */
export const isRevert = (error: string | undefined): boolean => !!error && /revert|invalid opcode|out of gas|execution|empty result/i.test(error);

/** eth_chainId as a number, or undefined when the endpoint does not answer like an EVM node. */
export async function evmChainId(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number | undefined> {
  try {
    const json: any = await post(fetchImpl, url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    const hex = json?.result;
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return undefined;
    return Number(BigInt(hex));
  } catch {
    return undefined;
  }
}

/** Solana getMultipleAccounts (base64); results align with `pubkeys`, undefined for missing accounts. */
export async function solanaAccounts(url: string, pubkeys: string[], fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<(Uint8Array | undefined)[]> {
  const out: (Uint8Array | undefined)[] = new Array(pubkeys.length).fill(undefined);
  const SOL_CHUNK = 100;
  for (let start = 0; start < pubkeys.length; start += SOL_CHUNK) {
    const slice = pubkeys.slice(start, start + SOL_CHUNK);
    const json: any = await post(fetchImpl, url, { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [slice, { encoding: 'base64', commitment: 'processed' }] });
    const values: any[] = Array.isArray(json?.result?.value) ? json.result.value : [];
    values.forEach((v, i) => {
      const b64 = v?.data?.[0];
      if (typeof b64 === 'string') out[start + i] = new Uint8Array(Buffer.from(b64, 'base64'));
    });
  }
  return out;
}

/** Solana getHealth / getVersion: true when the endpoint is a Solana node. */
export async function solanaAlive(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  try {
    const json: any = await post(fetchImpl, url, { jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] });
    return typeof json?.result?.['solana-core'] === 'string';
  } catch {
    return false;
  }
}
