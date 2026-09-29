import { CHAINS, STABLES } from './chains.js';

/**
 * What a token is priced against, and how that asset itself becomes dollars — on-chain, never an
 * API: a stable is a dollar; a native coin is read from one deep reference pool on its home chain;
 * anything else (a tokenized stock, WHYPE, a meme used as a quote) is priced through its own main
 * pool, found once through Dexscreener's directory and then read live like any other token.
 */
export interface QuoteRef {
  /** the asset's own key: `${network}:${address}` */
  key: string;
  network: string;
  address: string;
  symbol: string;
  /** its main pool, and what that pool is quoted in */
  pairAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
  dex?: string;
}

/** Deep reference pools for native coins (verified 2026-09-17). Bridged/wrapped ETH anywhere is priced as ETH. */
export const NATIVE_REFS: Record<string, QuoteRef> = {
  ETH: { key: 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', network: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', pairAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', quoteSymbol: 'USDC', quoteAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', dex: 'uniswap' },
  BNB: { key: 'bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', network: 'bsc', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', pairAddress: '0x36696169c63e42cd08ce11f5deebbcebae652050', quoteSymbol: 'USDT', quoteAddress: '0x55d398326f99059ff775485246999027b3197955', dex: 'pancakeswap' },
  SOL: { key: 'solana:So11111111111111111111111111111111111111112', network: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', pairAddress: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', quoteSymbol: 'USDC', quoteAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dex: 'raydium' },
  POL: { key: 'polygon:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', network: 'polygon', address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WPOL', pairAddress: '0xa374094527e1673a86de625aa59517c5de346d2f', quoteSymbol: 'USDC', quoteAddress: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', dex: 'uniswap' },
  AVAX: { key: 'avalanche:0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', network: 'avalanche', address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', symbol: 'WAVAX', pairAddress: '0xfae3f424a0a47706811521e3ee268f00cfb5c45e', quoteSymbol: 'USDC', quoteAddress: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', dex: 'uniswap' },
};
const NATIVE_ALIASES: Record<string, string> = { ETH: 'ETH', WETH: 'ETH', BNB: 'BNB', WBNB: 'BNB', SOL: 'SOL', WSOL: 'SOL', POL: 'POL', WPOL: 'POL', MATIC: 'POL', WMATIC: 'POL', AVAX: 'AVAX', WAVAX: 'AVAX' };

export const isStable = (symbol: string | undefined, address: string | undefined): boolean =>
  (!!symbol && STABLES.has(symbol.toUpperCase())) || (!!address && (STABLE_ADDRESSES.has(address) || STABLE_ADDRESSES.has(address.toLowerCase())));

export const nativeRef = (symbol: string | undefined): QuoteRef | undefined => (symbol ? NATIVE_REFS[NATIVE_ALIASES[symbol.toUpperCase()] ?? ''] : undefined);

export const quoteKey = (network: string, address: string): string => `${network}:${network === 'solana' ? address : address.toLowerCase()}`;

/**
 * Wrapped native coins and dollars by address, per chain; each checked on-chain (symbol and decimals,
 * 2026-09-17 and 2026-09-28; 0x4200…0006 is WETH on every OP-stack chain here). A token's symbol() is
 * whatever its deployer typed, so a quote is a dollar or a native coin only when its address, on its
 * own chain, says so. The same address on another chain is not assumed to be the same token.
 */
const KNOWN: Record<string, Record<string, 'USD' | keyof typeof NATIVE_REFS>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USD', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USD', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'USD', // DAI
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USD', // USDe
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'ETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USD', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USD', // USDT
  },
  ink: { '0x4200000000000000000000000000000000000006': 'ETH', '0x2d270e6886d130d724215a266106e6832161eaed': 'USD', '0x0200c29006150606b650577bbe7b6248f58470c1': 'USD' },
  zora: { '0x4200000000000000000000000000000000000006': 'ETH' },
  megaeth: { '0x4200000000000000000000000000000000000006': 'ETH' },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ETH',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USD', // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USD', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USD', // USDT0
  },
  robinhood: { '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'ETH', '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USD' /* USDG, 6 decimals */ },
  bsc: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB',
    '0x55d398326f99059ff775485246999027b3197955': 'USD', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USD', // USDC
    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD', // USD1
  },
  polygon: {
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'POL',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USD', // USDC
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USD', // USDC.e
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USD', // USDT0
  },
  avalanche: { '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': 'AVAX', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USD' },
  arc: { '0x3600000000000000000000000000000000000000': 'USD' },
  monad: { '0x754704bc059f8c67012fed69bc8a327a5aafb603': 'USD', '0xe7cd86e13ac4309349f30b3435a9d337750fc82d': 'USD' }, // USDC, USDT0
  hyperevm: { '0xb88339cb7199b77e23db6e890353e22632ba630f': 'USD', '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': 'USD' }, // USDC, USDT0
  plasma: { '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': 'USD' }, // USDT0
  story: { '0xf1815bd50389c46847f0bda824ec8da914045d14': 'USD' }, // USDC.e
  solana: {
    So11111111111111111111111111111111111111112: 'SOL',
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USD', // USDC
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USD', // USDT
    USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD', // USD1
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'USD', // PYUSD
  },
};
/** Every dollar token above, by address (any chain): for the places that only ask "is this mint a dollar". */
export const STABLE_ADDRESSES = new Set(Object.values(KNOWN).flatMap((m) => Object.entries(m).filter(([, k]) => k === 'USD').map(([a]) => a)));
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * What a quote asset is, from its address alone: a dollar, a native coin (with its reference pool), or
 * undefined (then it is priced through its own pool, like a tokenized stock). The zero address is the
 * chain's own coin.
 */
export function knownQuote(network: string, address: string): { usd: true } | { native: QuoteRef } | undefined {
  const a = network === 'solana' ? address : address.toLowerCase();
  const kind = a === ZERO && network !== 'solana' ? CHAINS[network]?.native : KNOWN[network]?.[a];
  if (!kind) return undefined;
  if (kind === 'USD' || STABLES.has(kind)) return { usd: true };
  const ref = NATIVE_REFS[NATIVE_ALIASES[kind] ?? ''];
  return ref ? { native: ref } : undefined;
}
