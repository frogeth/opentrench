import type { ColumnDef } from './config.js';
import { COVE_BOT } from './cove.js';
import { BASEDBOT } from './basedbot.js';

export const SALPHA_BOT = 'salpha_research_bot';

/**
 * The bots (lowercase usernames) whose column has its bell on: every new message from one of
 * them lands in Pings. A Telegram bot column names its bot; the buy column shows whichever buy
 * bot is picked; an old-style Salpha column is @salpha_research_bot.
 */
export function alertBots(columns: ColumnDef[], provider: 'cove' | 'basedbot'): Set<string> {
  const out = new Set<string>();
  for (const c of columns.flatMap((c) => (c.split ? [c, c.split.bottom] : [c]))) {
    if (!c.alert?.on) continue;
    const bot = c.type === 'tgbot' ? c.bot : c.type === 'cove' ? (provider === 'basedbot' ? BASEDBOT : COVE_BOT) : c.type === 'salpha' ? SALPHA_BOT : undefined;
    if (bot) out.add(bot.replace(/^@/, '').toLowerCase());
  }
  return out;
}
