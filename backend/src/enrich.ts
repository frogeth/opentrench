import type { Chain, TokenInfo } from './types.js';
import { fetchDexscreener } from './dexscreener.js';
import { fetchGeckoTerminal } from './geckoterminal.js';
import { createLaunchpadClassifier, fetchBankrLaunch, fetchO1, fetchPons, fetchStonks, type LaunchpadInfo } from './launchpads.js';

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
  /** launchpad classifier: badge + image/socials for fresh launches no chart site knows yet */
  launchpad?: (address: string, chain: Chain) => Promise<LaunchpadInfo | undefined>;
  log?: (msg: string) => void;
}

const FILL_KEYS = ['imageUrl', 'name', 'symbol', 'website', 'twitter', 'telegram', 'network', 'pairCreatedAt'] as const;

/**
 * Dexscreener first. If it has no pair yet, GeckoTerminal (covers Robinhood
 * Chain and very fresh pools). Then the launchpad probes: they decide the
 * badge and fill whatever the chart sites lacked (image, socials, chain).
 * Every miss is logged so a dead source never looks like "not a token".
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
    if (src.launchpad) {
      try {
        const lp = await src.launchpad(address, chain);
        if (lp) {
          info = info ?? {};
          info.launchpad = lp.launchpad;
          info.launchpadUrl = lp.launchpadUrl;
          for (const k of FILL_KEYS) if (!info[k] && lp[k]) (info as any)[k] = lp[k];
        }
      } catch (e: any) {
        log(`launchpad probe failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (info?.network && !info.explorerUrl) info.explorerUrl = explorerUrl(info.network, address);
    return info;
  };
}

export function createDefaultEnricher(opts: { o1ApiKey?: () => string | undefined } = {}): TokenFetcher {
  return createEnricher({
    dexscreener: (a) => fetchDexscreener(a),
    geckoterminal: (a, c) => fetchGeckoTerminal(a, c),
    launchpad: createLaunchpadClassifier({
      bankr: (a) => fetchBankrLaunch(a),
      stonks: (a) => fetchStonks(a),
      pons: (a) => fetchPons(a),
      o1: (a) => fetchO1(a, opts.o1ApiKey?.()),
    }),
  });
}

export const defaultEnricher: TokenFetcher = createDefaultEnricher();
