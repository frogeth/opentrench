import { describe, it, expect } from 'vitest';
import { buildBasedBotLinks, cleanReferral } from './basedbot.js';

describe('basedbot', () => {
  it('builds the r_<ref>_b_<mint> deep link and the web app link', () => {
    const l = buildBasedBotLinks('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'frog');
    expect(l.provider).toBe('basedbot');
    expect(l.amounts).toEqual([]);
    expect(l.panel).toBe('https://t.me/based_eth_bot?start=r_frog_b_DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(l.web).toBe('https://basedbot.app/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?ref=frog');
  });
  it('falls back to the app referral and strips junk from a pasted one', () => {
    expect(cleanReferral(undefined)).toBe('frog');
    expect(cleanReferral('')).toBe('frog');
    expect(cleanReferral('r_frog')).toBe('frog');       // pasted the whole start payload
    expect(cleanReferral('my code!!')).toBe('mycode');
    expect(buildBasedBotLinks('0xabc', '').panel).toContain('start=r_frog_b_0xabc');
  });
});
