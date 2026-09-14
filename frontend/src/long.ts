import { useEffect, useRef } from 'react';
import { api } from './api';
import type { TokenInfo } from './types';

/**
 * Long (app.long.xyz) is read from the page, not the backend: its indexer sits behind Cloudflare's
 * bot check, which lets a browser through and blocks Node. So the page fetches Long's GraphQL
 * (CORS is open) and hands the raw rows to the backend, which maps, stores and broadcasts them
 * to every client. Two jobs: the launches feed while a Long column exists, and telling the
 * backend which called tokens are Long assets (their addresses all end in `1e18`).
 */
export const LONG_API = 'https://api.long.xyz/v1/graphql';
const LONG_CHAIN_ID = 4663;
const LONG_INTEGRATOR = '0x92d435c96e63c43e12d6d0ab28f6b0b04072f765';
const LAUNCHES_MS = 20_000;

const ASSET_FIELDS = `
  asset_address asset_numeraire_address asset_creation_timestamp asset_current_pool integrator_address
  auction_pool { pool_address pool_current_fdv_usd pool_current_sale_progress_percentage pool_volume_24h_usd
    pool_market_data { marketCap price priceChange24 volumeUSD24 }
    base_token { token_symbol token_name token_description token_image_public_url } }
  graduation_pool { pool_address pool_market_data { marketCap price priceChange24 volumeUSD24 } }`;

export const isLongAddress = (address: string): boolean => /^0x[0-9a-f]{40}$/i.test(address) && address.toLowerCase().endsWith('1e18');

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(LONG_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`long ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(json.errors[0]?.message ?? 'graphql error');
  return json.data as T;
}

/** Symbols of Long tokens that other launches anchor to. */
async function symbolsFor(addresses: string[]): Promise<Record<string, string>> {
  if (addresses.length === 0) return {};
  try {
    const data = await gql<{ Asset: any[] }>(`query LongSymbols($addresses: [String!]!) { Asset(where: { asset_address: { _in: $addresses } }) { asset_address auction_pool { base_token { token_symbol } } } }`, { addresses });
    return Object.fromEntries((data?.Asset ?? []).filter((x) => x?.asset_address && x.auction_pool?.base_token?.token_symbol).map((x) => [String(x.asset_address).toLowerCase(), String(x.auction_pool.base_token.token_symbol)]));
  } catch {
    return {};
  }
}
const unknownNumeraires = (assets: any[], known: Set<string>): string[] => [...new Set(assets.map((a) => String(a?.asset_numeraire_address ?? '').toLowerCase()).filter((n) => isLongAddress(n) && !known.has(n)))];

/** Poll the newest launches while a Long column is on screen and hand them to the backend. */
export function useLongLaunches(active: boolean, knownNumeraires: Set<string>): void {
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      try {
        const data = await gql<{ Asset: any[] }>(
          `query LongLaunches($chain: Int!, $integrator: String!, $limit: Int!) { Asset(where: { chain_id: { _eq: $chain }, integrator_address: { _ilike: $integrator } }, order_by: { asset_creation_timestamp: desc }, limit: $limit) { ${ASSET_FIELDS} } }`,
          { chain: LONG_CHAIN_ID, integrator: LONG_INTEGRATOR, limit: 40 },
        );
        const assets = Array.isArray(data?.Asset) ? data.Asset : [];
        const symbols = await symbolsFor(unknownNumeraires(assets, knownNumeraires));
        if (!stop) await api.longLaunches(assets, symbols);
      } catch (e) {
        console.warn('[long] launches', (e as Error).message);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), LAUNCHES_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [active, knownNumeraires]);
}

/** Called EVM tokens with the Long suffix and no launchpad yet: ask Long once, tell the backend. */
export function useLongDetection(tokens: Record<string, TokenInfo>, knownNumeraires: Set<string>): void {
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const due = Object.values(tokens).filter((t) => t.chain === 'evm' && !t.launchpad && isLongAddress(t.address) && !asked.current.has(t.address.toLowerCase())).slice(0, 5);
    for (const t of due) {
      const address = t.address.toLowerCase();
      asked.current.add(address);
      void (async () => {
        try {
          const data = await gql<{ Asset: any[] }>(`query LongAsset($address: String!, $chain: Int!) { Asset(where: { asset_address: { _eq: $address }, chain_id: { _eq: $chain } }, limit: 1) { ${ASSET_FIELDS} } }`, { address, chain: LONG_CHAIN_ID });
          const asset = data?.Asset?.[0];
          if (!asset) return;
          const symbols = await symbolsFor(unknownNumeraires([asset], knownNumeraires));
          await api.longAsset(asset, symbols);
        } catch (e) {
          asked.current.delete(address); // try again on the next change
          console.warn('[long] asset', (e as Error).message);
        }
      })();
    }
  }, [tokens, knownNumeraires]);
}
