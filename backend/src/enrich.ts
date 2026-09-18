import type { Chain, TokenInfo } from './types.js';
import { fetchDexscreener } from './dexscreener.js';
import { fetchGeckoTerminal, gtThrottled } from './geckoterminal.js';
import { probeChains } from './rpcprobe.js';
import { createLaunchpadClassifier, fetchBankrLaunch, fetchClanker, fetchFlap, fetchO1, fetchPons, fetchGenius, fetchPumpfun, fetchStonks, fetchVirtuals, type LaunchpadInfo, fetchArgus, fetchWarp, fetchPeach, fetchDyor, fetchSynthra } from './launchpads.js';
import { fetchLong } from './long.js';

export type TokenFetcher = (address: string, chain: Chain) => Promise<Partial<TokenInfo> | undefined>;

const EXPLORERS: Record<string, string> = {
  ethereum: 'https://etherscan.io/token/',
  base: 'https://basescan.org/token/',
  bsc: 'https://bscscan.com/token/',
  arbitrum: 'https://arbiscan.io/token/',
  polygon: 'https://polygonscan.com/token/',
  avalanche: 'https://snowtrace.io/token/',
  robinhood: 'https://robin.etherscan.io/token/',
  solana: 'https://solscan.io/token/',
  monad: 'https://monadscan.com/token/',
  hyperevm: 'https://hyperevmscan.io/token/',
  plasma: 'https://plasmascan.to/token/',
  story: 'https://www.storyscan.io/token/',
  megaeth: 'https://megaeth.blockscout.com/token/',
  ink: 'https://explorer.inkonchain.com/token/',
  arc: 'https://www.arcexplorer.org/token/',
};

export function explorerUrl(network: string | undefined, address: string): string | undefined {
  if (!network) return undefined;
  const base = EXPLORERS[network];
  return base ? base + address : undefined;
}

export interface EnrichSources {
  dexscreener?: (address: string) => Promise<Partial<TokenInfo> | undefined>;
  /** `networks`: only these GeckoTerminal networks, when the chain is already known */
  geckoterminal?: (address: string, chain: Chain, networks?: string[]) => Promise<Partial<TokenInfo> | undefined>;
  /** chains no chart site indexes: their own RPCs say whether the contract lives there */
  rpcProbe?: (address: string) => Promise<Partial<TokenInfo> | undefined>;
  /** GeckoTerminal is backing off a 429: a token the probe placed is returned now, its price comes with the next refresh */
  gtBusy?: () => boolean;
  /** launchpad classifier: badge + image/socials for fresh launches no chart site knows yet */
  launchpad?: (address: string, chain: Chain) => Promise<LaunchpadInfo | undefined>;
  /** the chain itself: name, ticker, chain and pool from the contract and the factories (onchain/firstsight.ts) */
  chain?: (address: string, chain: Chain) => Promise<Partial<TokenInfo> | undefined>;
  log?: (msg: string) => void;
}

// a launchpad that knows the token's curve (Genius) also fills the pool, so the live pricer can read it before any directory lists it
const FILL_KEYS = ['imageUrl', 'name', 'symbol', 'website', 'twitter', 'telegram', 'network', 'pairCreatedAt', 'marketCap', 'pairAddress', 'quoteSymbol', 'quoteAddress', 'dex'] as const;
/** what the chain itself can say about a token (see onchain/firstsight.ts) */
const CHAIN_KEYS = ['network', 'name', 'symbol', 'pairAddress', 'quoteSymbol', 'quoteAddress', 'dex'] as const;

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

    // Dexscreener and the chain at the same time: the chain answers in one round trip with the
    // ticker and the pool, the site (when it has indexed the token) adds the numbers
    const [ds, onchain] = await Promise.all([
      src.dexscreener
        ? src.dexscreener(address).catch((e: any) => {
            log(`dexscreener failed for ${address}: ${e?.message ?? e}`);
            return undefined;
          })
        : undefined,
      src.chain
        ? src.chain(address, chain).catch((e: any) => {
            log(`chain lookup failed for ${address}: ${e?.message ?? e}`);
            return undefined;
          })
        : undefined,
    ]);
    info = ds;
    if (onchain) {
      info = info ?? {};
      for (const k of CHAIN_KEYS) if (!info[k] && onchain[k]) (info as any)[k] = onchain[k];
    }
    // a chain the chart sites do not index (Arc): its RPC places the contract at once, so the
    // chain, symbol and a chart are there even while the price feed is rate-limited or behind
    let placed: Partial<TokenInfo> | undefined;
    if (!info?.network && chain === 'evm' && src.rpcProbe) {
      try {
        placed = await src.rpcProbe(address);
      } catch (e: any) {
        log(`rpc probe failed for ${address}: ${e?.message ?? e}`);
      }
    }
    // GeckoTerminal only when Dexscreener had nothing and no factory placed a pool for it
    if (!ds && !info?.pairAddress && src.geckoterminal && !(placed && src.gtBusy?.()) && !(info?.network && src.gtBusy?.())) {
      try {
        const gt = await src.geckoterminal(address, chain, (info?.network ?? placed?.network) ? [info?.network ?? placed!.network!] : undefined);
        if (gt) {
          info = info ?? {};
          for (const k of Object.keys(gt) as (keyof TokenInfo)[]) if (info[k] === undefined && gt[k] !== undefined) (info as any)[k] = gt[k];
        } else if (!placed && !info) log(`no pair on dexscreener or geckoterminal for ${address}`);
      } catch (e: any) {
        log(`geckoterminal failed for ${address}: ${e?.message ?? e}`);
      }
    }
    if (placed) {
      info = info ?? {};
      for (const k of ['network', 'symbol', 'name'] as const) if (!info[k] && placed[k]) (info as any)[k] = placed[k];
    }
    if (src.launchpad) {
      try {
        const lp = await src.launchpad(address, chain);
        if (lp) {
          info = info ?? {};
          info.launchpad = lp.launchpad;
          info.launchpadUrl = lp.launchpadUrl;
          if (lp.launchpadNote) info.launchpadNote = lp.launchpadNote;
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

export function createDefaultEnricher(opts: { o1ApiKey?: () => string | undefined; chain?: EnrichSources['chain'] } = {}): TokenFetcher {
  return createEnricher({
    chain: opts.chain,
    dexscreener: (a) => fetchDexscreener(a),
    geckoterminal: (a, c, networks) => fetchGeckoTerminal(a, c, undefined, networks),
    rpcProbe: (a) => probeChains(a),
    gtBusy: () => gtThrottled(),
    launchpad: createLaunchpadClassifier({
      bankr: (a) => fetchBankrLaunch(a),
      stonks: (a) => fetchStonks(a),
      pons: (a) => fetchPons(a),
      genius: (a) => fetchGenius(a),
      long: (a) => fetchLong(a),
      argus: (a) => fetchArgus(a),
      warp: (a) => fetchWarp(a),
      peach: (a) => fetchPeach(a),
      dyor: (a) => fetchDyor(a),
      synthra: (a) => fetchSynthra(a),
      flap: (a) => fetchFlap(a),
      virtuals: (a) => fetchVirtuals(a),
      clanker: (a) => fetchClanker(a),
      o1: (a) => fetchO1(a, opts.o1ApiKey?.()),
      pumpfun: (a) => fetchPumpfun(a),
    }),
  });
}

export const defaultEnricher: TokenFetcher = createDefaultEnricher();
