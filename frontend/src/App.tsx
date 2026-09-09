import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeed } from './useFeed';
import { Column } from './components/Column';
import { CallCard } from './components/CallCard';
import { MessageRow } from './components/MessageRow';
import { Settings } from './components/Settings';
import { ChannelSidebar, discordChatName, type View } from './components/ChannelSidebar';
import { Logo } from './components/Logo';
import { Avatar } from './components/Avatar';
import { api, type DiscordChannel, type MaskedConfig, type TelegramDialog, type WatchedChat } from './api';
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

/** Discord-style grouping: hide the header when the newer message just above is the same author within 5 min. */
function continued(list: FeedMessage[], i: number): boolean {
  const above = list[i - 1];
  const m = list[i];
  return !!above && above.author === m.author && above.chatName === m.chatName && above.ts - m.ts < 5 * 60_000 && !m.replyTo;
}

export default function App() {
  const { messages, tokens, status, wsOpen, ping } = useFeed();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState('');
  const [showBots, setShowBots] = useState(false);
  const [showRepeats, setShowRepeats] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [watched, setWatched] = useState<WatchedChat[]>([]);
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [busy, setBusy] = useState(false);
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

  const reloadLists = () => {
    api.watched().then(setWatched).catch(() => {});
    api.config().then(setCfg).catch(() => {});
  };
  useEffect(reloadLists, [status.discord, status.telegram]);
  useEffect(() => {
    if (status.discord === 'connected') api.discordChannels().then(setChannels).catch(() => {});
  }, [status.discord]);
  useEffect(() => {
    if (status.telegram === 'connected') api.telegramDialogs().then(setDialogs).catch(() => {});
  }, [status.telegram]);
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

  const toggleWatch = async (source: Source, id: string, on: boolean) => {
    if (!cfg) return;
    setBusy(true);
    try {
      const list = source === 'discord' ? cfg.discord.watch : cfg.telegram.watch;
      const next = on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
      if (source === 'discord') await api.setDiscordWatch(next);
      else await api.setTelegramWatch(next);
      if (!on && view?.chat?.id === id) setView({ source: view.source, guildId: view.guildId });
      reloadLists();
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const errors = Object.entries(status.error) as [keyof Status['error'], string][];

  /** Only chats on the watch list exist in the UI; a removed chat disappears with its messages. */
  const chats = useMemo(() => {
    const m = new Map<string, { count: number; source: Source; avatar?: string; id: string }>();
    for (const w of watched) m.set(w.name, { count: 0, source: w.source, avatar: w.avatar, id: w.id });
    for (const msg of messages) {
      const e = m.get(msg.chatName);
      if (!e) continue;
      e.count++;
      if (!e.avatar && msg.chatAvatar) e.avatar = msg.chatAvatar;
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  }, [messages, watched]);
  const chatCounts = useMemo(() => new Map(chats.map(([name, c]) => [name, c.count])), [chats]);
  const watchedNames = useMemo(() => new Set(watched.map((w) => w.name)), [watched]);

  /** Which chat names the current view scopes to (null = everything). */
  const scope = useMemo<Set<string> | null>(() => {
    if (!view) return null;
    if (view.chat) return new Set([view.chat.name]);
    if (view.source === 'discord') {
      const g = view.guildId;
      return new Set(channels.filter((c) => (!g || c.guildId === g) && cfg?.discord.watch.includes(c.id)).map(discordChatName));
    }
    return new Set(watched.filter((w) => w.source === 'telegram').map((w) => w.name));
  }, [view, channels, cfg, watched]);

  const chatMsgs = useMemo(
    () =>
      messages.filter(
        (m) =>
          (showBots || !m.isBot) &&
          (showRepeats || !m.repeat) &&
          (watched.length === 0 || watchedNames.has(m.chatName)) &&
          (!scope || scope.has(m.chatName)) &&
          matchesQuery(q, m, tokens),
      ),
    [messages, tokens, q, scope, showBots, showRepeats, watched.length, watchedNames],
  );

  const calls = useMemo(
    () =>
      Object.values(tokens)
        .filter((t) => (!scope || t.calledIn.some((c) => scope.has(c))) && tokenMatches(q, t))
        .sort((a, b) => (b.lastCallTs ?? b.firstSeenTs) - (a.lastCallTs ?? a.firstSeenTs)),
    [tokens, q, scope],
  );

  const select = (address: string) => {
    if (!tokens[address]) return;
    if (scope && !tokens[address].calledIn.some((c) => scope.has(c))) setView(null);
    if (q && !tokenMatches(q, tokens[address])) setQuery('');
    setSelected(address);
  };

  /** Open the Discord / Telegram layout on the most active watched chat of that source. */
  const openSource = (source: Source) => {
    if (view?.source === source) {
      setView(null);
      return;
    }
    const first = chats.find(([, c]) => c.source === source);
    if (source === 'discord') {
      const ch = first ? channels.find((c) => discordChatName(c) === first[0]) : undefined;
      setView({ source, guildId: ch?.guildId, chat: ch ? { name: discordChatName(ch), id: ch.id } : undefined });
    } else {
      setView({ source, chat: first ? { name: first[0], id: first[1].id } : undefined });
    }
    setSettingsOpen(false);
  };

  const openChat = (name: string, source: Source, id: string) => {
    if (view?.chat?.name === name) {
      setView(null);
      return;
    }
    const ch = source === 'discord' ? channels.find((c) => c.id === id) : undefined;
    setView({ source, guildId: ch?.guildId, chat: { name, id } });
  };

  const title = view?.chat
    ? view.chat.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '')
    : view
      ? view.source === 'discord'
        ? 'Server'
        : 'Telegram'
      : 'Chats';

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
        <button className="gear" onClick={() => setSettingsOpen((o) => !o)} title="settings">
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
          className={`tab tab-source${view?.source === 'discord' ? ' active' : ''}`}
          onClick={() => openSource('discord')}
          title="Discord view"
        >
          <Logo source="discord" size={14} />
        </button>
        <button
          className={`tab tab-source${view?.source === 'telegram' ? ' active' : ''}`}
          onClick={() => openSource('telegram')}
          title="Telegram view"
        >
          <Logo source="telegram" size={14} />
        </button>
        <span className="tab-sep" />
        <button className={`tab${view === null ? ' active' : ''}`} onClick={() => setView(null)}>
          All
        </button>
        {chats.map(([name, { count, source, avatar, id }]) => (
          <button
            key={name}
            className={`tab${view?.chat?.name === name ? ' active' : ''}`}
            onClick={() => openChat(name, source, id)}
            title={name}
          >
            {avatar ? <Avatar src={avatar} name={name} size={16} /> : <Logo source={source} size={11} />}
            <span className="tab-name">{name}</span>
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="banner" onClick={() => setSettingsOpen(true)}>
          {errors.map(([k, v]) => (
            <div key={k}>
              <b>{k}:</b> {v}
            </div>
          ))}
        </div>
      )}
      <main className={`columns${view ? ' columns-focus' : ''}`}>
        {view && (
          <ChannelSidebar
            view={view}
            cfg={cfg}
            channels={channels}
            dialogs={dialogs}
            counts={chatCounts}
            busy={busy}
            onView={setView}
            onToggle={toggleWatch}
          />
        )}
        <Column title="Calls" count={calls.length} className="col-calls">
          {calls.length === 0 && <div className="empty">No contracts seen yet.</div>}
          {calls.map((t) => (
            <CallCard key={t.address} t={t} now={now} selected={selected === t.address} favorites={status.favorites} />
          ))}
        </Column>
        <Column
          title={title}
          count={chatMsgs.length}
          className={`col-chats${view ? ' col-discord' : ''}${view?.source === 'discord' && view.chat ? ' col-hash' : ''}`}
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
            <div className="empty">
              {view
                ? 'Nothing here yet. Pick a channel on the left (+ adds it to your feed).'
                : 'No messages yet. Use the Discord / Telegram buttons above to add chats.'}
            </div>
          )}
          {chatMsgs.map((m, i) => (
            <MessageRow
              key={m.id}
              m={m}
              tokens={tokens}
              onSelect={select}
              favorites={status.favorites}
              continued={!!view?.chat && continued(chatMsgs, i)}
              discord={!!view}
            />
          ))}
        </Column>
        {settingsOpen && <Settings status={status} onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  );
}
