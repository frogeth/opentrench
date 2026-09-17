import { STABLES } from './chains.js';

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

/** Stablecoin mints/contracts by address (lower-case for EVM), so a stable is recognised even when its symbol is odd. */
export const STABLE_ADDRESSES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (solana)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (solana)
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1 (solana)
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD (solana)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC (ethereum)
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT (ethereum)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (base)
  '0x55d398326f99059ff775485246999027b3197955', // USDT (bsc)
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC (bsc)
]);

export const isStable = (symbol: string | undefined, address: string | undefined): boolean =>
  (!!symbol && STABLES.has(symbol.toUpperCase())) || (!!address && (STABLE_ADDRESSES.has(address) || STABLE_ADDRESSES.has(address.toLowerCase())));

export const nativeRef = (symbol: string | undefined): QuoteRef | undefined => (symbol ? NATIVE_REFS[NATIVE_ALIASES[symbol.toUpperCase()] ?? ''] : undefined);

export const quoteKey = (network: string, address: string): string => `${network}:${network === 'solana' ? address : address.toLowerCase()}`;
