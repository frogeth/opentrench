import type { BuyLinks } from './types.js';

/**
 * Genius Terminal (tradegenius.com) is a web terminal: no bot, no deep links, and it refuses
 * framing, so a buy opens the token's page in the browser, where the user's login lives.
 *   https://tradegenius.com/asset/<address>?network=<id>
 * That is Genius's own route (getAssetHref in its bundle). Network ids are the EVM chain ids,
 * with Solana as 1399811149 (0x536f6c4d). Hyperliquid (998) is its perps venue, not a token
 * chain, so it is not here. No referral: Genius referrals are signup links, not asset links.
 */
export const GENIUS_HOST = 'https://tradegenius.com';

/** Dexscreener network id → Genius network id. */
export const GENIUS_NETWORK_IDS: Record<string, string> = {
  solana: '1399811149',
  ethereum: '1',
  base: '8453',
  bsc: '56',
  arbitrum: '42161',
  avalanche: '43114',
  optimism: '10',
  polygon: '137',
  sonic: '146',
  hyperevm: '999',
  robinhood: '4663',
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The token's page on Genius, or undefined when the chain is unknown, not traded there, or the address does not fit it. */
export function geniusAssetUrl(network: string | undefined, address: string): string | undefined {
  if (!network) return undefined;
  const id = GENIUS_NETWORK_IDS[network];
  if (!id) return undefined;
  const fits = network === 'solana' ? SOLANA_ADDRESS.test(address) : EVM_ADDRESS.test(address);
  if (!fits) return undefined;
  return `${GENIUS_HOST}/asset/${encodeURIComponent(address)}?network=${id}`;
}

/** Genius has no per-amount links: one button opens the token, the terminal takes it from there. */
export function buildGeniusLinks(network: string | undefined, address: string): BuyLinks | undefined {
  const url = geniusAssetUrl(network, address);
  if (!url) return undefined;
  return { provider: 'genius', amounts: [], panel: url, web: url };
}
