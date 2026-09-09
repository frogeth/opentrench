import { useEffect, useMemo, useState } from 'react';
import { useFeed } from './useFeed';
import { Column } from './components/Column';
import { CallCard } from './components/CallCard';
import { MessageRow } from './components/MessageRow';
import { Settings } from './components/Settings';
import { Logo } from './components/Logo';
import { api, type WatchedChat } from './api';
import type { FeedMessage, Source, Status, TokenInfo } from './types';

function Pill({ label, state }: { label: string; state: string }) {
  return (
    <span className={`pill pill-${state}`}>
      {label}: {state.replace('_', ' ')}
    </span>
  );
}

function matchesQuery(q: string, m: FeedMessage, tokens: Record<string, TokenInfo>): boolean {
  if (!q) return true;
  if (m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q) || m.chatName.toLowerCase().includes(q))
    return true;
  return m.contracts.some((c) => {
    const t = tokens[c.address];
    return c.address.toLowerCase().includes(q) || (t?.symbol ?? '').toLowerCase().includes(q) || (t?.name ?? '').toLowerCase().includes(q);
  });
}

function tokenMatches(q: string, t: TokenInfo): boolean {
  if (!q) return true;
  return (
    t.address.toLowerCase().includes(q) ||
    (t.symbol ?? '').toLowerCase().includes(q) ||
    (t.name ?? '').toLowerCase().includes(q) ||
    (t.firstCaller?.author ?? '').toLowerCase().includes(q) ||
    t.calledIn.some((c) => c.toLowerCase().includes(q))
  );
}

export default function App() {
  const { messages, tokens, status, wsOpen } = useFeed();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [showBots, setShowBots] = useState(false);
  const [showRepeats, setShowRepeats] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [watched, setWatched] = useState<WatchedChat[]>([]);
  useEffect(() => {
    api.watched().then(setWatched).catch(() => {});
  }, [status.discord, status.telegram]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const q = query.trim().toLowerCase();
  const errors = Object.entries(status.error) as [keyof Status['error'], string][];

  const chats = useMemo(() => {
    const m = new Map<string, { count: number; source: Source }>();
    for (const w of watched) m.set(w.name, { count: 0, source: w.source });
    for (const msg of messages) {
      const e = m.get(msg.chatName) ?? { count: 0, source: msg.source };
      e.count++;
      m.set(msg.chatName, e);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  }, [messages, watched]);

  const callers = useMemo(() => {
    const s = new Set<string>();
    for (const m of messages) if (m.contracts.length && !m.repeat && !m.isBot) s.add(`${m.source}:${m.author}`);
    return s;
  }, [messages]);

  const chatMsgs = useMemo(
    () =>
      messages.filter(
        (m) =>
          (showBots || !m.isBot) &&
          (showRepeats || !m.repeat) &&
          (!chatFilter || m.chatName === chatFilter) &&
          matchesQuery(q, m, tokens),
      ),
    [messages, tokens, q, chatFilter, showBots, showRepeats],
  );

  const callerMsgs = useMemo(
    () =>
      messages.filter(
        (m) =>
          !m.isBot &&
          callers.has(`${m.source}:${m.author}`) &&
          (!chatFilter || m.chatName === chatFilter) &&
          matchesQuery(q, m, tokens),
      ),
    [messages, tokens, callers, q, chatFilter],
  );

  const calls = useMemo(
    () =>
      Object.values(tokens)
        .filter((t) => (!chatFilter || t.calledIn.includes(chatFilter)) && tokenMatches(q, t))
        .sort((a, b) => b.firstSeenTs - a.firstSeenTs),
    [tokens, q, chatFilter],
  );

  return (
    <div className="app">
      <header className="top">
        <div className="brand">trenchfeed</div>
        <input
          className="search"
          placeholder="Search tokens, CA, callers, chats…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="pills">
          <Pill label="discord" state={status.discord} />
          <Pill label="telegram" state={status.telegram} />
          {!wsOpen && <span className="pill pill-disconnected">server: offline</span>}
        </div>
        <button className="gear" onClick={() => setOpen((o) => !o)} title="settings">
          ⚙
        </button>
      </header>
      <div className="tabs">
        <button className={`tab${chatFilter === null ? ' active' : ''}`} onClick={() => setChatFilter(null)}>
          All
        </button>
        {chats.map(([name, { count, source }]) => (
          <button
            key={name}
            className={`tab${chatFilter === name ? ' active' : ''}`}
            onClick={() => setChatFilter(chatFilter === name ? null : name)}
            title={name}
          >
            <Logo source={source} size={11} />
            <span className="tab-name">{name}</span>
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="banner" onClick={() => setOpen(true)}>
          {errors.map(([k, v]) => (
            <div key={k}>
              <b>{k}:</b> {v}
            </div>
          ))}
        </div>
      )}
      <main className="columns">
        <Column title="Calls" count={calls.length} className="col-calls">
          {calls.length === 0 && <div className="empty">No contracts seen yet.</div>}
          {calls.map((t) => (
            <CallCard key={t.address} t={t} now={now} />
          ))}
        </Column>
        <Column
          title="Chats"
          count={chatMsgs.length}
          className="col-chats"
          extra={
            <>
              <label>
                <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} /> bots
              </label>
              <label>
                <input type="checkbox" checked={showRepeats} onChange={(e) => setShowRepeats(e.target.checked)} />{' '}
                repeats
              </label>
            </>
          }
        >
          {chatMsgs.length === 0 && <div className="empty">No messages yet. Pick channels in settings (⚙).</div>}
          {chatMsgs.map((m) => (
            <MessageRow key={m.id} m={m} tokens={tokens} />
          ))}
        </Column>
        <Column title="Callers" count={callerMsgs.length} className="col-callers">
          {callerMsgs.length === 0 && <div className="empty">Messages from people who have posted a CA.</div>}
          {callerMsgs.map((m) => (
            <MessageRow key={m.id} m={m} tokens={tokens} />
          ))}
        </Column>
        {open && <Settings status={status} onClose={() => setOpen(false)} />}
      </main>
    </div>
  );
}
