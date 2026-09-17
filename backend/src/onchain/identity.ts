import { CHAINS } from './chains.js';
import type { Endpoints } from './endpoints.js';
import { findProgramAddress, utf8 } from './pda.js';
import { SEL, decodeString, words } from './pools.js';
import { evmCallsDetailed, solanaAccounts, type FetchLike } from './rpc.js';
import { mintDecimals } from './solana.js';

/**
 * Who a contract is, from the chain itself, the moment it lands in chat: name, ticker, decimals
 * and supply from the token contract (EVM: asked of every chain at once; the chains whose
 * `decimals()` answers hold it) or the mint plus its Metaplex metadata (Solana). One round trip,
 * no indexer, so a launch that no chart site knows yet still gets its ticker.
 */
export interface Identity {
  network: string;
  name?: string;
  symbol?: string;
  decimals: number;
  /** whole tokens */
  totalSupply?: number;
  /** Solana: the metadata's image/json uri, for the card image once it resolves */
  metadataUri?: string;
}

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const NAME_SEL = '0x06fdde03';

export interface IdentifyDeps {
  endpoints: Endpoints;
  fetch?: FetchLike;
  /** chains to try first (the chat's hint, the token's known network) */
  prefer?: string[];
}

/** Every EVM chain that holds a contract at this address, preferred chains first. */
export async function identifyEvm(address: string, deps: IdentifyDeps): Promise<Identity[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const prefer = deps.prefer ?? [];
  const nets = Object.values(CHAINS)
    .filter((c) => c.kind === 'evm')
    .map((c) => c.network)
    .sort((a, b) => (prefer.includes(a) ? prefer.indexOf(a) : 99) - (prefer.includes(b) ? prefer.indexOf(b) : 99));
  const calls = [
    { to: address, data: SEL.decimals },
    { to: address, data: SEL.symbol },
    { to: address, data: NAME_SEL },
    { to: address, data: SEL.totalSupply },
  ];
  const hits = await Promise.all(
    nets.map(async (network): Promise<Identity | undefined> => {
      const ep = deps.endpoints.urlFor(network);
      if (!ep) return undefined;
      try {
        const r = await evmCallsDetailed(ep.url, calls, fetchImpl);
        const dec = r[0].result ? words(r[0].result)[0] : undefined;
        if (dec === undefined || dec > 36n) return undefined;
        const decimals = Number(dec);
        const symbol = r[1].result ? decodeString(r[1].result) : undefined;
        const name = r[2].result ? decodeString(r[2].result) : undefined;
        const supplyRaw = r[3].result ? words(r[3].result)[0] : undefined;
        if (!symbol && !name) return undefined; // a contract with decimals() but no name is not a token we can show
        return { network, name, symbol, decimals, totalSupply: supplyRaw !== undefined ? Number(supplyRaw) / 10 ** decimals : undefined };
      } catch {
        return undefined;
      }
    }),
  );
  return hits.filter((h): h is Identity => !!h);
}

/** Metaplex token metadata: key(1) updateAuthority(32) mint(32) name(4+len) symbol(4+len) uri(4+len), strings padded with NULs. */
export function decodeMetaplex(d: Uint8Array): { name?: string; symbol?: string; uri?: string } | undefined {
  if (d.length < 1 + 32 + 32 + 4) return undefined;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 65;
  const str = () => {
    if (o + 4 > d.length) return undefined;
    const len = dv.getUint32(o, true);
    o += 4;
    if (len > 200 || o + len > d.length) return undefined;
    const s = Buffer.from(d.subarray(o, o + len)).toString('utf8').replace(/\0+$/g, '').trim();
    o += len;
    return s || undefined;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  return { name, symbol, uri };
}

export async function identifySolana(mint: string, deps: IdentifyDeps): Promise<Identity | undefined> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return undefined;
  const ep = deps.endpoints.urlFor('solana');
  if (!ep) return undefined;
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike);
  const metadata = findProgramAddress([utf8('metadata'), METAPLEX, mint], METAPLEX).address;
  const [m, meta] = await solanaAccounts(ep.url, [mint, metadata], fetchImpl);
  if (!m) return undefined;
  const decimals = mintDecimals(m.data);
  if (decimals === undefined) return undefined;
  const dv = new DataView(m.data.buffer, m.data.byteOffset, m.data.byteLength);
  const supplyRaw = m.data.length >= 44 ? dv.getBigUint64(36, true) : undefined;
  const md = meta ? decodeMetaplex(meta.data) : undefined;
  return { network: 'solana', name: md?.name, symbol: md?.symbol, decimals, totalSupply: supplyRaw !== undefined ? Number(supplyRaw) / 10 ** decimals : undefined, metadataUri: md?.uri };
}
