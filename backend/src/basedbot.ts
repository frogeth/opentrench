import type { BuyLinks } from './types.js';

/**
 * BasedBot (t.me/based_eth_bot) deep links, per its developer:
 *   https://t.me/based_eth_bot?start=r_<referral>_b_<mint>   open the token in the bot
 *   https://basedbot.app/token/<mint>?ref=<referral>          the web app
 * The referral is whoever gets credit for the buy; opentrench ships with the app's own.
 */
export const BASEDBOT = 'based_eth_bot';
export const DEFAULT_BASEDBOT_REFERRAL = 'frog';

/** Referral codes are plain identifiers; anything else is dropped so the payload can't be broken. */
export function cleanReferral(ref: string | undefined | null): string {
  const s = String(ref ?? '').trim().replace(/^r_/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  return s || DEFAULT_BASEDBOT_REFERRAL;
}

/** BasedBot has no per-amount links: one button opens the token, the bot asks the amount. */
export function buildBasedBotLinks(address: string, referral?: string): BuyLinks {
  const ref = cleanReferral(referral);
  return {
    provider: 'basedbot',
    amounts: [],
    panel: `https://t.me/${BASEDBOT}?start=r_${ref}_b_${address}`,
    web: `https://basedbot.app/token/${address}?ref=${ref}`,
  };
}
