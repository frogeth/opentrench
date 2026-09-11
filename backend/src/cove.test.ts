import { describe, it, expect } from 'vitest';
import { buildCoveLinks, DEFAULT_COVE_AFFILIATE, encodeAmount, encodeToken, intToBase62 } from './cove.js';

// Reference outputs generated with frogr's encoder (packages/core/dist/links/coveDeepLink.js).
const ETHCAT = '0x777777780838C00038ecD48F63f3C37669322Bc8';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BITCAT = '0xa419Bb493ed5059f28dfd84348A2F93D70ECf003';

describe('cove', () => {
  it('encodes amounts like frogr', () => {
    expect(encodeAmount(50)).toBe('50');
    expect(encodeAmount(9999)).toBe('9999');
    expect(encodeAmount(0.5)).toBe('0d5');
    expect(encodeAmount(2.5)).toBe('2d5');
    expect(() => encodeAmount(10000)).toThrow();
  });

  it('pads base62', () => {
    expect(intToBase62(0n, 7)).toBe('0000000');
    expect(intToBase62(61n, 2)).toBe('0z');
  });

  it('matches frogr for an EVM one-click buy', () => {
    const l = buildCoveLinks('ethereum', ETHCAT, { amounts: [50] })!;
    expect(l.amounts[0].url).toBe('https://t.me/cove_trading_bot?start=g_50eH2qm3h5lJMkSqZ6UFSaqjB59D6u');
  });

  it('matches frogr for a Solana buy with affiliate (group zeroed)', () => {
    const l = buildCoveLinks('solana', BONK, { amounts: [100], affiliateId: '123456789' })!;
    // frogr with groupId -1001234567890 ends in "...M0kX01LY7VK"; we zero the group field.
    expect(l.amounts[0].url).toBe(
      'https://t.me/cove_trading_bot?start=g_100siaRSVwOC5Q7w8fhLkPV0ZTcZS05LOrDfMOAnjmVfyHY008M0kX0000000',
    );
    expect(encodeToken('solana', BONK)).toBe('iaRSVwOC5Q7w8fhLkPV0ZTcZS05LOrDfMOAnjmVfyHY');
  });

  it('matches frogr for the Robinhood market panel and decimal amounts on Base', () => {
    expect(buildCoveLinks('robinhood', BITCAT, { amounts: [] })!.panel).toBe(
      'https://t.me/cove_trading_bot?start=b_rNPhQxSY2YgjwkNHzcydzU9PhZxL',
    );
    expect(buildCoveLinks('base', BITCAT, { amounts: [2.5] })!.amounts[0].url).toBe(
      'https://t.me/cove_trading_bot?start=g_2d5bNPhQxSY2YgjwkNHzcydzU9PhZxL',
    );
  });

  it('covers the chains in Cove\'s published deep-link table', () => {
    const addr = '0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07';
    for (const [net, code] of [['tempo', 't'], ['monad', 'o'], ['story', 'y'], ['hyperevm', 'h'], ['plasma', 'p'], ['megaeth', 'm']]) {
      const l = buildCoveLinks(net, addr, { amounts: [10] });
      expect(l?.panel).toBe(`https://t.me/cove_trading_bot?start=b_${code}${encodeToken(net, addr)}`);
      expect(l?.amounts[0].url).toBe(`https://t.me/cove_trading_bot?start=g_10${code}${encodeToken(net, addr)}`);
    }
  });

  it("credits opentrench's own affiliate by default: 876274588 → base62 '00xIl36' + zeroed group", () => {
    expect(DEFAULT_COVE_AFFILIATE).toBe('876274588');
    expect(intToBase62(BigInt(DEFAULT_COVE_AFFILIATE), 7)).toBe('00xIl36');
    const l = buildCoveLinks('solana', BONK, { amounts: [25], affiliateId: DEFAULT_COVE_AFFILIATE })!;
    expect(l.panel.endsWith('00xIl360000000')).toBe(true);
    expect(l.amounts[0].url.endsWith('00xIl360000000')).toBe(true);
  });

  it('returns undefined for unsupported or unknown chains', () => {
    expect(buildCoveLinks('arbitrum', BITCAT, { amounts: [50] })).toBeUndefined();
    expect(buildCoveLinks(undefined, BITCAT, { amounts: [50] })).toBeUndefined();
  });

  it('drops bad amounts and a bad affiliate id without failing', () => {
    const l = buildCoveLinks('base', BITCAT, { amounts: [50, -1, NaN, 20000], affiliateId: 'abc' })!;
    expect(l.amounts.map((a) => a.usd)).toEqual([50]);
    expect(l.amounts[0].url.endsWith('PhZxL')).toBe(true);
  });
});
