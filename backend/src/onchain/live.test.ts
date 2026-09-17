import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createLivePricer } from './live.js';
import { SEL } from './pools.js';
import type { TokenInfo } from '../types.js';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const WETH = '0x2222222222222222222222222222222222222222';
const PAIR = '0x3333333333333333333333333333333333333333';
const V4 = '0x498581ff718922c3f8e6a244956af099b2652b2b'; // base
const POOL_ID = '0x' + 'ab'.repeat(32);
const Q96 = 2n ** 96n;

/** an EVM node as a map of `${to}:${selector}` → result hex; unknown calls error */
function evmNode(table: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body) as any[];
    return {
      ok: true,
      status: 200,
      json: async () =>
        body.map((b) => {
          const key = `${String(b.params[0].to).toLowerCase()}:${String(b.params[0].data).slice(0, 10)}`;
          calls.push(key);
          const r = table[key];
          return r ? { id: b.id, result: r } : { id: b.id, error: { message: 'revert' } };
        }),
    };
  });
  return { fetchImpl, calls };
}
const token = (over: Partial<TokenInfo>): TokenInfo => ({ address: TOKEN, calls: [], firstSeenTs: 0, lastCallTs: 0, network: 'base', pairAddress: PAIR, quoteSymbol: 'WETH', quoteAddress: WETH, priceUsd: 0.003, marketCap: 3_000_000, ...over }) as TokenInfo;
const deps = (fetchImpl: any, quotes: Record<string, number> = { WETH: 3000, ETH: 3000, SOL: 150 }) => {
  const apply = vi.fn();
  const pricer = createLivePricer({
    endpoints: { urlFor: (n) => ({ url: `https://${n}`, source: 'public' as const }), probeAlchemy: async () => ({ hasKey: false, chains: [], probing: false }), alchemy: () => ({ hasKey: false, chains: [], probing: false }), sources: () => ({}) },
    quotes: { usd: (s) => quotes[s.toUpperCase()], refresh: async () => {} },
    apply,
    fetch: fetchImpl,
  });
  return { pricer, apply };
};

describe('live pricer: Uniswap v2', () => {
  it('resolves the pair, reads reserves, prices in USD and scales the market cap to the API supply', async () => {
    const { fetchImpl, calls } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
      [`${PAIR}:${SEL.token1}`]: addr(WETH),
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1_000_000n * 10n ** 18n) + word(1000n * 10n ** 18n) + word(0n), // 1M tokens : 1000 ETH → 0.001 ETH each
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
      [`${TOKEN}:${SEL.totalSupply}`]: '0x' + word(2_000_000_000n * 10n ** 18n),
    });
    const { pricer, apply } = deps(fetchImpl);
    const t = token({});
    await pricer.refresh([t]);
    expect(apply).toHaveBeenCalledTimes(1);
    const info = apply.mock.calls[0][1];
    expect(info.priceUsd).toBeCloseTo(3, 9); // 0.001 ETH × 3000
    expect(info.priceSource).toBe('chain');
    // API said 3,000,000 cap at 0.003 → 1e9 tokens; live cap = 3 × 1e9, not the chain's 2e9 supply
    expect(info.marketCap).toBeCloseTo(3e9, 0);
    expect(pricer.status().base).toMatchObject({ live: 1, skipped: 0 });
    // resolution asked slot0 too (it reverted) and never re-resolves on the next tick; unchanged price is not re-published
    expect(calls.filter((c) => c.endsWith(SEL.slot0))).toHaveLength(1);
    calls.length = 0;
    // the hub would have put the live price on the token; with nothing moved there is no second event
    await pricer.refresh([{ ...t, priceUsd: info.priceUsd, priceSource: 'chain' }]);
    expect(calls).toEqual([`${PAIR}:${SEL.getReserves}`]);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('falls back to the chain supply when the API never gave a cap, and prices token1 pools the other way round', async () => {
    const { fetchImpl } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(WETH),
      [`${PAIR}:${SEL.token1}`]: addr(TOKEN),
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(10n * 10n ** 18n) + word(5000n * 10n ** 6n) + word(0n), // 10 ETH : 5000 tokens (6 dec) → 0.002 ETH each
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(6n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
      [`${TOKEN}:${SEL.totalSupply}`]: '0x' + word(1_000_000n * 10n ** 6n),
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ priceUsd: undefined, marketCap: undefined })]);
    const info = apply.mock.calls[0][1];
    expect(info.priceUsd).toBeCloseTo(6, 9);
    expect(info.marketCap).toBeCloseTo(6_000_000, 0);
  });
});

