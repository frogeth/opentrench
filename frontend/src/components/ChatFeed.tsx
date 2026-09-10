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
        <VirtualItem key={m.id} id={`msg:${m.id}`} estimate={m.contracts.length ? 140 : 52}>
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
