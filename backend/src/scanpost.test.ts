import { describe, expect, it } from 'vitest';
import { isScanPost, parseScanFigures, scanSubjects, contractsOf, looksLikeScan } from './scanpost.js';

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


describe('a scanner card counts only its subject', () => {
  const TOKEN = '0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0';
  const PAIR = '0x9ca00d16ad7fdb673dc8faeb0bfb523a5685e102';
  const rick = `**[Hoodlight](https://dexscreener.com/robinhood/${PAIR}) [40.4K/45.8%] - HDLT/WETH**
Robinhood @ Uniswap V3
💰 USD: \`0.000040400\`
💎 FDV: \`40.4K\` ➡︎ \`1.7M\`
[👥](https://t.me/rick?start=nh_${TOKEN}) TH: [3.3](https://robin.etherscan.io/address/0xb5982a9431f3e47dd6f5010a1a54bb6980630e10)⋅[3.2](https://robin.etherscan.io/address/0x08076111d982cf46c77a0401d48c6580a33db952) \`[22%]\`
Chart: [DEX](https://dexscreener.com/robinhood/${PAIR}) ⋅ [DEF](https://defined.fi/token/robinhood/${TOKEN}?ref=RICK)
More: [BM](https://t.me/RickBurpBot/bmapp?startapp=${TOKEN}_robinhood_def)

\`${TOKEN}\``;
  it('Rick: the bare address is the subject; the pair and the holder wallets are not tokens', () => {
    expect(looksLikeScan(rick)).toBe(true);
    expect(scanSubjects(rick)).toEqual([TOKEN.toLowerCase()]);
    expect(contractsOf(rick, true).map((c) => c.address)).toEqual([TOKEN.toLowerCase()]);
    // a mirror relaying the card as a person's message is still a scanner card
    expect(contractsOf(rick, false).map((c) => c.address)).toEqual([TOKEN.toLowerCase()]);
  });
  it('a Solana card whose address only lives in the bot links still settles on it', () => {
    const sol = `🟠 xPad [19.5K/-45.5%] - xPad/SOL\nSolana @ Pump\n💎 FDV: 19.5K\nMAE·[BLO](https://t.me/BloomSolana_bot?start=ref_C2UUGLeLQfkAU3NZMNJvXHZwuMXW45G9XQVoGgzQpump)·[MAE](https://t.me/maestro?start=C2UUGLeLQfkAU3NZMNJvXHZwuMXW45G9XQVoGgzQpump-rick)`;
    expect(scanSubjects(sol)).toEqual(['C2UUGLeLQfkAU3NZMNJvXHZwuMXW45G9XQVoGgzQpump']);
  });
  it('a person listing several contracts keeps them all; a card that names nothing bare keeps all too', () => {
    const two = `two plays: ${TOKEN} and ${PAIR}`;
    expect(contractsOf(two, false)).toHaveLength(2);
    expect(contractsOf(`[x](https://a.b/${TOKEN}) [y](https://a.b/${PAIR}) FDV: 1K`, true)).toHaveLength(2);
  });
});