describe('live pricer: Uniswap v3 and v4', () => {
  it('v3: slot0 answers, so sqrtPriceX96 is used with the pool orientation', async () => {
    const { fetchImpl } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
      [`${PAIR}:${SEL.token1}`]: addr(WETH),
      [`${PAIR}:${SEL.slot0}`]: '0x' + word(Q96 / 10n) + word(0n) + word(0n), // sqrt(token1/token0) = 0.1 → 0.01 ETH per token
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1n) + word(1n) + word(0n), // a pool that answers both is treated as v3
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ priceUsd: 31, marketCap: 31e9 })]);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(30, 6);
  });
  it('v4: reads the PoolManager slot, orients by the reference price, and treats a zero quote address as 18-decimal native', async () => {
    const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [POOL_ID as `0x${string}`, 6n]));
    const sqrt = Q96 * 10n; // token1/token0 = 100: if token is token0 → 100 ETH each; if token1 → 0.01 ETH each
    const packed = (1n << 200n) | sqrt; // tick bits above the low 160 must be masked off
    const { fetchImpl, calls } = evmNode({
      [`${V4}:${SEL.extsload}`]: '0x' + word(packed),
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
    });
    const { pricer, apply } = deps(fetchImpl);
    // reference 33 USD ≈ 0.011 ETH → the token1 orientation (0.01 ETH) is the sane one, even though address order says token0
    const t = token({ pairAddress: POOL_ID, quoteAddress: '0x0000000000000000000000000000000000000000', priceUsd: 33, marketCap: 33e9 });
    await pricer.refresh([t]);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(30, 6);
    expect(calls.some((c) => c.startsWith('0x0000000000000000000000000000000000000000:'))).toBe(false);
    expect(calls.filter((c) => c === `${V4}:${SEL.extsload}`).length).toBeGreaterThanOrEqual(1);
    const slotArg = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)[0].params[0].data;
    expect(slotArg).toBe(SEL.extsload + slot.slice(2));
  });
  it('v4 on a chain without a PoolManager, and pools whose quote is not priced, are skipped with a reason', async () => {
    const { fetchImpl } = evmNode({});
    const { pricer, apply } = deps(fetchImpl);
    const noMgr = token({ address: '0x4444444444444444444444444444444444444444', network: 'hyperevm', pairAddress: POOL_ID });
    const oddQuote = token({ address: '0x5555555555555555555555555555555555555555', quoteSymbol: 'NVDA' });
    await pricer.refresh([noMgr, oddQuote]);
    expect(apply).not.toHaveBeenCalled();
    expect(pricer.reason(noMgr.address)).toMatch(/PoolManager/);
    expect(pricer.reason(oddQuote.address)).toMatch(/NVDA/);
    expect(pricer.status().base.skipped).toBe(1);
    expect(pricer.status().hyperevm.skipped).toBe(1);
  });
  it('a pool that holds neither side, or reverts, is marked unsupported and not asked again this tick cycle', async () => {
    const { fetchImpl, calls } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(WETH),
      [`${PAIR}:${SEL.token1}`]: addr('0x9999999999999999999999999999999999999999'),
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
    });
    const { pricer, apply } = deps(fetchImpl);
    const t = token({});
    await pricer.refresh([t]);
    expect(pricer.reason(TOKEN)).toMatch(/does not hold/);
    calls.length = 0;
    await pricer.refresh([t]);
    expect(calls).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    // a new pair address is looked at afresh
    await pricer.refresh([token({ pairAddress: '0x6666666666666666666666666666666666666666' })]);
    expect(calls.length).toBeGreaterThan(0);
  });
  it('an RPC outage is reported per network and does not throw', async () => {
    const boom = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const { pricer } = deps(boom);
    await pricer.refresh([token({})]);
    expect(pricer.status().base.lastError).toBe('rpc 502');
  });
});

describe('live pricer: pools no API described', () => {
  it('learns the quote from token0/token1 and its symbol(), and publishes it with the price', async () => {
    const sym = '0x' + (32n).toString(16).padStart(64, '0') + (4n).toString(16).padStart(64, '0') + Buffer.from('WETH').toString('hex').padEnd(64, '0');
    const { fetchImpl } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
      [`${PAIR}:${SEL.token1}`]: addr(WETH),
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(10n ** 24n) + word(10n ** 21n) + word(0n),
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.symbol}`]: sym,
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ quoteSymbol: undefined, quoteAddress: undefined, priceUsd: undefined, marketCap: undefined })]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toMatchObject({ priceUsd: 3, quoteSymbol: 'WETH', quoteAddress: WETH, priceSource: 'chain' });
  });
  it('a quote whose symbol is not priced is skipped by name, and a busy node is retried rather than written off', async () => {
    const sym = '0x' + Buffer.from('NVDA').toString('hex').padEnd(64, '0');
    const { fetchImpl } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
      [`${PAIR}:${SEL.token1}`]: addr(WETH),
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1n) + word(1n) + word(0n),
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.symbol}`]: sym,
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ quoteSymbol: undefined, quoteAddress: undefined })]);
    expect(apply).not.toHaveBeenCalled();
    expect(pricer.reason(TOKEN)).toBe('paired with NVDA, which is not priced');

    const busy = vi.fn(async (_u: string, init: any) => ({ ok: true, status: 200, json: async () => (JSON.parse(init.body) as any[]).map((b) => ({ id: b.id, error: { message: 'too many requests' } })) }));
    const p2 = deps(busy);
    await p2.pricer.refresh([token({})]);
    expect(p2.pricer.reason(TOKEN)).toBe('rpc: too many requests');
    expect(p2.pricer.status().base.reasons).toEqual({ 'rpc: too many requests': 1 });
  });
});

