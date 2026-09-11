import { describe, it, expect } from 'vitest';
import { BASEDBOT_REFERRAL, buildBasedBotLinks } from './basedbot.js';

describe('basedbot', () => {
  it("builds the r_<ref>_b_<mint> deep link and the web app link with opentrench's own referral", () => {
    expect(BASEDBOT_REFERRAL).toBe('frog');
    const l = buildBasedBotLinks('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(l.provider).toBe('basedbot');
    expect(l.amounts).toEqual([]);
    expect(l.panel).toBe('https://t.me/based_eth_bot?start=r_frog_b_DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(l.web).toBe('https://basedbot.app/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?ref=frog');
  });
});
