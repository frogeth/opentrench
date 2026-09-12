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
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

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
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const c = contracts[Number(row[4] ?? 0)];
    const id = str(row[0]);
    const address = str(c?.[0])?.toLowerCase();
    if (!id || !address || !Array.isArray(c)) continue;
    const flags = Number(row[11] ?? 0) || 0;
    const tokenIds = Array.isArray(row[5]) ? row[5].filter((v) => v !== null && v !== undefined && v !== '').map(String) : [];
    const slug = str(c[4]);
    const deployer = str(c[8]);
    const surge = !!(flags & 128);
    out.push({
      id,
      chain,
      ts: num(row[3]) ?? Date.now(),
      txHash: str(row[1]) ?? '',
      blockNumber: num(row[2]) ?? 0,
      contract: {
        address,
        name: str(c[1]) ?? address.slice(0, 10),
        symbol: str(c[2]),
        image: str(c[3]),
        slug,
        openSeaUrl: str(c[12]) ?? (slug ? `https://opensea.io/collection/${slug}` : undefined),
        projectUrl: str(c[6]),
        twitterUrl: str(c[7]),
        standard: str(c[11]),
        deployer: deployer ? { address: deployer, createdAgo: str(c[9]), projects: num(c[10]) } : undefined,
      },
      quantity: num(row[6]) ?? (tokenIds.length || 1),
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

/** Replace by id (a preview row becomes its confirmed row in place), else newest first; capped. */
export function upsertMint(list: MintEvent[], e: MintEvent, max = MAX): 'new' | 'update' {
  const i = list.findIndex((x) => x.id === e.id);
  if (i >= 0) {
    list[i] = e;
    return 'update';
  }
  list.unshift(e);
  if (list.length > max) list.length = max;
  return 'new';
}