describe('live pricer: pump.fun', () => {
  const curve = (vTok: bigint, vSol: bigint, supply: bigint, complete: boolean) => {
    const buf = Buffer.alloc(49);
    buf.writeBigUInt64LE(vTok, 8);
    buf.writeBigUInt64LE(vSol, 16);
    buf.writeBigUInt64LE(supply, 40);
    buf[48] = complete ? 1 : 0;
    return buf.toString('base64');
  };
  const sol = (accounts: (string | null)[]) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { value: accounts.map((d) => (d ? { data: [d, 'base64'] } : null)) } }) }));
  it('reads the bonding curve and prices in SOL × SOL/USD with the curve supply', async () => {
    const f = sol([curve(1_000_000_000_000_000n, 30_000_000_000n, 1_000_000_000_000_000n, false)]);
    const { pricer, apply } = deps(f);
    await pricer.refresh([token({ address: 'Mint111', network: 'solana', dex: 'pump.fun', pairAddress: 'Curve111', quoteSymbol: 'SOL', priceUsd: undefined, marketCap: undefined })]);
    const info = apply.mock.calls[0][1];
    expect(info.priceUsd).toBeCloseTo((30 / 1e9) * 150, 12);
    expect(info.marketCap).toBeCloseTo((30 / 1e9) * 150 * 1e9, 6);
    expect(pricer.status().solana.live).toBe(1);
  });
  it('a completed curve, non-pump.fun Solana pools, and curves not quoted in SOL are skipped', async () => {
    const f = sol([curve(1n, 1n, 1n, true)]);
    const { pricer, apply } = deps(f);
    await pricer.refresh([
      token({ address: 'Mint222', network: 'solana', dex: 'pump.fun', pairAddress: 'Curve222', quoteSymbol: 'SOL' }),
      token({ address: 'Mint333', network: 'solana', dex: 'raydium', pairAddress: 'Pool333', quoteSymbol: 'SOL' }),
      token({ address: 'Mint444', network: 'solana', dex: 'pumpfun', pairAddress: 'Curve444', quoteSymbol: 'PUMP' }),
    ]);
    expect(apply).not.toHaveBeenCalled();
    expect(pricer.reason('Mint222')).toMatch(/graduated/);
    expect(pricer.status().solana.skipped).toBe(3);
    expect(pricer.status().solana.reasons['paired with PUMP, which is not priced']).toBe(1);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).params[0]).toEqual(['Curve222']);
  });
});

describe('live pricer: handing back to the API', () => {
  it('isLive is true after the pool answered and false once it has gone quiet or was never priced', async () => {
    let clock = 1_000_000;
    const apply = vi.fn();
    const { fetchImpl } = evmNode({
      [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
      [`${PAIR}:${SEL.token1}`]: addr(WETH),
      [`${PAIR}:${SEL.getReserves}`]: '0x' + word(10n ** 24n) + word(10n ** 21n) + word(0n),
      [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
    });
    const pricer = createLivePricer({
      endpoints: { urlFor: (n) => ({ url: `https://${n}`, source: 'public' as const }), probeAlchemy: async () => ({ hasKey: false, chains: [], probing: false }), alchemy: () => ({ hasKey: false, chains: [], probing: false }), sources: () => ({}) },
      quotes: { usd: () => 3000, refresh: async () => {} },
      apply,
      fetch: fetchImpl,
      now: () => clock,
    });
    expect(pricer.isLive(TOKEN)).toBe(false);
    const t = token({});
    await pricer.refresh([t]);
    expect(pricer.isLive(TOKEN)).toBe(true);
    clock += 61_000;
    expect(pricer.isLive(TOKEN)).toBe(false);
    // an API write that put its own price on the card is corrected on the next tick even though the pool did not move
    await pricer.refresh([token({ priceUsd: 2.9, priceSource: 'api' })]);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(pricer.isLive(TOKEN)).toBe(true);
  });
});
