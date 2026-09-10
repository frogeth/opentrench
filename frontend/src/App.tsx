import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useFeed } from './useFeed';
import { Column } from './components/Column';
import { TokenModal } from './components/TokenModal';
import { Tickers } from './components/Tickers';
import { CallCard } from './components/CallCard';
import { ChatFeed } from './components/ChatFeed';
import { ColumnEditor, chatKey } from './components/ColumnEditor';
import { CallersList } from './components/CallersColumn';
import { VirtualItem } from './components/Virtual';
import { Settings } from './components/Settings';
import { ChannelSidebar, discordChatName, type View } from './components/ChannelSidebar';
import { AddChatsModal } from './components/AddChatsModal';
import { Logo } from './components/Logo';
import { Avatar } from './components/Avatar';
import { api, type ColumnDef, type DiscordChannel, type MaskedConfig, type TelegramDialog, type WatchedChat } from './api';
import { beep, type ChartProvider } from './format';
import { playSound } from './sounds';
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

const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'calls', type: 'calls', title: 'All Calls', chats: [] },
  { id: 'chats', type: 'chat', title: 'All Chats', chats: [] },
];

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
  const [openToken, setOpenToken] = useState<string | null>(null);
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
  const [compactEmbeds, setCompactEmbedsState] = useState(() => {
    try {
      return localStorage.getItem('trenchfeed.embeds') !== 'full';
    } catch {
      return true;
    }
  });
  const setCompactEmbeds = (on: boolean) => {
    setCompactEmbedsState(on);
    try {
      localStorage.setItem('trenchfeed.embeds', on ? 'compact' : 'full');
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
  const columns: ColumnDef[] = cfg?.columns?.length ? cfg.columns : DEFAULT_COLUMNS;
  const saveColumns = (next: ColumnDef[]) => {
    setCfg((c) => (c ? { ...c, columns: next } : c));
    void api.setColumns(next).catch(() => {});
  };
  const [editing, setEditing] = useState<{ col?: ColumnDef } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const resizeFor = (id: string) => (w: number, done: boolean) => {
    if (!done) {
      setLiveWidths((m) => ({ ...m, [id]: w }));
      return;
    }
    setLiveWidths((m) => {
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    saveColumns(
      columns.map((c) => {
        if (c.id !== id) return c;
        const { width: _old, ...rest } = c;
        return w ? { ...rest, width: w } : rest;
      }),
    );
  };
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const dragFor = (id: string) => ({
    dragging: dragCol === id,
    over: overCol === id && dragCol !== id,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      setDragCol(id);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragCol) return;
      e.preventDefault();
      if (overCol !== id) setOverCol(id);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragCol;
      setDragCol(null);
      setOverCol(null);
      if (!from || from === id) return;
      const next = columns.filter((c) => c.id !== from);
      const at = next.findIndex((c) => c.id === id);
      next.splice(at, 0, columns.find((c) => c.id === from)!);
      saveColumns(next);
    },
  });
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

  // Per-column alerts: a new call (message with a contract, not a repeat) in a column's channels plays its sound.
  const alerted = useRef<{ lastId: string | null; lastPlay: number }>({ lastId: null, lastPlay: 0 });
  useEffect(() => {
    const newest = messages[0];
    if (!newest) return;
    const first = alerted.current.lastId === null;
    const prevId = alerted.current.lastId;
    alerted.current.lastId = newest.id;
    if (first) return; // initial load: nothing to announce
    // walk the messages that arrived since the last one we saw (newest first)
    const fresh: FeedMessage[] = [];
    for (const m of messages) {
      if (m.id === prevId) break;
      fresh.push(m);
      if (fresh.length > 20) break;
    }
    const now = Date.now();
    let played = false;
    for (const m of fresh) {
      if (m.hidden || m.repeat || m.contracts.length === 0 || now - m.ts > 60_000) continue;
      for (const col of columns) {
        if (!col.alert?.on || col.type === 'callers' || !inScope(m.chatName, namesFor(col))) continue;
        if (!played && now - alerted.current.lastPlay > 1200) {
          playSound(col.alert.sound);
          alerted.current.lastPlay = now;
          played = true;
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

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

  /** A column's chat names (null = every watched chat), from its `<source>:<id>` keys. */
  const namesFor = (col: ColumnDef): Set<string> | null => {
    if (col.chats.length === 0) return null;
    const keys = new Set(col.chats);
    return new Set(watched.filter((w) => keys.has(chatKey(w))).map((w) => w.name));
  };
  const inScope = (name: string, names: Set<string> | null) => (!scope || scope.has(name)) && (!names || names.has(name));

  /** Messages for a chat column (chronological); the focused/preview view ignores column filters. */
  const chatMsgsFor = (names: Set<string> | null) => {
    if (view.preview) return (previewMsgs ?? []).filter((m) => (showBots || !m.hidden) && matchesQuery(q, m, tokens));
    return messages.filter(
      (m) =>
        (showBots || !m.hidden) &&
        (showRepeats || !m.repeat) &&
        (watched.length === 0 || watchedNames.has(m.chatName)) &&
        inScope(m.chatName, names) &&
        matchesQuery(q, m, tokens),
    );
  };
  const callsFor = (names: Set<string> | null) =>
    Object.values(tokens)
      .filter((t) => t.calledIn.some((c) => inScope(c, names)) && tokenMatches(q, t))
      .sort((a, b) => (b.lastCallTs ?? b.firstSeenTs) - (a.lastCallTs ?? a.firstSeenTs));
  const allCalls = useMemo(() => callsFor(null), [tokens, q, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeLabel = view.preview ? 'preview' : view.rail === 'all' ? 'All channels' : view.chat ? 'this channel' : 'this server';
  const subtitleFor = (col: ColumnDef) => (view.rail !== 'all' || view.chat ? scopeLabel : col.chats.length === 0 ? 'All channels' : `${col.chats.length} channel${col.chats.length === 1 ? '' : 's'}`);

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

  const FeedToggles = () => (
    <>
      <label>
        <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} /> hidden
      </label>
      <label>
        <input type="checkbox" checked={showRepeats} onChange={(e) => setShowRepeats(e.target.checked)} /> repeats
      </label>
    </>
  );
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
        <div className="brand">opentrench</div>
        <Tickers />
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
        <div className="terminal">
          {focused ? (
            <>
              <Column title="All Calls" subtitle={scopeLabel} kind="calls" count={allCalls.length} className="col-calls">
                {allCalls.length === 0 && (
                  <div className="empty">{view.preview ? 'Previewing — add this chat to track its calls.' : 'No contracts seen yet.'}</div>
                )}
                {allCalls.map((t) => (
                  <VirtualItem key={t.address} id={`call:${t.address}`} estimate={139}>
                    <CallCard t={t} now={now} selected={selected === t.address} favorites={status.favorites} chartProvider={chartProvider} onOpen={setOpenToken} />
                  </VirtualItem>
                ))}
              </Column>
              <ChatFeed
                msgs={chatMsgsFor(null)}
                order={chatOrder}
                tokens={tokens}
                favorites={status.favorites}
                discord
                autoChart={autoChart}
                compactEmbeds={compactEmbeds}
                chartProvider={chartProvider}
                onSelect={select}
                onAuthorChanged={reloadLists}
                head={
                  view.preview && (
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
                  )
                }
                empty={
                  view.preview ? (
                    previewErr ? <div className="empty err">{previewErr}</div> : previewMsgs === null ? <div className="empty">Loading history…</div> : <div className="empty">Nothing here yet.</div>
                  ) : (
                    <div className="empty">Nothing here yet.</div>
                  )
                }
                render={(body, bodyRef, onScroll, footer) => (
                  <Column
                    title={title}
                    kind="chat"
                    count={chatMsgsFor(null).length}
                    className={`col-chats col-discord${focused?.source === 'discord' ? ' col-hash' : ''}`}
                    bodyRef={bodyRef}
                    onScroll={onScroll}
                    footer={footer}
                    extra={<FeedToggles />}
                  >
                    {body}
                  </Column>
                )}
              />
            </>
          ) : (
            <>
              {columns.map((col, i) => {
                const names = namesFor(col);
                const last = i === columns.length - 1;
                const actions = {
                  onEdit: () => setEditing({ col }),
                  onRemove: () => setConfirmRemove(col.id),
                  ...(col.type !== 'callers'
                    ? {
                        alertOn: !!col.alert?.on,
                        onAlert: () => {
                          const next = { on: !col.alert?.on, sound: col.alert?.sound ?? 'ping' };
                          if (next.on) playSound(next.sound);
                          saveColumns(columns.map((c) => (c.id === col.id ? { ...c, alert: next } : c)));
                        },
                      }
                    : {}),
                  drag: dragFor(col.id),
                  width: liveWidths[col.id] ?? col.width,
                  onResize: last ? undefined : resizeFor(col.id),
                  fill: last,
                };
                if (col.type === 'callers') {
                  return (
                    <Column key={col.id} title={col.title} subtitle={`${col.window ?? '7d'} · ${subtitleFor(col)}`} kind="callers" className="col-callers" {...actions}>
                      <CallersList tokens={tokens} window={col.window ?? '7d'} inScope={(name) => inScope(name, names)} now={now} favorites={status.favorites} onSearch={setQuery} />
                    </Column>
                  );
                }
                if (col.type === 'calls') {
                  const list = callsFor(names);
                  return (
                    <Column key={col.id} title={col.title} subtitle={subtitleFor(col)} kind="calls" count={list.length} className="col-calls" {...actions}>
                      {list.length === 0 && <div className="empty">No contracts seen yet.</div>}
                      {list.map((t) => (
                        <VirtualItem key={t.address} id={`call:${t.address}`} estimate={139}>
                          <CallCard t={t} now={now} selected={selected === t.address} favorites={status.favorites} chartProvider={chartProvider} onOpen={setOpenToken} />
                        </VirtualItem>
                      ))}
                    </Column>
                  );
                }
                const msgs = chatMsgsFor(names);
                return (
                  <ChatFeed
                    key={col.id}
                    msgs={msgs}
                    order={chatOrder}
                    tokens={tokens}
                    favorites={status.favorites}
                    autoChart={autoChart}
                    compactEmbeds={compactEmbeds}
                    chartProvider={chartProvider}
                    onSelect={select}
                    onAuthorChanged={reloadLists}
                    empty={<div className="empty">{watched.length === 0 ? 'No chats in your feed yet. Use the + in the rail.' : 'Nothing here yet.'}</div>}
                    render={(body, bodyRef, onScroll, footer) => (
                      <Column
                        title={col.title}
                        subtitle={subtitleFor(col)}
                        kind="chat"
                        count={msgs.length}
                        className="col-chats"
                        bodyRef={bodyRef}
                        onScroll={onScroll}
                        footer={footer}
                        extra={<FeedToggles />}
                        {...actions}
                      >
                        {body}
                      </Column>
                    )}
                  />
                );
              })}
              <button className="col-add" onClick={() => setEditing({})} title="Add a column" aria-label="Add a column">
                +
              </button>
            </>
          )}
        </div>
      </main>
      {editing && (
        <ColumnEditor
          col={editing.col}
          watched={watched}
          onClose={() => setEditing(null)}
          onSave={(c) => {
            const exists = columns.some((x) => x.id === c.id);
            saveColumns(exists ? columns.map((x) => (x.id === c.id ? c : x)) : [...columns, c]);
            setEditing(null);
          }}
        />
      )}
      {confirmRemove && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setConfirmRemove(null)}>
          <div className="modal modal-confirm">
            <div className="modal-head">
              <b>Remove column?</b>
            </div>
            <div className="modal-body-pad">
              “{columns.find((c) => c.id === confirmRemove)?.title}” goes away. Your chats and calls stay; you can add it back any time.
            </div>
            <div className="modal-foot">
              <button onClick={() => setConfirmRemove(null)}>Cancel</button>
              <button
                className="danger"
                onClick={() => {
                  saveColumns(columns.filter((c) => c.id !== confirmRemove));
                  setConfirmRemove(null);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {openToken && tokens[openToken] && <TokenModal t={tokens[openToken]} now={now} favorites={status.favorites} onClose={() => setOpenToken(null)} />}
      {settingsOpen && (
        <Settings
          status={status}
          onClose={() => setSettingsOpen(false)}
          chatOrder={chatOrder}
          onChatOrder={setChatOrder}
          autoChart={autoChart}
          onAutoChart={setAutoChart}
          compactEmbeds={compactEmbeds}
          onCompactEmbeds={setCompactEmbeds}
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
