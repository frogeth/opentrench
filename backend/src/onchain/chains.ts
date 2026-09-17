/**
 * Every chain the feed can price on-chain: its id, a public RPC, the Alchemy subdomain (when Alchemy
 * serves it), the native coin and its CoinGecko id, and the Uniswap v4 PoolManager (v4 pool ids are
 * 32-byte hashes, so the manager is the only way to read them). Custom RPC > Alchemy key > public.
 *
 * PoolManager addresses: developers.uniswap.org/contracts/v4/deployments (2026-09-17); Robinhood and
 * Arc verified live by reading a pool's slot through extsload.
 */
export interface ChainDef {
  network: string;
  kind: 'evm' | 'solana';
  name: string;
  chainId?: number;
  /** a public JSON-RPC endpoint (rate-limited, no key) */
  rpc: string;
  /** `<sub>.g.alchemy.com/v2/<key>`; absent = Alchemy does not serve the chain (or we do not know the name) */
  alchemy?: string;
  /** the gas / quote coin and its CoinGecko id */
  native: string;
  coingecko?: string;
  /** Uniswap v4 PoolManager, lower-case */
  v4?: string;
}

export const CHAINS: Record<string, ChainDef> = {
  ethereum: { network: 'ethereum', kind: 'evm', name: 'Ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', alchemy: 'eth-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x000000000004444c5dc75cb358380d2e3de08a90' },
  base: { network: 'base', kind: 'evm', name: 'Base', chainId: 8453, rpc: 'https://mainnet.base.org', alchemy: 'base-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x498581ff718922c3f8e6a244956af099b2652b2b' },
  arbitrum: { network: 'arbitrum', kind: 'evm', name: 'Arbitrum', chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc', alchemy: 'arb-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x360e68faccca8ca495c1b759fd9eee466db9fb32' },
  bsc: { network: 'bsc', kind: 'evm', name: 'BNB Chain', chainId: 56, rpc: 'https://bsc-dataseed.binance.org', alchemy: 'bnb-mainnet', native: 'BNB', coingecko: 'binancecoin', v4: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df' },
  polygon: { network: 'polygon', kind: 'evm', name: 'Polygon', chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', alchemy: 'polygon-mainnet', native: 'POL', coingecko: 'polygon-ecosystem-token', v4: '0x67366782805870060151383f4bbff9dab53e5cd6' },
  avalanche: { network: 'avalanche', kind: 'evm', name: 'Avalanche', chainId: 43114, rpc: 'https://api.avax.network/ext/bc/C/rpc', alchemy: 'avax-mainnet', native: 'AVAX', coingecko: 'avalanche-2', v4: '0x06380c0e0912312b5150364b9dc4542ba0dbbc85' },
  robinhood: { network: 'robinhood', kind: 'evm', name: 'Robinhood Chain', chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', alchemy: 'robinhood-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
  arc: { network: 'arc', kind: 'evm', name: 'Arc', chainId: 5042, rpc: 'https://rpc.blockdaemon.mainnet.arc.io', alchemy: 'arc-mainnet', native: 'USDC', v4: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
  monad: { network: 'monad', kind: 'evm', name: 'Monad', chainId: 143, rpc: 'https://rpc.monad.xyz', alchemy: 'monad-mainnet', native: 'MON', coingecko: 'monad', v4: '0x188d586ddcf52439676ca21a244753fa19f9ea8e' },
  hyperevm: { network: 'hyperevm', kind: 'evm', name: 'HyperEVM', chainId: 999, rpc: 'https://rpc.hyperliquid.xyz/evm', alchemy: 'hyperliquid-mainnet', native: 'HYPE', coingecko: 'hyperliquid' },
  ink: { network: 'ink', kind: 'evm', name: 'Ink', chainId: 57073, rpc: 'https://rpc-qnd.inkonchain.com', alchemy: 'ink-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x360e68faccca8ca495c1b759fd9eee466db9fb32' },
  zora: { network: 'zora', kind: 'evm', name: 'Zora', chainId: 7777777, rpc: 'https://rpc.zora.energy', alchemy: 'zora-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0x0575338e4c17006ae181b47900a84404247ca30f' },
  megaeth: { network: 'megaeth', kind: 'evm', name: 'MegaETH', chainId: 4326, rpc: 'https://mainnet.megaeth.com/rpc', alchemy: 'megaeth-mainnet', native: 'ETH', coingecko: 'ethereum', v4: '0xacb7e78fa05d562e0a5d3089ec896d57d057d38e' },
  plasma: { network: 'plasma', kind: 'evm', name: 'Plasma', chainId: 9745, rpc: 'https://rpc.plasma.to', alchemy: 'plasma-mainnet', native: 'XPL', coingecko: 'plasma' },
  story: { network: 'story', kind: 'evm', name: 'Story', chainId: 1514, rpc: 'https://mainnet.storyrpc.io', alchemy: 'story-mainnet', native: 'IP', coingecko: 'story-2' },
  tempo: { network: 'tempo', kind: 'evm', name: 'Tempo', rpc: 'https://rpc.tempo.xyz', alchemy: 'tempo-mainnet', native: 'USDC', v4: '0x33620f62c5b9b2086dd6b62f4a297a9f30347029' },
  solana: { network: 'solana', kind: 'solana', name: 'Solana', rpc: 'https://api.mainnet-beta.solana.com', alchemy: 'solana-mainnet', native: 'SOL', coingecko: 'solana' },
};

/** Quote assets that are a dollar. */
export const STABLES = new Set(['USDC', 'USDT', 'USDG', 'USD1', 'DAI', 'USDE', 'USDB', 'USDS', 'PYUSD', 'USDT0', 'USDC.E', 'USDBC']);

/** The CoinGecko id for a quote symbol (native coins, wrapped or not); undefined = not a coin we price. */
export function coingeckoIdFor(symbol: string): string | undefined {
  const s = symbol.toUpperCase().replace(/^W/, '');
  for (const c of Object.values(CHAINS)) if (c.native === s && c.coingecko) return c.coingecko;
  return undefined;
}

export function alchemyUrl(chain: ChainDef, key: string): string | undefined {
  return chain.alchemy ? `https://${chain.alchemy}.g.alchemy.com/v2/${key}` : undefined;
}
