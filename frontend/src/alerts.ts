import type { ColumnDef, ColumnFilters } from './api';
import type { FeedMessage, TokenInfo } from './types';
import { messagePasses, tokenPasses } from './filters';

/** The bits of a column that decide whether it announces a call. */
export interface AlertColumn {
  type: ColumnDef['type'];
  alert?: ColumnDef['alert'];
  filters?: ColumnFilters;
  /** watched chat names this column carries; null = every chat */
  names: Set<string> | null;
}

/** Calls older than this never announce, however late their token data arrives. */
export const ALERT_WINDOW_MS = 60_000;

/**
 * Which sound, if any, a fresh call should play right now: the first column whose bell is on,
 * that carries the message's chat, and that would actually show it. A calls column shows a call
 * only when its token passes the column's filters and is not hidden; a chat column when the
 * message passes its filters. Other column types never announce calls.
 */
export function alertSound(
  m: FeedMessage,
  tokens: Record<string, TokenInfo>,
  cols: AlertColumn[],
  opts: { inScope: (chatName: string, names: Set<string> | null) => boolean; hidden: Set<string>; now: number },
): string | null {
  if (m.hidden || m.repeat || m.contracts.length === 0 || opts.now - m.ts > ALERT_WINDOW_MS) return null;
  for (const col of cols) {
    if (!col.alert?.on || (col.type !== 'chat' && col.type !== 'calls') || !opts.inScope(m.chatName, col.names)) continue;
    if (col.type === 'chat') {
      if (messagePasses(m, col.filters)) return col.alert.sound;
      continue;
    }
    const shown = m.contracts.some((c) => {
      const t = tokens[c.address];
      return !!t && !opts.hidden.has(t.address) && tokenPasses(t, col.filters, opts.now);
    });
    if (shown) return col.alert.sound;
  }
  return null;
}
