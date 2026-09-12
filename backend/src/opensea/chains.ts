/**
 * OpenSea chain identifier → what the minter needs. RPCs are public defaults; ⚙ → Trading overrides them.
 *
 * Trust posture of public RPCs: a public RPC never sees the wallet key — signing happens locally
 * and only the already-signed transaction is sent over the wire — but the RPC is still trusted to
 * tell the truth. A malicious or broken one can lie about balance/fees when quoting a mint, or
 * silently drop a broadcast instead of relaying it. ⚙ → Trading overrides exist so a user can point
 * at an RPC they trust instead of the bundled public default.
 */
export interface ChainInfo { id: string; name: string; chainId: number; symbol: string; defaultRpc: string; explorerTx: string }
export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', defaultRpc: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/' },
  base: { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', defaultRpc: 'https://mainnet.base.org', explorerTx: 'https://basescan.org/tx/' },
  robinhood: { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, symbol: 'ETH', defaultRpc: 'https://rpc.mainnet.chain.robinhood.com', explorerTx: 'https://robinhoodchain.blockscout.com/tx/' },
  ink: { id: 'ink', name: 'Ink', chainId: 57073, symbol: 'ETH', defaultRpc: 'https://rpc-qnd.inkonchain.com', explorerTx: 'https://explorer.inkonchain.com/tx/' },
};

/** Own-property lookup: `chain` comes from external input, and a plain `obj[chain]` can be tricked into resolving `constructor`/`__proto__`/etc off the prototype chain instead of returning undefined. */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Safe lookup of a chain's static info by an external/untrusted chain identifier. Use this (not `CHAINS[chain]`) wherever `chain` isn't already known-good. */
export const chainInfo = (chain: string): ChainInfo | undefined => own(CHAINS, chain);

export const rpcFor = (chain: string, overrides: Record<string, string>): string | undefined => own(overrides, chain) || chainInfo(chain)?.defaultRpc;
