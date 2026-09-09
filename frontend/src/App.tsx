import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeed } from './useFeed';
import { Column } from './components/Column';
import { CallCard } from './components/CallCard';
import { MessageRow } from './components/MessageRow';
import { Settings } from './components/Settings';
import { Browser } from './components/Browser';
import { Logo } from './components/Logo';
import { Avatar } from './components/Avatar';
import { api, type WatchedChat } from './api';
import { beep } from './format';
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

type Panel = { kind: 'settings' } | { kind: 'browser'; source: Source } | null;

export default function App() {
  const { messages, tokens, status, wsOpen, ping } = useFeed();
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState('');
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [showBots, setShowBots] = useState(false);
  const [showRepeats, setShowRepeats] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [watched, setWatched] = useState<WatchedChat[]>([]);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [notify, setNotify] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem('trenchfeed.sound') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!ping) return;
    const label = ping.token.symbol ? `$${ping.token.symbol}` : ping.token.address.slice(0, 8);
    if (sound) beep();
    if (notify === 'granted') {
      try {
        const n = new Notification(`👑 ${ping.msg.author} called ${label}`, {
          body: `${ping.msg.chatName}\n${ping.token.address}`,
          icon: ping.token.imageUrl ?? ping.msg.avatar,
          tag: ping.token.address,
        });
        n.onclick = () => {
          window.focus();
          setSelected(ping.token.address);
          n.close();
        };
      } catch {
        /* notifications unavailable */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ping]);
  const askNotify = () => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      const next = !sound;
      setSound(next);
      try {
        localStorage.setItem('trenchfeed.sound', next ? 'on' : 'off');
      } catch {
        /* ignore */
      }
      return;
    }
    void Notification.requestPermission().then(setNotify);
  };

  useEffect(() => {
    api.watched().then(setWatched).catch(() => {});
  }, [status.discord, status.telegram, panel]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!selected) return;
    document.getElementById(`call-${selected}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = window.setTimeout(() => setSelected(null), 2500);
    return () => window.clearTimeout(t);
  }, [selected]);

  const q = query.trim().toLowerCase();
  const errors = Object.entries(status.error) as [keyof Status['error'], string][];

  const chats = useMemo(() => {
    const m = new Map<string, { count: number; source: Source; avatar?: string }>();
    for (const w of watched) m.set(w.name, { count: 0, source: w.source, avatar: w.avatar });
    for (const msg of messages) {
      const e = m.get(msg.chatName) ?? { count: 0, source: msg.source, avatar: msg.chatAvatar };
      e.count++;
      if (!e.avatar && msg.chatAvatar) e.avatar = msg.chatAvatar;
      m.set(msg.chatName, e);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  }, [messages, watched]);

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

  const calls = useMemo(
    () =>
      Object.values(tokens)
        .filter((t) => (!chatFilter || t.calledIn.includes(chatFilter)) && tokenMatches(q, t))
        .sort((a, b) => (b.lastCallTs ?? b.firstSeenTs) - (a.lastCallTs ?? a.firstSeenTs)),
    [tokens, q, chatFilter],
  );

  const select = (address: string) => {
    if (!tokens[address]) return;
    if (chatFilter && !tokens[address].calledIn.includes(chatFilter)) setChatFilter(null);
    if (q && !tokenMatches(q, tokens[address])) setQuery('');
    setSelected(address);
  };

  const togglePanel = (next: Panel) =>
    setPanel((p) => (p && next && JSON.stringify(p) === JSON.stringify(next) ? null : next));

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
        <button
          className={`gear bell${notify === 'granted' ? ' on' : ''}`}
          onClick={askNotify}
          title={
            notify === 'granted'
              ? `pings on · sound ${sound ? 'on' : 'off'} (click to toggle sound)`
              : 'enable desktop pings for favorite callers'
          }
        >
          {notify === 'granted' ? (sound ? '🔔' : '🔕') : '🔔'}
          {notify !== 'granted' && <span className="bell-off">off</span>}
        </button>
        <button className="gear" onClick={() => togglePanel({ kind: 'settings' })} title="settings">
          ⚙
        </button>
      </header>
      <div
        className="tabs"
        ref={tabsRef}
        onWheel={(e) => {
          if (tabsRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) tabsRef.current.scrollLeft += e.deltaY;
        }}
      >
        <button
          className={`tab tab-source${panel?.kind === 'browser' && panel.source === 'discord' ? ' active' : ''}`}
          onClick={() => togglePanel({ kind: 'browser', source: 'discord' })}
          title="browse Discord servers"
        >
          <Logo source="discord" size={14} />
        </button>
        <button
          className={`tab tab-source${panel?.kind === 'browser' && panel.source === 'telegram' ? ' active' : ''}`}
          onClick={() => togglePanel({ kind: 'browser', source: 'telegram' })}
          title="browse Telegram chats"
        >
          <Logo source="telegram" size={14} />
        </button>
        <span className="tab-sep" />
        <button className={`tab${chatFilter === null ? ' active' : ''}`} onClick={() => setChatFilter(null)}>
          All
        </button>
        {chats.map(([name, { count, source, avatar }]) => (
          <button
            key={name}
            className={`tab${chatFilter === name ? ' active' : ''}`}
            onClick={() => setChatFilter(chatFilter === name ? null : name)}
            title={name}
          >
            {avatar ? <Avatar src={avatar} name={name} size={16} /> : <Logo source={source} size={11} />}
            <span className="tab-name">{name}</span>
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="banner" onClick={() => setPanel({ kind: 'settings' })}>
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
            <CallCard key={t.address} t={t} now={now} selected={selected === t.address} favorites={status.favorites} />
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
          {chatMsgs.length === 0 && (
            <div className="empty">No messages yet. Use the Discord / Telegram buttons above to add chats.</div>
          )}
          {chatMsgs.map((m) => (
            <MessageRow key={m.id} m={m} tokens={tokens} onSelect={select} favorites={status.favorites} />
          ))}
        </Column>
        {panel?.kind === 'settings' && <Settings status={status} onClose={() => setPanel(null)} />}
        {panel?.kind === 'browser' && <Browser source={panel.source} onClose={() => setPanel(null)} />}
      </main>
    </div>
  );
}
