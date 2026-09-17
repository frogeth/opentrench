import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createLivePricer } from './live.js';
import { SEL } from './pools.js';
import { NATIVE_REFS } from './quotes.js';
import { base58, PROGRAMS } from './solana.js';
import type { TokenInfo } from '../types.js';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const abiString = (s: string) => '0x' + word(32n) + word(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const WETH = '0x2222222222222222222222222222222222222222';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAIR = '0x3333333333333333333333333333333333333333';
const V4 = '0x498581ff718922c3f8e6a244956af099b2652b2b'; // base
const POOL_ID = '0x' + 'ab'.repeat(32);
const Q96 = 2n ** 96n;
const ETH_REF = NATIVE_REFS.ETH;

/** an EVM node per url: `${to}:${selector}` → result hex; unknown calls revert */
function evmNode(tables: Record<string, Record<string, string>>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body)) {
      // solana
      const table = tables[url] ?? {};
      if (body.method === 'getMultipleAccounts') return { ok: true, status: 200, json: async () => ({ result: { value: body.params[0].map((k: string) => { calls.push(`sol:${k}`); const v = table[k]; return v ? { owner: v.split('|')[0], data: [v.split('|')[1], 'base64'] } : null; }) } }) };
      return { ok: true, status: 200, json: async () => ({ result: null }) };
    }
    const table = tables[url] ?? {};
    return {
      ok: true,
      status: 200,
      json: async () =>
        body.map((b: any) => {
          const key = `${String(b.params[0].to).toLowerCase()}:${String(b.params[0].data).slice(0, 10)}`;
          calls.push(key);
          const r = table[key];
          return r ? { id: b.id, result: r } : { id: b.id, error: { message: 'execution reverted' } };
        }),
    };
  });
  return { fetchImpl, calls };
}
/** the ETH reference pool on mainnet: USDC (6) is token0, WETH (18) token1; 1 ETH = 3000 USDC */
const ethRefTable = () => {
  // sqrt(token1/token0 raw) where token1/token0 = 1e18 / (3000 × 1e6) → price of token0 (USDC) in WETH… we want WETH priced in USDC:
  // raw ratio token1/token0 = (1 WETH raw per 3000 USDC raw) = 1e18 / 3000e6; sqrtPriceX96 = sqrt(ratio) × 2^96
  const ratio = 1e18 / 3000e6;
  const sqrt = BigInt(Math.round(Math.sqrt(ratio) * 2 ** 40)) * 2n ** 56n; // keep precision in bigint
  return {
    [`${ETH_REF.pairAddress}:${SEL.token0}`]: addr(ETH_REF.quoteAddress),
    [`${ETH_REF.pairAddress}:${SEL.token1}`]: addr(ETH_REF.address),
    [`${ETH_REF.pairAddress}:${SEL.slot0}`]: '0x' + word(sqrt) + word(0n) + word(0n),
    [`${ETH_REF.address}:${SEL.decimals}`]: '0x' + word(18n),
    [`${ETH_REF.quoteAddress}:${SEL.decimals}`]: '0x' + word(6n),
    [`${ETH_REF.quoteAddress}:${SEL.symbol}`]: abiString('USDC'),
  };
};
const token = (over: Partial<TokenInfo>): TokenInfo => ({ address: TOKEN, calls: [], firstSeenTs: 0, lastCallTs: 0, network: 'base', pairAddress: PAIR, quoteSymbol: 'WETH', quoteAddress: WETH, priceUsd: 0.003, marketCap: 3_000_000, ...over }) as TokenInfo;
const deps = (fetchImpl: any, extra: Partial<Parameters<typeof createLivePricer>[0]> = {}) => {
  const apply = vi.fn();
  const pricer = createLivePricer({
    endpoints: { urlFor: (n) => ({ url: `https://${n}`, source: 'public' as const }), probeAlchemy: async () => ({ hasKey: false, chains: [], probing: false }), alchemy: () => ({ hasKey: false, chains: [], probing: false }), sources: () => ({}) },
    apply,
    fetch: fetchImpl,
    ...extra,
  });
  return { pricer, apply };
};

