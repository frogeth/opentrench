import { describe, expect, it } from 'vitest';
import { isScanPost, parseScanFigures } from './scanpost.js';

const RICK = `🔍 HUH CAT [35.1K/-13%] $HUHCAT
🌐 Solana @ Meteora DBC
💰 USD: 0.00003513
💎 FDV: 35.1K ⇨ 54.3K [45m]
💦 Liq: 7.9K [x4]
📊 Vol: 190K · Age: 6h
👀 You are first @ 35.1K 👀 343`;

describe('scanner posts', () => {
  it('reads Rick: header market cap, and "you are first"', () => {
    expect(parseScanFigures(RICK)).toEqual({ marketCap: 35_100, firstAt: 35_100 });
  });
  it('reads MC / FDV / Mcap lines with $, commas and suffixes', () => {
    expect(parseScanFigures('TokenScan · MC: $1,234,567 · Liq $50K').marketCap).toBe(1_234_567);
    expect(parseScanFigures('Mcap $45.6K').marketCap).toBeCloseTo(45_600, 3);
    expect(parseScanFigures('FDV: 2.5M').marketCap).toBe(2_500_000);
    expect(parseScanFigures('Market Cap: $980').marketCap).toBe(980);
    expect(parseScanFigures('nothing here')).toEqual({});
  });
  it('only a bot post that names a contract counts', () => {
    expect(isScanPost({ isBot: true, contracts: [{ chain: 'sol', address: 'x' }], text: RICK })).toBeTruthy();
    expect(isScanPost({ isBot: false, contracts: [{ chain: 'sol', address: 'x' }], text: RICK })).toBeUndefined();
    expect(isScanPost({ isBot: true, contracts: [], text: RICK })).toBeUndefined();
    expect(isScanPost({ isBot: true, contracts: [{ chain: 'sol', address: 'x' }], text: 'gm' })).toBeUndefined();
  });
});
