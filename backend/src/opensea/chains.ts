/**
 * OpenSea chain identifier → what the minter needs. RPCs are public defaults; ⚙ → Trading overrides them.
 *
 * Trust posture of public RPCs: a public RPC never sees the wallet key — signing happens locally
 * and only the already-signed transaction is sent over the wire — but the RPC is still trusted to
 * tell the truth. A malicious or broken one can lie about balance/fees when quoting a mint, or
 * silently drop a broadcast instead of relaying it. ⚙ → Trading overrides exist so a user can point
 * at an RPC they trust instead of the bundled public default. `maxFeeGwei`/`maxTipGwei` are the
 * per-chain sanity ceiling on what such an RPC is allowed to quote: not a fee strategy, but far
 * above any healthy gas price on that chain, so that a hostile or broken RPC cannot talk a funded
 * wallet into signing an absurd fee.
 */
export interface ChainInfo { id: string; name: string; chainId: number; symbol: string; defaultRpc: string; explorerTx: string; maxFeeGwei: number; maxTipGwei: number }
export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', defaultRpc: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/', maxFeeGwei: 300, maxTipGwei: 50 },
  base: { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', defaultRpc: 'https://mainnet.base.org', explorerTx: 'https://basescan.org/tx/', maxFeeGwei: 5, maxTipGwei: 1 },
  robinhood: { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, symbol: 'ETH', defaultRpc: 'https://rpc.mainnet.chain.robinhood.com', explorerTx: 'https://robinhoodchain.blockscout.com/tx/', maxFeeGwei: 5, maxTipGwei: 1 },
  ink: { id: 'ink', name: 'Ink', chainId: 57073, symbol: 'ETH', defaultRpc: 'https://rpc-qnd.inkonchain.com', explorerTx: 'https://explorer.inkonchain.com/tx/', maxFeeGwei: 5, maxTipGwei: 1 },
};

/** Own-property lookup: `chain` comes from external input, and a plain `obj[chain]` can be tricked into resolving `constructor`/`__proto__`/etc off the prototype chain instead of returning undefined. */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Safe lookup of a chain's static info by an external/untrusted chain identifier. Use this (not `CHAINS[chain]`) wherever `chain` isn't already known-good. */
export const chainInfo = (chain: string): ChainInfo | undefined => own(CHAINS, chain);

export const rpcFor = (chain: string, overrides: Record<string, string>): string | undefined => own(overrides, chain) || chainInfo(chain)?.defaultRpc;

/**
 * The only contracts a SeaDrop mint may be sent to. OpenSea hands us the `to` address, so this is
 * the last line between "OpenSea (or anything impersonating it) said so" and a signed transaction
 * to an arbitrary contract: the canonical SeaDrop 1.0 deployment is the same address on every chain.
 */
export const SEADROP_TARGETS = new Set(['0x00005ea00ac477b1030ce78506496e8c2de24bf5']);
