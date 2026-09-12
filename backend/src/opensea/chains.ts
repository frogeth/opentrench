/** OpenSea chain identifier → what the minter needs. RPCs are public defaults; ⚙ → Trading overrides them. */
export interface ChainInfo { id: string; name: string; chainId: number; symbol: string; defaultRpc: string; explorerTx: string }
export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', defaultRpc: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/' },
  base: { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', defaultRpc: 'https://mainnet.base.org', explorerTx: 'https://basescan.org/tx/' },
  robinhood: { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, symbol: 'ETH', defaultRpc: 'https://rpc.mainnet.chain.robinhood.com', explorerTx: 'https://robinhoodchain.blockscout.com/tx/' },
  ink: { id: 'ink', name: 'Ink', chainId: 57073, symbol: 'ETH', defaultRpc: 'https://rpc-qnd.inkonchain.com', explorerTx: 'https://explorer.inkonchain.com/tx/' },
};
export const rpcFor = (chain: string, overrides: Record<string, string>): string | undefined => overrides[chain] || CHAINS[chain]?.defaultRpc;
