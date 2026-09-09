import { describe, expect, it } from 'vitest';
import { GOPLUS_CHAINS, createSecurityFetcher, mapGoPlus, mapRugCheck } from './security.js';

describe('security', () => {
  it('maps a GoPlus result: top 10 excludes pools/lockers, dev % and sold flag, taxes', () => {
    const sec = mapGoPlus(
      {
        holder_count: '1532',
        creator_percent: '0.000000',
        creator_balance: '0',
        buy_tax: '0.01',
        sell_tax: '0.01',
        is_honeypot: '0',
        holders: [
          { address: '0xpool', percent: '0.40', is_contract: 1, is_locked: 0 },
          { address: '0xa', percent: '0.12', is_contract: 0, is_locked: 0 },
          { address: '0xb', percent: '0.05', is_contract: 0, is_locked: 0 },
          { address: '0xlock', percent: '0.30', is_contract: 0, is_locked: 1 },
        ],
        lp_holders: [{ address: '0xdead', percent: '0.9', is_locked: 1 }],
      },
      5,
    );
    expect(sec).toEqual({
      source: 'goplus',
      fetchedAt: 5,
      holders: 1532,
      top10Pct: 17,
      devPct: 0,
      devSold: true,
      lpLockedPct: 90,
      buyTax: 1,
      sellTax: 1,
      honeypot: false,
    });
  });

  it('maps a RugCheck report: pools excluded, insiders summed, dev from creator balance', () => {
    const sec = mapRugCheck(
      {
        totalHolders: 308,
        score_normalised: 12,
        mintAuthority: null,
        freezeAuthority: null,
        creatorBalance: 50,
        token: { supply: 1000 },
        knownAccounts: { RAY: { type: 'AMM', name: 'Raydium' } },
        topHolders: [
          { address: 'RAY', pct: 40, insider: false },
          { address: 'w1', pct: 10, insider: true },
          { address: 'w2', pct: 7.25, insider: false },
        ],
        markets: [{ lp: { lpLockedPct: 100 } }],
      },
      7,
    );
    expect(sec).toEqual({
      source: 'rugcheck',
      fetchedAt: 7,
      holders: 308,
      top10Pct: 17.3,
      devPct: 5,
      devSold: false,
      insidersPct: 10,
      lpLockedPct: 100,
      mintable: false,
      freezable: false,
      score: 12,
    });
  });

  it('routes solana to rugcheck, known evm chains to goplus, others to nothing', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => (url.includes('rugcheck') ? { totalHolders: 1 } : { result: { '0xabc': { holder_count: '2' } } }) };
    }) as unknown as typeof fetch;
    const f = createSecurityFetcher(fetchImpl);
    expect((await f('solana', 'Mint'))?.holders).toBe(1);
    expect((await f('base', '0xABC'))?.holders).toBe(2);
    expect(await f('robinhood', '0xabc')).toBeUndefined();
    expect(calls).toEqual([
      'https://api.rugcheck.xyz/v1/tokens/Mint/report',
      `https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAINS.base}?contract_addresses=0xabc`,
    ]);
  });
});
