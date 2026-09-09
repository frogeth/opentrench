import { useMemo, useRef, useState } from 'react';
import type { FeedMessage, TokenInfo } from '../types';
import { MessageRow } from './MessageRow';

export function Feed({ messages, tokens }: { messages: FeedMessage[]; tokens: Record<string, TokenInfo> }) {
  const [filter, setFilter] = useState('');
  const [onlyContracts, setOnlyContracts] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [showRepeats, setShowRepeats] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return messages.filter((m) => {
      if (!showBots && m.isBot) return false;
      if (!showRepeats && m.repeat) return false;
      if (onlyContracts && m.contracts.length === 0) return false;
      if (!q) return true;
      const tok = m.contracts.map((c) => tokens[c.address]).filter(Boolean);
      return (
        m.text.toLowerCase().includes(q) ||
        m.author.toLowerCase().includes(q) ||
        m.chatName.toLowerCase().includes(q) ||
        tok.some((t) => (t.symbol ?? '').toLowerCase().includes(q) || (t.name ?? '').toLowerCase().includes(q))
      );
    });
  }, [messages, tokens, filter, onlyContracts, showBots, showRepeats]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) setAtTop(el.scrollTop < 40);
  };
  const toTop = () => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="feed">
      <div className="feed-bar">
        <input placeholder="filter text, author, chat, ticker…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          <input type="checkbox" checked={onlyContracts} onChange={(e) => setOnlyContracts(e.target.checked)} />{' '}
          contracts only
        </label>
        <label>
          <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} /> show bots
        </label>
        <label>
          <input type="checkbox" checked={showRepeats} onChange={(e) => setShowRepeats(e.target.checked)} /> show
          repeats
        </label>
        <span className="count">{shown.length}</span>
      </div>
      <div className="feed-list" ref={listRef} onScroll={onScroll}>
        {shown.length === 0 && <div className="empty">No messages yet. Pick channels in settings (⚙).</div>}
        {shown.map((m) => (
          <MessageRow key={m.id} m={m} tokens={tokens} />
        ))}
      </div>
      {!atTop && (
        <button className="jump" onClick={toTop}>
          ↑ latest
        </button>
      )}
    </div>
  );
}
