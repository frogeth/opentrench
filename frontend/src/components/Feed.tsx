import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedMessage } from '../types';
import { MessageRow } from './MessageRow';

export function Feed({ messages }: { messages: FeedMessage[] }) {
  const [filter, setFilter] = useState('');
  const [onlyContracts, setOnlyContracts] = useState(false);
  const [stick, setStick] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return messages.filter((m) => {
      if (onlyContracts && m.contracts.length === 0) return false;
      if (!q) return true;
      return (
        m.text.toLowerCase().includes(q) ||
        m.author.toLowerCase().includes(q) ||
        m.chatName.toLowerCase().includes(q)
      );
    });
  }, [messages, filter, onlyContracts]);

  useEffect(() => {
    if (stick && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [shown, stick]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div className="feed">
      <div className="feed-bar">
        <input placeholder="filter text, author, chat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          <input type="checkbox" checked={onlyContracts} onChange={(e) => setOnlyContracts(e.target.checked)} />{' '}
          contracts only
        </label>
        <span className="count">{shown.length}</span>
      </div>
      <div className="feed-list" ref={listRef} onScroll={onScroll}>
        {shown.length === 0 && <div className="empty">No messages yet. Pick channels in settings (⚙).</div>}
        {shown.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
      </div>
      {!stick && (
        <button className="jump" onClick={() => setStick(true)}>
          ↓ latest
        </button>
      )}
    </div>
  );
}
