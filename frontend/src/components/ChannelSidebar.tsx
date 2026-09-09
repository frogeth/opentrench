import type { DiscordChannel, MaskedConfig, TelegramDialog, WatchedChat } from '../api';
import type { Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

export interface View {
  /** rail selection: 'all', a Discord server id, or 'telegram' */
  rail: string;
  /** focused chat (display name as used in messages) */
  chat?: { name: string; id: string; source: Source };
  /** previewing a chat that is not in the feed (history fetched on demand) */
  preview?: { name: string; id: string; source: Source };
}

export function discordChatName(c: DiscordChannel): string {
  return `#${c.name} (${c.guildName})`;
}

/**
 * The Discord-style left side, for both platforms: a rail with All pinned
 * on top, your Discord servers, one Telegram entry and +; a sidebar listing
 * only what's in your feed for the selected rail item.
 */
export function ChannelSidebar({
  view,
  cfg,
  channels,
  dialogs,
  watched,
  counts,
  onView,
  onAdd,
}: {
  view: View;
  cfg: MaskedConfig | null;
  channels: DiscordChannel[];
  dialogs: TelegramDialog[];
  watched: WatchedChat[];
  counts: Map<string, number>;
  onView: (v: View) => void;
  onAdd: () => void;
}) {
  const watchedDc = new Set(cfg?.discord.watch ?? []);
  const watchedTg = new Set(cfg?.telegram.watch ?? []);

  const guilds = new Map<string, { id: string; name: string; icon?: string; watched: number }>();
  for (const c of channels) {
    if (!watchedDc.has(c.id)) continue;
    const g = guilds.get(c.guildId) ?? { id: c.guildId, name: c.guildName, icon: c.guildIcon, watched: 0 };
    g.watched++;
    guilds.set(c.guildId, g);
  }
  const guildList = [...guilds.values()].sort((a, b) => a.name.localeCompare(b.name));
  const tgRows = dialogs
    .filter((d) => watchedTg.has(d.id))
    .sort((a, b) => (counts.get(b.title) ?? 0) - (counts.get(a.title) ?? 0) || a.title.localeCompare(b.title));

  const isAll = view.rail === 'all';
  const isTelegram = view.rail === 'telegram';
  const guild = isAll || isTelegram ? undefined : guilds.get(view.rail);

  const chanRow = (key: string, active: boolean, onClick: () => void, icon: React.ReactNode, name: string, n: number, src?: Source) => (
    <button key={key} className={`chan-row on${active ? ' active' : ''}`} onClick={onClick}>
      {icon}
      <span className="chan-row-name">{name}</span>
      {src && <Logo source={src} size={10} />}
      {n > 0 && <span className="chan-row-n">{n}</span>}
    </button>
  );

  const rail = (
    <div className="guild-rail">
      <button className={`guild guild-home${isAll ? ' active' : ''}`} title="All chats" onClick={() => onView({ rail: 'all' })}>
        ★
      </button>
      <span className="rail-sep" />
      {guildList.map((g) => (
        <button
          key={g.id}
          className={`guild${g.id === guild?.id ? ' active' : ''}`}
          title={`${g.name} · ${g.watched} in feed`}
          onClick={() => onView({ rail: g.id })}
        >
          {g.icon ? <img src={g.icon} alt="" loading="lazy" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
          <span className="guild-src">
            <Logo source="discord" size={9} />
          </span>
        </button>
      ))}
      <button
        className={`guild guild-telegram${isTelegram ? ' active' : ''}`}
        title={`Telegram · ${tgRows.length} in feed`}
        onClick={() => onView({ rail: 'telegram' })}
      >
        <Logo source="telegram" size={22} />
      </button>
      <button className="guild guild-add" onClick={onAdd} title="add servers, channels or chats">
        +
      </button>
    </div>
  );

  let head: React.ReactNode;
  let list: React.ReactNode;
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
              return chanRow(
                c.id,
                view.chat?.id === c.id,
                () => onView({ rail: 'all', chat: { name, id: c.id, source: 'discord' } }),
                <span className="chan-hash">#</span>,
                c.name,
                counts.get(name) ?? 0,
              );
            })}
          </div>
        ))}
        {tgRows.length > 0 && (
          <div>
            <div className="chan-cat">
              <Logo source="telegram" size={9} /> Telegram
            </div>
            {tgRows.map((d) =>
              chanRow(
                d.id,
                view.chat?.id === d.id,
                () => onView({ rail: 'all', chat: { name: d.title, id: d.id, source: 'telegram' } }),
                <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={20} />,
                d.title,
                counts.get(d.title) ?? 0,
              ),
            )}
          </div>
        )}
        {dc.length === 0 && tgRows.length === 0 && watched.length === 0 && (
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
  } else if (isTelegram) {
    head = (
      <>
        <Logo source="telegram" size={16} /> <b>Telegram</b>
      </>
    );
    list = (
      <>
        {tgRows.map((d) =>
          chanRow(
            d.id,
            view.chat?.id === d.id,
            () => onView({ rail: 'telegram', chat: { name: d.title, id: d.id, source: 'telegram' } }),
            <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={20} />,
            d.title,
            counts.get(d.title) ?? 0,
          ),
        )}
        {tgRows.length === 0 && (
          <div className="empty">
            No Telegram chats in your feed yet.
            <br />
            <button className="link" onClick={onAdd}>
              + add chats
            </button>
          </div>
        )}
      </>
    );
  } else {
    const inGuild = channels
      .filter((c) => c.guildId === guild?.id && watchedDc.has(c.id))
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.position - b.position);
    const cats = new Map<string, DiscordChannel[]>();
    for (const c of inGuild) {
      const k = c.category ?? '';
      if (!cats.has(k)) cats.set(k, []);
      cats.get(k)!.push(c);
    }
    head = (
      <>
        {guild?.icon ? <img className="sidebar-icon" src={guild.icon} alt="" /> : <Logo source="discord" size={16} />}
        <b>{guild?.name ?? 'Discord'}</b>
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
              return chanRow(
                c.id,
                view.chat?.id === c.id,
                () => onView({ rail: c.guildId, chat: { name, id: c.id, source: 'discord' } }),
                <span className="chan-hash">#</span>,
                c.name,
                counts.get(name) ?? 0,
              );
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
        </div>
        <div className="sidebar-list">{list}</div>
      </div>
    </aside>
  );
}
