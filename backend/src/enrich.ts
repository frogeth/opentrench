import type { Chain, TokenInfo } from './types.js';
import { fetchDexscreener } from './dexscreener.js';
import { fetchGeckoTerminal } from './geckoterminal.js';
import { fetchBankr } from './bankr.js';

export type TokenFetcher = (address: string, chain: Chain) => Promise<Partial<TokenInfo> | undefined>;

const EXPLORERS: Record<string, string> = {
  ethereum: 'https://etherscan.io/token/',
  base: 'https://basescan.org/token/',
  bsc: 'https://bscscan.com/token/',
  arbitrum: 'https://arbiscan.io/token/',
  polygon: 'https://polygonscan.com/token/',
  avalanche: 'https://snowtrace.io/token/',
  robinhood: 'https://robinhoodchain.blockscout.com/token/',
  solana: 'https://solscan.io/token/',
};

export function explorerUrl(network: string | undefined, address: string): string | undefined {
  if (!network) return undefined;
  const base = EXPLORERS[network];
  return base ? base + address : undefined;
}

export interface EnrichSources {
  dexscreener?: (address: string) => Promise<Partial<TokenInfo> | undefined>;
  geckoterminal?: (address: string, chain: Chain) => Promise<Partial<TokenInfo> | undefined>;
  bankr?: (address: string) => Promise<Partial<TokenInfo> | undefined>;
  log?: (msg: string) => void;
}

/**
 * Dexscreener first. If it has no pair yet, GeckoTerminal (covers Robinhood
 * Chain and very fresh pools). Bankr fills name/socials/chain for launches no
 * chart site has indexed at all. Every miss is logged so a dead source never
 * looks like "not a token".
 */
export function createEnricher(src: EnrichSources): TokenFetcher {
  const log = src.log ?? ((m: string) => console.warn('[enrich]', m));
  return async (address, chain) => {
    let info: Partial<TokenInfo> | undefined;

    if (src.dexscreener) {
      try {
        info = await src.dexscreener(address);
      } catch (e: any) {
        log(`dexscreener failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (!info && src.geckoterminal) {
      try {
        info = await src.geckoterminal(address, chain);
        if (!info) log(`no pair on dexscreener or geckoterminal for ${address}`);
      } catch (e: any) {
        log(`geckoterminal failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (chain === 'evm' && src.bankr && (!info || (!info.website && !info.twitter))) {
      try {
        const b = await src.bankr(address);
        if (b) {
          info = { ...b, ...(info ?? {}) };
          for (const k of ['website', 'twitter', 'name', 'symbol', 'network'] as const) {
            if (!info[k] && b[k]) (info as any)[k] = b[k];
          }
        }
      } catch (e: any) {
        log(`bankr failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (info?.network && !info.explorerUrl) info.explorerUrl = explorerUrl(info.network, address);
    return info;
  };
}

export const defaultEnricher: TokenFetcher = createEnricher({
  dexscreener: (a) => fetchDexscreener(a),
  geckoterminal: (a, c) => fetchGeckoTerminal(a, c),
  bankr: (a) => fetchBankr(a),
});