describe('live pricer: Uniswap v2 with the quote priced on-chain', () => {
  it('reads reserves, prices ETH through the mainnet reference pool first, scales the cap to the API supply, and stays quiet when nothing moved', async () => {
    const { fetchImpl, calls } = evmNode({
      'https://ethereum': ethRefTable(),
      'https://base': {
        [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
        [`${PAIR}:${SEL.token1}`]: addr(WETH),
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1_000_000n * 10n ** 18n) + word(1000n * 10n ** 18n) + word(0n), // 0.001 ETH each
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.symbol}`]: abiString('WETH'),
        [`${TOKEN}:${SEL.totalSupply}`]: '0x' + word(2_000_000_000n * 10n ** 18n),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    const t = token({});
    await pricer.refresh([t]);
    expect(apply).toHaveBeenCalledTimes(1);
    const info = apply.mock.calls[0][1];
    expect(info.priceUsd).toBeCloseTo(3, 6); // 0.001 ETH × 3000
    expect(info.priceSource).toBe('chain');
    expect(info.marketCap).toBeCloseTo(3e9, -3); // API implied 1e9 tokens, not the chain's 2e9
    expect(pricer.quotes()[ETH_REF.key]).toBeCloseTo(3000, 3);
    expect(pricer.status().base).toMatchObject({ live: 1, skipped: 0 });
    expect(pricer.status().ethereum.live).toBe(1);
    expect(pricer.isLive(TOKEN)).toBe(true);
    // the ethereum reference was read before base
    expect(calls.indexOf(`${ETH_REF.pairAddress}:${SEL.slot0}`)).toBeLessThan(calls.indexOf(`${PAIR}:${SEL.getReserves}`));
    calls.length = 0;
    await pricer.refresh([{ ...t, priceUsd: info.priceUsd, priceSource: 'chain' }]);
    expect(calls.filter((c) => c.startsWith(PAIR))).toEqual([`${PAIR}:${SEL.getReserves}`]);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('a stable quote is a dollar with no extra round; token1 pools price the other way round; chain supply when the API gave no cap', async () => {
    const { fetchImpl, calls } = evmNode({
      'https://base': {
        [`${PAIR}:${SEL.token0}`]: addr(USDC),
        [`${PAIR}:${SEL.token1}`]: addr(TOKEN),
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(10_000n * 10n ** 6n) + word(5000n * 10n ** 6n) + word(0n), // 10000 USDC : 5000 tokens → $2
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(6n),
        [`${USDC}:${SEL.decimals}`]: '0x' + word(6n),
        [`${USDC}:${SEL.symbol}`]: abiString('USDC'),
        [`${TOKEN}:${SEL.totalSupply}`]: '0x' + word(1_000_000n * 10n ** 6n),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ quoteSymbol: 'USDC', quoteAddress: USDC, priceUsd: undefined, marketCap: undefined })]);
    expect(apply.mock.calls[0][1]).toMatchObject({ priceUsd: 2, marketCap: 2_000_000 });
    expect(calls.some((c) => c.includes(ETH_REF.pairAddress))).toBe(false);
  });
});

describe('live pricer: v3, v4 and Pons curves', () => {
  it('v3: slot0 answers, so sqrtPriceX96 is used with the pool orientation', async () => {
    const { fetchImpl } = evmNode({
      'https://ethereum': ethRefTable(),
      'https://base': {
        [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
        [`${PAIR}:${SEL.token1}`]: addr(WETH),
        [`${PAIR}:${SEL.slot0}`]: '0x' + word(Q96 / 10n) + word(0n) + word(0n), // 0.01 ETH per token
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1n) + word(1n) + word(0n),
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.symbol}`]: abiString('WETH'),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ priceUsd: 31, marketCap: 31e9 })]);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(30, 3);
  });
  it('v4: reads the PoolManager slot, orients by the reference price, treats a zero quote address as 18-decimal native', async () => {
    const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [POOL_ID as `0x${string}`, 6n]));
    const packed = (1n << 200n) | (Q96 * 10n); // tick bits above 160 must be masked; token1/token0 = 100
    const { fetchImpl, calls } = evmNode({
      'https://ethereum': ethRefTable(),
      'https://base': { [`${V4}:${SEL.extsload}`]: '0x' + word(packed), [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n) },
    });
    const { pricer, apply } = deps(fetchImpl);
    // reference 33 USD ≈ 0.011 ETH → the token1 orientation (0.01 ETH) is the sane one although address order says token0
    await pricer.refresh([token({ pairAddress: POOL_ID, quoteSymbol: 'ETH', quoteAddress: '0x0000000000000000000000000000000000000000', priceUsd: 33, marketCap: 33e9 })]);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(30, 3);
    expect(calls.some((c) => c.startsWith('0x0000000000000000000000000000000000000000:'))).toBe(false);
    expect(JSON.parse((fetchImpl.mock.calls.find((c: any) => c[0] === 'https://base') as any)[1].body)[0].params[0].data).toBe(SEL.extsload + slot.slice(2));
  });
  it('Pons: no token0/token1, getReserves is (quote, token); a v4 id on a chain without a PoolManager is skipped', async () => {
    const { fetchImpl } = evmNode({
      'https://ethereum': ethRefTable(),
      'https://robinhood': {
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(2n * 10n ** 18n) + word(1_000_000_000n * 10n ** 18n), // 2 ETH virtual : 1e9 tokens
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    const noMgr = token({ address: '0x4444444444444444444444444444444444444444', network: 'hyperevm', pairAddress: POOL_ID, quoteSymbol: 'WHYPE' });
    await pricer.refresh([token({ network: 'robinhood', dex: 'pons-v2', quoteSymbol: 'WETH', priceUsd: undefined, marketCap: undefined }), noMgr]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(2e-9 * 3000, 12);
    expect(pricer.reason('hyperevm', noMgr.address)).toMatch(/PoolManager/);
  });
  it('a quote nobody can price is skipped by name; a busy node is retried, not written off; an outage is reported', async () => {
    const { fetchImpl } = evmNode({
      'https://base': {
        [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
        [`${PAIR}:${SEL.token1}`]: addr(WETH),
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1n) + word(1n) + word(0n),
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.decimals}`]: '0x' + word(18n),
        [`${WETH}:${SEL.symbol}`]: abiString('NVDA'),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ quoteSymbol: undefined, quoteAddress: undefined })]);
    expect(apply).not.toHaveBeenCalled();
    expect(pricer.status().base.reasons).toEqual({ 'paired with NVDA, which is not priced': 1 });

    const busy = vi.fn(async (_u: string, init: any) => ({ ok: true, status: 200, json: async () => (JSON.parse(init.body) as any[]).map((b) => ({ id: b.id, error: { message: 'too many requests' } })) }));
    const p2 = deps(busy);
    await p2.pricer.refresh([token({})]);
    expect(p2.pricer.reason('base', TOKEN)).toBe('rpc: too many requests');

    const boom = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const p3 = deps(boom);
    await p3.pricer.refresh([token({})]);
    expect(p3.pricer.status().base.lastError).toBe('rpc 502');
  });
  it('an unknown quote is found through the directory once, then priced through its own pool (a tokenized stock against USDC)', async () => {
    const GOOGL = '0x5555555555555555555555555555555555555555';
    const GPAIR = '0x6666666666666666666666666666666666666666';
    const { fetchImpl, calls } = evmNode({
      'https://robinhood': {
        [`${PAIR}:${SEL.token0}`]: addr(TOKEN),
        [`${PAIR}:${SEL.token1}`]: addr(GOOGL),
        [`${PAIR}:${SEL.getReserves}`]: '0x' + word(1_000_000n * 10n ** 18n) + word(100n * 10n ** 18n) + word(0n), // 0.0001 GOOGL each
        [`${TOKEN}:${SEL.decimals}`]: '0x' + word(18n),
        [`${GOOGL}:${SEL.decimals}`]: '0x' + word(18n),
        [`${GOOGL}:${SEL.symbol}`]: abiString('GOOGL'),
        [`${GPAIR}:${SEL.token0}`]: addr(GOOGL),
        [`${GPAIR}:${SEL.token1}`]: addr(USDC),
        [`${GPAIR}:${SEL.getReserves}`]: '0x' + word(1000n * 10n ** 18n) + word(200_000n * 10n ** 6n) + word(0n), // 200 USDC per GOOGL
        [`${USDC}:${SEL.decimals}`]: '0x' + word(6n),
        [`${USDC}:${SEL.symbol}`]: abiString('USDC'),
      },
    });
    const discover = vi.fn(async (_n: string, address: string) => (address === GOOGL ? { symbol: 'GOOGL', pairAddress: GPAIR, quoteSymbol: 'USDC', quoteAddress: USDC, dex: 'uniswap', priceUsd: 199 } : undefined));
    const { pricer, apply } = deps(fetchImpl, { discover });
    const t = token({ network: 'robinhood', quoteSymbol: 'GOOGL', quoteAddress: GOOGL, priceUsd: undefined, marketCap: undefined });
    await pricer.refresh([t]);
    // first tick: the lookup is in flight
    expect(apply).not.toHaveBeenCalled();
    expect(Object.keys(pricer.status().robinhood.reasons)[0]).toMatch(/finding a pool for GOOGL|GOOGL not priced yet/);
    await new Promise((r) => setImmediate(r));
    await pricer.refresh([t]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(0.02, 9); // 0.0001 × 200
    expect(pricer.quotes()[`robinhood:${GOOGL}`]).toBeCloseTo(200, 6);
    expect(calls.filter((c) => c === `${GPAIR}:${SEL.getReserves}`).length).toBeGreaterThanOrEqual(1);
  });
});

describe('live pricer: Solana', () => {
  const K = (fill: number) => new Uint8Array(32).fill(fill);
  const MINT = base58(K(7)), SOL = NATIVE_REFS.SOL.address, USDC_SOL = NATIVE_REFS.SOL.quoteAddress;
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
  const put = (d: Uint8Array, o: number, v: bigint, size = 8) => { for (let i = 0; i < size; i++) d[o + i] = Number((v >> BigInt(8 * i)) & 0xffn); };
  const mintAcc = (dec: number, supply: bigint) => { const d = new Uint8Array(82); put(d, 36, supply); d[44] = dec; return `tok|${b64(d)}`; };
  const tokenAcc = (amount: bigint) => { const d = new Uint8Array(165); put(d, 64, amount); return `tok|${b64(d)}`; };
  const bs = (k: string) => { const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of k) n = n * 58n + BigInt(ALPHABET.indexOf(c)); const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
  /** SOL/USDC reference: a Raydium v4 pool holding 1000 SOL and 150000 USDC */
  const solRef = () => {
    const d = new Uint8Array(752); put(d, 32, 9n); put(d, 40, 6n); d.set(K(21), 336); d.set(K(22), 368); d.set(bs(SOL), 400); d.set(bs(USDC_SOL), 432);
    return { [NATIVE_REFS.SOL.pairAddress]: `${PROGRAMS.raydiumV4}|${b64(d)}`, [base58(K(21))]: tokenAcc(1000n * 10n ** 9n), [base58(K(22))]: tokenAcc(150_000n * 10n ** 6n) };
  };
  it('PumpSwap: vault balances, SOL priced through its reference pool, supply from the mint', async () => {
    const pool = new Uint8Array(301); pool.set(bs(MINT), 43); pool.set(bs(SOL), 75); pool.set(K(1), 139); pool.set(K(2), 171);
    const { fetchImpl } = evmNode({
      'https://solana': {
        ...solRef(),
        Pool111: `${PROGRAMS.pumpswap}|${b64(pool)}`,
        [base58(K(1))]: tokenAcc(500_000_000n * 10n ** 6n), // 500M tokens
        [base58(K(2))]: tokenAcc(100n * 10n ** 9n), // 100 SOL → 2e-7 SOL each
        [MINT]: mintAcc(6, 1_000_000_000n * 10n ** 6n),
        [SOL]: mintAcc(9, 0n),
      },
    });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ address: MINT, network: 'solana', dex: 'pumpswap', pairAddress: 'Pool111', quoteSymbol: 'SOL', quoteAddress: SOL, priceUsd: undefined, marketCap: undefined })]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(2e-7 * 150, 9);
    expect(apply.mock.calls[0][1].marketCap).toBeCloseTo(2e-7 * 150 * 1e9, 3);
    expect(pricer.quotes()[NATIVE_REFS.SOL.key]).toBeCloseTo(150, 6);
    expect(pricer.status().solana.live).toBe(2);
  });
  it('Orca whirlpool: sqrt price in the account, the quote mint learned from the pool, USDC a dollar', async () => {
    const pool = new Uint8Array(653); pool.set(bs(MINT), 101); pool.set(bs(USDC_SOL), 181); put(pool, 65, 2n ** 64n * 2n, 16); // token1/token0 raw = 4
    const { fetchImpl } = evmNode({ 'https://solana': { Whirl111: `${PROGRAMS.orca}|${b64(pool)}`, [MINT]: mintAcc(6, 10n ** 15n), [USDC_SOL]: mintAcc(6, 0n) } });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([token({ address: MINT, network: 'solana', dex: 'orca', pairAddress: 'Whirl111', quoteSymbol: 'WRONG', quoteAddress: 'Other', priceUsd: undefined, marketCap: undefined })]);
    expect(apply.mock.calls[0][1]).toMatchObject({ priceUsd: 4, marketCap: 4e9 });
  });
  it('a pump.fun curve raised in another token is priced in that token, through its own pool', async () => {
    const SPCX = base58(K(40)), SPOOL = 'SpcxPool1';
    const curve = new Uint8Array(151); put(curve, 8, 1_000_000_000_000_000n); put(curve, 16, 30_000_000n); put(curve, 40, 1_000_000_000_000_000n); // 1e9 tokens vs 30 SPCX (6 dec) → 3e-8 SPCX each
    const spcxPool = new Uint8Array(653); spcxPool.set(bs(SPCX), 101); spcxPool.set(bs(USDC_SOL), 181); put(spcxPool, 65, 2n ** 64n * 10n, 16); // 100 USDC per SPCX
    const { fetchImpl } = evmNode({ 'https://solana': { Curve9: `${PROGRAMS.pumpfun}|${b64(curve)}`, [SPOOL]: `${PROGRAMS.orca}|${b64(spcxPool)}`, [SPCX]: mintAcc(6, 0n), [USDC_SOL]: mintAcc(6, 0n) } });
    const discover = vi.fn(async () => ({ symbol: 'SPCX', pairAddress: SPOOL, quoteSymbol: 'USDC', quoteAddress: USDC_SOL, dex: 'orca' }));
    const { pricer, apply } = deps(fetchImpl, { discover });
    const t = token({ address: 'M9', network: 'solana', dex: 'pumpfun', pairAddress: 'Curve9', quoteSymbol: 'SPCX', quoteAddress: SPCX, priceUsd: undefined, marketCap: undefined });
    await pricer.refresh([t]);
    await new Promise((r) => setImmediate(r));
    await pricer.refresh([t]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1].priceUsd).toBeCloseTo(3e-8 * 100, 12);
    expect(apply.mock.calls[0][1].marketCap).toBeCloseTo(3e-6 * 1e9, 6);
  });
  it('an unsupported program, a graduated pump.fun curve and a missing account are skipped with reasons', async () => {
    const curve = new Uint8Array(151); put(curve, 8, 1n); put(curve, 16, 1n); curve[48] = 1;
    const { fetchImpl } = evmNode({ 'https://solana': { Curve1: `${PROGRAMS.pumpfun}|${b64(curve)}`, Odd1: `SomeProgram111|${b64(new Uint8Array(50))}` } });
    const { pricer, apply } = deps(fetchImpl);
    await pricer.refresh([
      token({ address: 'M1', network: 'solana', dex: 'pumpfun', pairAddress: 'Curve1', quoteSymbol: 'SOL' }),
      token({ address: 'M2', network: 'solana', dex: 'weird', pairAddress: 'Odd1', quoteSymbol: 'SOL' }),
      token({ address: 'M3', network: 'solana', dex: 'raydium', pairAddress: 'Gone1', quoteSymbol: 'SOL' }),
    ]);
    expect(apply).not.toHaveBeenCalled();
    expect(pricer.reason('solana', 'M1')).toMatch(/graduated/);
    expect(pricer.reason('solana', 'M2')).toMatch(/weird pool program is not supported/);
    expect(pricer.reason('solana', 'M3')).toBe('pool account not found');
  });
});

describe('live pricer: screens', () => {
  it('visible() is the union of what every client reported in the last half minute', () => {
    let clock = 1_000_000;
    const { pricer } = deps(vi.fn(), { now: () => clock });
    pricer.setVisible('a', ['x', 'y']);
    pricer.setVisible('b', ['y', 'z']);
    expect([...pricer.visible()].sort()).toEqual(['x', 'y', 'z']);
    clock += 31_000;
    pricer.setVisible('b', ['z']);
    expect([...pricer.visible()]).toEqual(['z']);
  });
});
