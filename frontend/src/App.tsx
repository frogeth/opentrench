import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFeed } from './useFeed';
import { Column } from './components/Column';
import { CallCard } from './components/CallCard';
import { MessageRow } from './components/MessageRow';
import { Settings } from './components/Settings';
import { ChannelSidebar, discordChatName, type View } from './components/ChannelSidebar';
import { AddChatsModal } from './components/AddChatsModal';
import { Logo } from './components/Logo';
import { Avatar } from './components/Avatar';
import { api, type DiscordChannel, type MaskedConfig, type TelegramDialog, type WatchedChat } from './api';
import { beep, type ChartProvider } from './format';
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

/** Discord-style grouping: hide the header when the message just above (in display order) is the same author within 5 min. */
function continued(list: FeedMessage[], i: number): boolean {
  const above = list[i - 1];
  const m = list[i];
  return !!above && above.author === m.author && above.chatName === m.chatName && Math.abs(above.ts - m.ts) < 5 * 60_000 && !m.replyTo;
}

export type ChatOrder = 'bottom' | 'top';

export default function App() {
  const { messages, tokens, status, wsOpen, ping } = useFeed();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState<Source | null>(null);
  const [view, setView] = useState<View>({ rail: 'all' });
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
  const [previewMsgs, setPreviewMsgs] = useState<FeedMessage[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [chatOrder, setChatOrderState] = useState<ChatOrder>(() => {
    try {
      return localStorage.getItem('trenchfeed.chatOrder') === 'top' ? 'top' : 'bottom';
    } catch {
      return 'bottom';
    }
  });
  const setChatOrder = (o: ChatOrder) => {
    setChatOrderState(o);
    try {
      localStorage.setItem('trenchfeed.chatOrder', o);
    } catch {
      /* ignore */
    }
  };
  const [autoChart, setAutoChartState] = useState(() => {
    try {
      return localStorage.getItem('trenchfeed.autoChart') !== 'off';
    } catch {
      return true;
    }
  });
  const setAutoChart = (on: boolean) => {
    setAutoChartState(on);
    try {
      localStorage.setItem('trenchfeed.autoChart', on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  };
  const [chartProvider, setChartProviderState] = useState<ChartProvider>(() => {
    try {
      return localStorage.getItem('trenchfeed.chartProvider') === 'dexscreener' ? 'dexscreener' : 'basedbot';
    } catch {
      return 'basedbot';
    }
  });
  const setChartProvider = (p: ChartProvider) => {
    setChartProviderState(p);
    try {
      localStorage.setItem('trenchfeed.chartProvider', p);
    } catch {
      /* ignore */
    }
  };
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [paneHidden, setPaneHidden] = useState(() => {
    try {
      return localStorage.getItem('trenchfeed.pane') === 'hidden';
    } catch {
      return false;
    }
  });
  const setPane = (hidden: boolean) => {
    setPaneHidden(hidden);
    try {
      localStorage.setItem('trenchfeed.pane', hidden ? 'hidden' : 'shown');
    } catch {
      /* ignore */
    }
  };
  const reorderRail = (keys: string[]) => {
    setCfg((c) => (c ? { ...c, railOrder: keys } : c));
    void api.setRailOrder(keys).catch(() => {});
  };
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

  // Preview: fetch recent history for a chat that isn't in the feed.
  useEffect(() => {
    const p = view.preview;
    if (!p) {
      setPreviewMsgs(null);
      setPreviewErr(null);
      return;
    }
    let cancelled = false;
    setPreviewMsgs(null);
    setPreviewErr(null);
    api
      .preview(p.source, p.id)
      .then((msgs) => !cancelled && setPreviewMsgs(Array.isArray(msgs) ? msgs : []))
      .catch((e) => !cancelled && setPreviewErr(e.message ?? String(e)));
    return () => {
      cancelled = true;
    };
  }, [view.preview?.id, view.preview?.source]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (!on && view.chat?.id === id) setView({ rail: view.rail });
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

  /** Which chat names the current view scopes to (null = everything watched). */
  const scope = useMemo<Set<string> | null>(() => {
    if (view.preview) return new Set([view.preview.name]);
    if (view.chat) return new Set([view.chat.name]);
    if (view.rail === 'all') return null;
    if (view.rail.startsWith('t:')) {
      const id = view.rail.slice(2);
      const name = watched.find((w) => w.source === 'telegram' && w.id === id)?.name;
      return name ? new Set([name]) : new Set<string>();
    }
    const gid = view.rail.slice(2);
    return new Set(channels.filter((c) => c.guildId === gid && cfg?.discord.watch.includes(c.id)).map(discordChatName));
  }, [view, channels, cfg, watched]);

  const chatMsgs = useMemo(() => {
    if (view.preview) return (previewMsgs ?? []).filter((m) => (showBots || !m.isBot) && matchesQuery(q, m, tokens));
    return messages.filter(
      (m) =>
        (showBots || !m.isBot) &&
        (showRepeats || !m.repeat) &&
        (watched.length === 0 || watchedNames.has(m.chatName)) &&
        (!scope || scope.has(m.chatName)) &&
        matchesQuery(q, m, tokens),
    );
  }, [messages, previewMsgs, view.preview, tokens, q, scope, showBots, showRepeats, watched.length, watchedNames]);

  /** What the Chats column renders, in reading order. */
  const shownMsgs = useMemo(() => (chatOrder === 'bottom' ? [...chatMsgs].reverse() : chatMsgs), [chatMsgs, chatOrder]);
  const onChatScroll = () => {
    const el = chatBodyRef.current;
    if (!el) return;
    setAtEnd(chatOrder === 'bottom' ? el.scrollHeight - el.scrollTop - el.clientHeight < 60 : el.scrollTop < 60);
  };
  useLayoutEffect(() => {
    const el = chatBodyRef.current;
    if (!el || !atEnd) return;
    el.scrollTop = chatOrder === 'bottom' ? el.scrollHeight : 0;
  }, [shownMsgs, chatOrder, atEnd]);
  const jumpToLatest = () => {
    const el = chatBodyRef.current;
    if (!el) return;
    el.scrollTo({ top: chatOrder === 'bottom' ? el.scrollHeight : 0, behavior: 'smooth' });
    setAtEnd(true);
  };

  const calls = useMemo(
    () =>
      Object.values(tokens)
        .filter((t) => (!scope || t.calledIn.some((c) => scope.has(c))) && tokenMatches(q, t))
        .sort((a, b) => (b.lastCallTs ?? b.firstSeenTs) - (a.lastCallTs ?? a.firstSeenTs)),
    [tokens, q, scope],
  );

  const select = (address: string) => {
    if (!tokens[address]) return;
    if (scope && !tokens[address].calledIn.some((c) => scope.has(c))) setView({ rail: 'all' });
    if (q && !tokenMatches(q, tokens[address])) setQuery('');
    setSelected(address);
  };

  const openChat = (name: string, source: Source, id: string) => {
    if (view.chat?.name === name) {
      setView({ rail: view.rail });
      return;
    }
    const ch = source === 'discord' ? channels.find((c) => c.id === id) : undefined;
    setView({ rail: source === 'telegram' ? `t:${id}` : ch ? `g:${ch.guildId}` : 'all', chat: { name, id, source } });
  };

  const openPreview = (source: Source, id: string, name: string, guildId?: string) => {
    setAddOpen(null);
    setView({ rail: source === 'telegram' ? view.rail : guildId ? `g:${guildId}` : view.rail, preview: { name, id, source } });
  };

  const focused = view.preview ?? view.chat;
  const title = focused
    ? focused.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '')
    : view.rail === 'all'
      ? 'All chats'
      : 'Server';
  const previewInFeed = view.preview
    ? view.preview.source === 'discord'
      ? cfg?.discord.watch.includes(view.preview.id)
      : cfg?.telegram.watch.includes(view.preview.id)
    : false;

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
        <button className="gear" onClick={() => setSettingsOpen(true)} title="settings">
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
        {chats.map(([name, { count, source, avatar, id }]) => (
          <button
            key={name}
            className={`tab${view.chat?.name === name ? ' active' : ''}`}
            onClick={() => openChat(name, source, id)}
            title={name}
          >
            {avatar ? <Avatar src={avatar} name={name} size={16} /> : <Logo source={source} size={11} />}
            <span className="tab-name">{name}</span>
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
        {chats.length === 0 && <span className="hint">Add channels with the + in the rail.</span>}
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
      <main className="columns">
        <ChannelSidebar
          view={view}
          cfg={cfg}
          channels={channels}
          dialogs={dialogs}
          watched={watched}
          counts={chatCounts}
          collapsed={paneHidden}
          onView={setView}
          onAdd={() => setAddOpen(view.rail.startsWith('t:') ? 'telegram' : 'discord')}
          onReorder={reorderRail}
          onCollapse={setPane}
        />
        <Column title="Calls" count={calls.length} className="col-calls">
          {calls.length === 0 && (
            <div className="empty">{view.preview ? 'Previewing — add this chat to track its calls.' : 'No contracts seen yet.'}</div>
          )}
          {calls.map((t) => (
            <CallCard key={t.address} t={t} now={now} selected={selected === t.address} favorites={status.favorites} chartProvider={chartProvider} />
          ))}
        </Column>
        <Column
          title={title}
          count={chatMsgs.length}
          className={`col-chats col-discord${focused?.source === 'discord' ? ' col-hash' : ''}`}
          bodyRef={chatBodyRef}
          onScroll={onChatScroll}
          footer={
            !atEnd && (
              <button className="jump" onClick={jumpToLatest}>
                {chatOrder === 'bottom' ? '↓' : '↑'} latest
              </button>
            )
          }
          extra={
            <>
              {focused && <Logo source={focused.source} size={12} />}
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
          {view.preview && (
            <div className="preview-bar">
              <span>
                Previewing <b>{view.preview.name}</b> — {previewInFeed ? 'in your feed' : 'not in your feed'}
              </span>
              {!previewInFeed && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    const p = view.preview!;
                    await toggleWatch(p.source, p.id, true);
                    setView({ rail: view.rail, chat: { name: p.name, id: p.id, source: p.source } });
                  }}
                >
                  + add to feed
                </button>
              )}
              <button onClick={() => setView({ rail: view.rail })}>close preview</button>
            </div>
          )}
          {view.preview && previewMsgs === null && !previewErr && <div className="empty">Loading history…</div>}
          {previewErr && <div className="empty err">{previewErr}</div>}
          {!view.preview && chatMsgs.length === 0 && (
            <div className="empty">
              {watched.length === 0 ? 'No chats in your feed yet. Use the + in the rail.' : 'Nothing here yet.'}
            </div>
          )}
          {shownMsgs.map((m, i) => (
            <MessageRow
              key={m.id}
              m={m}
              tokens={tokens}
              onSelect={select}
              favorites={status.favorites}
              continued={!!focused && continued(shownMsgs, i)}
              discord={!!focused}
              autoChart={autoChart}
              chartProvider={chartProvider}
            />
          ))}
        </Column>
      </main>
      {settingsOpen && (
        <Settings
          status={status}
          onClose={() => setSettingsOpen(false)}
          chatOrder={chatOrder}
          onChatOrder={setChatOrder}
          autoChart={autoChart}
          onAutoChart={setAutoChart}
          chartProvider={chartProvider}
          onChartProvider={setChartProvider}
        />
      )}
      {addOpen && (
        <AddChatsModal
          initialSource={addOpen}
          guildId={view.rail.startsWith('g:') ? view.rail.slice(2) : undefined}
          cfg={cfg}
          channels={channels}
          dialogs={dialogs}
          busy={busy}
          onToggle={toggleWatch}
          onPreview={openPreview}
          onClose={() => setAddOpen(null)}
        />
      )}
    </div>
  );
}
