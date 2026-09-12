import { useState, type DragEvent, type ReactNode } from 'react';
import type { DiscordChannel, MaskedConfig, TelegramDialog, WatchedChat } from '../api';
import type { Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

export interface View {
  /** rail selection: 'all', 'g:<guildId>' or 't:<chatId>' */
  rail: string;
  /** focused chat (display name as used in messages) */
  chat?: { name: string; id: string; source: Source };
  /** previewing a chat that is not in the feed (history fetched on demand) */
  preview?: { name: string; id: string; source: Source };
}

/** The display name messages carry: `#chan (Server)`, or `Name (DM)` for a direct message. */
export function discordChatName(c: DiscordChannel): string {
  return c.dm ? `${c.name} (DM)` : `#${c.name} (${c.guildName})`;
}

/** The row glyph: a hash for a server channel, the person's avatar for a DM. */
export function discordGlyph(c: DiscordChannel, size = 20): ReactNode {
  return c.dm ? <Avatar src={c.avatar} name={c.name} size={size} /> : <span className="chan-hash">#</span>;
}

interface RailItem {
  key: string; // g:<id> | t:<id>
  source: Source;
  id: string;
  name: string;
  icon?: string;
  count: number;
}

/**
 * The Discord-style left side for both platforms. Rail: ★ All pinned, then
 * your Discord servers and Telegram chats as icons (each badged with its
 * platform), draggable to reorder, and +. Pane: only what's in your feed for
 * the selected rail item; collapsible.
 */
export function ChannelSidebar({
  view,
  cfg,
  channels,
  dialogs,
  watched,
  counts,
  collapsed,
  onView,
  onAdd,
  onReorder,
  onCollapse,
}: {
  view: View;
  cfg: MaskedConfig | null;
  channels: DiscordChannel[];
  dialogs: TelegramDialog[];
  watched: WatchedChat[];
  counts: Map<string, number>;
  collapsed: boolean;
  onView: (v: View) => void;
  onAdd: () => void;
  onReorder: (keys: string[]) => void;
  onCollapse: (hidden: boolean) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const watchedDc = new Set(cfg?.discord.watch ?? []);
  const watchedTg = new Set(cfg?.telegram.watch ?? []);

  // ---- rail items ----
  const guilds = new Map<string, RailItem>();
  for (const c of channels) {
    if (!watchedDc.has(c.id)) continue;
    const g = guilds.get(c.guildId) ?? { key: `g:${c.guildId}`, source: 'discord', id: c.guildId, name: c.guildName, icon: c.guildIcon, count: 0 };
    g.count += counts.get(discordChatName(c)) ?? 0;
    guilds.set(c.guildId, g);
  }
  const tg: RailItem[] = dialogs
    .filter((d) => watchedTg.has(d.id))
    .map((d) => ({ key: `t:${d.id}`, source: 'telegram', id: d.id, name: d.title, icon: `/api/telegram/avatar/${d.id}`, count: counts.get(d.title) ?? 0 }));
  const unordered = [...guilds.values(), ...tg];
  const order = cfg?.railOrder ?? [];
  const items = [
    ...order.map((k) => unordered.find((i) => i.key === k)).filter((i): i is RailItem => !!i),
    ...unordered.filter((i) => !order.includes(i.key)).sort((a, b) => a.name.localeCompare(b.name)),
  ];

  const active = items.find((i) => i.key === view.rail);
  const isAll = view.rail === 'all';

  // ---- drag & drop reorder ----
  const onDragStart = (key: string) => (e: DragEvent) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  };
  const onDragOver = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    if (overKey !== key) setOverKey(key);
  };
  const onDrop = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragKey ?? e.dataTransfer.getData('text/plain');
    setDragKey(null);
    setOverKey(null);
    if (!from || from === key) return;
    const keys = items.map((i) => i.key);
    const a = keys.indexOf(from);
    const b = keys.indexOf(key);
    if (a < 0 || b < 0) return;
    keys.splice(a, 1);
    keys.splice(b, 0, from);
    onReorder(keys);
  };

  const rail = (
    <div className="guild-rail">
      <button className={`guild guild-home${isAll ? ' active' : ''}`} title="All chats" onClick={() => onView({ rail: 'all' })}>
        ★
      </button>
      <button className="rail-collapse" onClick={() => onCollapse(!collapsed)} title={collapsed ? 'show channel list' : 'hide channel list'}>
        {collapsed ? '»' : '«'}
      </button>
      <span className="rail-sep" />
      {items.map((it) => (
        <button
          key={it.key}
          className={`guild${it.key === view.rail ? ' active' : ''}${overKey === it.key && dragKey && dragKey !== it.key ? ' drop-target' : ''}${
            dragKey === it.key ? ' dragging' : ''
          }`}
          title={`${it.name}${it.count ? ` · ${it.count}` : ''} (drag to reorder)`}
          draggable
          onDragStart={onDragStart(it.key)}
          onDragOver={onDragOver(it.key)}
          onDragLeave={() => overKey === it.key && setOverKey(null)}
          onDrop={onDrop(it.key)}
          onDragEnd={() => {
            setDragKey(null);
            setOverKey(null);
          }}
          onClick={() =>
            it.source === 'telegram'
              ? onView({ rail: it.key, chat: { name: it.name, id: it.id, source: 'telegram' } })
              : onView({ rail: it.key })
          }
        >
          {it.icon ? (
            <img src={it.icon} alt="" loading="lazy" draggable={false} />
          ) : it.key === 'g:dm' ? (
            <span>@</span>
          ) : (
            <span>{it.name.slice(0, 2).toUpperCase()}</span>
          )}
          <span className={`guild-src guild-src-${it.source}`}>
            <Logo source={it.source} size={9} />
          </span>
          {it.count > 0 && <span className="guild-n">{it.count > 99 ? '99+' : it.count}</span>}
        </button>
      ))}
      <button className="guild guild-add" onClick={onAdd} title="add servers, channels or chats">
        +
      </button>
    </div>
  );

  if (collapsed) return <aside className="sidebar sidebar-collapsed">{rail}</aside>;

  // ---- pane ----
  const row = (key: string, isActive: boolean, onClick: () => void, icon: ReactNode, name: string, n: number, src?: Source) => (
    <button key={key} className={`chan-row on${isActive ? ' active' : ''}`} onClick={onClick}>
      {icon}
      <span className="chan-row-name">{name}</span>
      {src && <Logo source={src} size={10} />}
      {n > 0 && <span className="chan-row-n">{n}</span>}
    </button>
  );

  let head: ReactNode;
  let list: ReactNode;
  if (isAll) {
    head = (
      <>
        <span className="sidebar-star">★</span> <b>All chats</b>
      </>
    );
    const dc = channels.filter((c) => watchedDc.has(c.id)).sort((a, b) => a.guildName.localeCompare(b.guildName) || a.position - b.position);
    const byGuild = new Map<string, DiscordChannel[]>();
    for (const c of dc) {
      if (!byGuild.has(c.guildName)) byGuild.set(c.guildName, []);
      byGuild.get(c.guildName)!.push(c);
    }
    list = (
      <>
        {[...byGuild.entries()].map(([g, chs]) => (
          <div key={g}>
            <div className="chan-cat">
              <Logo source="discord" size={9} /> {g}
            </div>
            {chs.map((c) => {
              const name = discordChatName(c);
              return row(c.id, view.chat?.id === c.id, () => onView({ rail: 'all', chat: { name, id: c.id, source: 'discord' } }), discordGlyph(c), c.name, counts.get(name) ?? 0);
            })}
          </div>
        ))}
        {tg.length > 0 && (
          <div>
            <div className="chan-cat">
              <Logo source="telegram" size={9} /> Telegram
            </div>
            {tg.map((d) =>
              row(d.id, view.chat?.id === d.id, () => onView({ rail: 'all', chat: { name: d.name, id: d.id, source: 'telegram' } }), <Avatar src={d.icon} name={d.name} size={20} />, d.name, d.count),
            )}
          </div>
        )}
        {dc.length === 0 && tg.length === 0 && watched.length === 0 && (
          <div className="empty">
            Nothing in your feed yet.
            <br />
            <button className="link" onClick={onAdd}>
              + add channels or chats
            </button>
          </div>
        )}
      </>
    );
  } else if (active?.source === 'telegram') {
    head = (
      <>
        <Avatar src={active.icon} name={active.name} size={20} /> <b>{active.name}</b>
        <Logo source="telegram" size={11} />
      </>
    );
    list = (
      <>
        {row(active.id, true, () => onView({ rail: active.key, chat: { name: active.name, id: active.id, source: 'telegram' } }), <Avatar src={active.icon} name={active.name} size={20} />, active.name, active.count)}
        <div className="hint" style={{ padding: '10px 8px' }}>
          Telegram chats have no channels. Other chats sit on the rail on the left.
        </div>
      </>
    );
  } else {
    const gid = active?.id;
    const inGuild = channels
      .filter((c) => c.guildId === gid && watchedDc.has(c.id))
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.position - b.position);
    const cats = new Map<string, DiscordChannel[]>();
    for (const c of inGuild) {
      const k = c.category ?? '';
      if (!cats.has(k)) cats.set(k, []);
      cats.get(k)!.push(c);
    }
    head = (
      <>
        {active?.icon ? <img className="sidebar-icon" src={active.icon} alt="" /> : active?.id === 'dm' ? <span className="chan-hash">@</span> : <Logo source="discord" size={16} />}
        <b>{active?.name ?? 'Discord'}</b>
        <Logo source="discord" size={11} />
      </>
    );
    list = (
      <>
        {[...cats.entries()].map(([cat, chs]) => (
          <div key={cat || '_'}>
            {cat && <div className="chan-cat">{cat}</div>}
            {chs.map((c) => {
              const name = discordChatName(c);
              return row(c.id, view.chat?.id === c.id, () => onView({ rail: `g:${c.guildId}`, chat: { name, id: c.id, source: 'discord' } }), discordGlyph(c), c.name, counts.get(name) ?? 0);
            })}
          </div>
        ))}
        {inGuild.length === 0 && (
          <div className="empty">
            {channels.length ? 'Nothing from this server in your feed.' : 'Waiting for Discord…'}
            <br />
            <button className="link" onClick={onAdd}>
              + add channels
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <aside className="sidebar">
      {rail}
      <div className="sidebar-pane">
        <div className="sidebar-head">
          {head}
          <button className="sidebar-add" onClick={onAdd} title="add or preview">
            +
          </button>
          <button className="sidebar-add" onClick={() => onCollapse(true)} title="hide channel list">
            «
          </button>
        </div>
        <div className="sidebar-list">{list}</div>
      </div>
    </aside>
  );
}
