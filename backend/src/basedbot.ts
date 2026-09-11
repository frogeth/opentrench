import type { BuyLinks } from './types.js';

/**
 * BasedBot (t.me/based_eth_bot) deep links, per its developer:
 *   https://t.me/based_eth_bot?start=r_<referral>_b_<mint>   open the token in the bot
 *   https://basedbot.app/token/<mint>?ref=<referral>          the web app
 * The referral is opentrench's own and is not user-configurable.
 */
export const BASEDBOT = 'based_eth_bot';
export const BASEDBOT_REFERRAL = 'frog';

/** BasedBot has no per-amount links: one button opens the token, the bot asks the amount. */
export function buildBasedBotLinks(address: string): BuyLinks {
  return {
    provider: 'basedbot',
    amounts: [],
    panel: `https://t.me/${BASEDBOT}?start=r_${BASEDBOT_REFERRAL}_b_${address}`,
    web: `https://basedbot.app/token/${address}?ref=${BASEDBOT_REFERRAL}`,
  };
}
