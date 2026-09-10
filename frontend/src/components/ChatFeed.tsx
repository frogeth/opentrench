import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FeedMessage, TokenInfo } from '../types';
import type { ChartProvider } from '../format';
import { MessageRow } from './MessageRow';
import { VirtualItem } from './Virtual';

/** Discord-style grouping: hide the header when the message just above (in display order) is the same author within 5 min. */
export function continued(list: FeedMessage[], i: number): boolean {
  const above = list[i - 1];
  const m = list[i];
  return !!above && above.author === m.author && above.chatName === m.chatName && Math.abs(above.ts - m.ts) < 5 * 60_000 && !m.replyTo;
}

/**
 * The scrolling part of a chat column: sticks to the reading end, offers
 * "↓ latest" when you scroll away, groups consecutive messages Discord-style.
 * Each column owns its own scroll state, so several can live side by side.
 */
export function ChatFeed({
  msgs,
  order,
  tokens,
  favorites,
  discord,
  autoChart,
  compactEmbeds,
  chartProvider,
  onSelect,
  onAuthorChanged,
  head,
  empty,
  render,
  onReply,
  onReveal,
}: {
  /** chronological (oldest first) */
  msgs: FeedMessage[];
  order: 'bottom' | 'top';
  tokens: Record<string, TokenInfo>;
  favorites: string[];
  discord?: boolean;
  autoChart: boolean;
  compactEmbeds: boolean;
  chartProvider: ChartProvider;
  onSelect: (address: string) => void;
  onAuthorChanged: () => void;
  head?: ReactNode;
  empty?: ReactNode;
  /** renders the column chrome around the body */
  render: (body: ReactNode, bodyRef: React.RefObject<HTMLDivElement>, onScroll: () => void, footer: ReactNode) => ReactNode;
  onReply?: (m: FeedMessage) => void;
  /** make a hidden/filtered message visible in this column; returns false if it is not in the buffer at all */
  onReveal?: (id: string) => boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const shown = useMemo(() => (order === 'bottom' ? [...msgs].reverse() : msgs), [msgs, order]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setAtEnd(order === 'bottom' ? el.scrollHeight - el.scrollTop - el.clientHeight < 60 : el.scrollTop < 60);
  };
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !atEnd) return;
    el.scrollTop = order === 'bottom' ? el.scrollHeight : 0;
  }, [shown, order, atEnd]);
  const jumpTo = (id: string | undefined, fallback: string | undefined) => {
    const open = () => fallback && window.open(fallback, '_blank', 'noopener');
    if (!id) return open();
    const inBuffer = onReveal ? onReveal(id) : true;
    if (!inBuffer) return open();
    let tries = 0;
    const find = () => {
      const el = bodyRef.current?.querySelector(`[data-key="${CSS.escape(id)}"]`) as HTMLElement | null;
      if (el) {
        setAtEnd(false);
        // instant, and again once the rows around it have mounted and settled their heights
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'auto' }), 350);
        el.classList.add('vitem-flash');
        window.setTimeout(() => el.classList.remove('vitem-flash'), 2400);
      } else if (tries++ < 10) window.setTimeout(find, 60);
      else open();
    };
    window.setTimeout(find, 30);
  };
  const jump = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: order === 'bottom' ? el.scrollHeight : 0, behavior: 'smooth' });
    setAtEnd(true);
  };
  const body = (
    <>
      {head}
      {shown.length === 0 && empty}
      {shown.map((m, i) => (
        <VirtualItem key={m.id} id={`msg:${m.id}`} domKey={m.id} estimate={m.contracts.length ? 140 : 52}>
        <MessageRow
          m={m}
          tokens={tokens}
          onSelect={onSelect}
          favorites={favorites}
          continued={continued(shown, i)}
          discord={!!discord}
          autoChart={autoChart}
          compactEmbeds={compactEmbeds}
          chartProvider={chartProvider}
          onAuthorChanged={onAuthorChanged}
          onReply={onReply}
          onJump={jumpTo}
        />
        </VirtualItem>
      ))}
    </>
  );
  const footer = !atEnd && (
    <button className="jump" onClick={jump}>
      {order === 'bottom' ? '↓' : '↑'} latest
    </button>
  );
  return <>{render(body, bodyRef, onScroll, footer)}</>;
}
