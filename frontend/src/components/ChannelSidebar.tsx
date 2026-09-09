import type { DiscordChannel, MaskedConfig, TelegramDialog } from '../api';
import type { Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

export interface View {
  source: Source;
  guildId?: string;
  /** focused chat (display name as used in messages) */
  chat?: { name: string; id: string };
}

export function discordChatName(c: DiscordChannel): string {
  return `#${c.name} (${c.guildName})`;
}

/**
 * Discord-style left side: server rail + that server's channels by category
 * (Discord), or your chat list (Telegram). Watched chats are bright and show
 * a ✓ you can click to remove; unwatched ones show a + to add. Clicking a
 * name focuses it (adding it to the feed if needed).
 */
export function ChannelSidebar({
  view,
  cfg,
  channels,
  dialogs,
  counts,
  busy,
  onView,
  onToggle,
}: {
  view: View;
  cfg: MaskedConfig | null;
  channels: DiscordChannel[];
  dialogs: TelegramDialog[];
  counts: Map<string, number>;
  busy: boolean;
  onView: (v: View) => void;
  onToggle: (source: Source, id: string, on: boolean) => Promise<void>;
}) {
  if (view.source === 'telegram') {
    const rows = [...dialogs].sort((a, b) => {
      const wa = cfg?.telegram.watch.includes(a.id) ? 0 : 1;
      const wb = cfg?.telegram.watch.includes(b.id) ? 0 : 1;
      return wa - wb || (counts.get(b.title) ?? 0) - (counts.get(a.title) ?? 0) || a.title.localeCompare(b.title);
    });
    return (
      <aside className="sidebar">
        <div className="sidebar-head">
          <Logo source="telegram" size={16} /> <b>Telegram</b>
          <span className="muted">{cfg?.telegram.watch.length ?? 0} in feed</span>
        </div>
        <div className="sidebar-list">
          {rows.map((d) => {
            const on = cfg?.telegram.watch.includes(d.id) ?? false;
            const active = view.chat?.id === d.id;
            const n = counts.get(d.title) ?? 0;
            return (
              <div key={d.id} className={`chan-row${on ? ' on' : ''}${active ? ' active' : ''}`}>
                <button
                  className="chan-row-main"
                  disabled={busy}
                  onClick={async () => {
                    if (!on) await onToggle('telegram', d.id, true);
                    onView({ source: 'telegram', chat: { name: d.title, id: d.id } });
                  }}
                >
                  <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={20} />
                  <span className="chan-row-name">{d.title}</span>
                  {n > 0 && <span className="chan-row-n">{n}</span>}
                </button>
                <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => onToggle('telegram', d.id, !on)} title={on ? 'remove from feed' : 'add to feed'}>
                  {on ? '✓' : '+'}
                </button>
              </div>
            );
          })}
          {rows.length === 0 && <div className="empty">Telegram not connected.</div>}
        </div>
      </aside>
    );
  }

  const guilds = new Map<string, { id: string; name: string; icon?: string; watched: number }>();
  for (const c of channels) {
    const g = guilds.get(c.guildId) ?? { id: c.guildId, name: c.guildName, icon: c.guildIcon, watched: 0 };
    if (cfg?.discord.watch.includes(c.id)) g.watched++;
    guilds.set(c.guildId, g);
  }
  const guildList = [...guilds.values()].sort((a, b) => b.watched - a.watched || a.name.localeCompare(b.name));
  const guild = guilds.get(view.guildId ?? '') ?? guildList[0];
  const inGuild = channels
    .filter((c) => c.guildId === guild?.id)
    .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.position - b.position);
  const cats = new Map<string, DiscordChannel[]>();
  for (const c of inGuild) {
    const k = c.category ?? '';
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k)!.push(c);
  }

  return (
    <aside className="sidebar sidebar-discord">
      <div className="guild-rail">
        {guildList.map((g) => (
          <button
            key={g.id}
            className={`guild${g.id === guild?.id ? ' active' : ''}${g.watched ? ' watched' : ''}`}
            title={`${g.name}${g.watched ? ` · ${g.watched} in feed` : ''}`}
            onClick={() => onView({ source: 'discord', guildId: g.id })}
          >
            {g.icon ? <img src={g.icon} alt="" loading="lazy" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
          </button>
        ))}
        {guildList.length === 0 && <div className="empty">…</div>}
      </div>
      <div className="sidebar-pane">
        <div className="sidebar-head">
          {guild?.icon ? <img className="sidebar-icon" src={guild.icon} alt="" /> : <Logo source="discord" size={16} />}
          <b>{guild?.name ?? 'Discord'}</b>
        </div>
        <div className="sidebar-list">
          {[...cats.entries()].map(([cat, chs]) => (
            <div key={cat || '_'}>
              {cat && <div className="chan-cat">{cat}</div>}
              {chs.map((c) => {
                const on = cfg?.discord.watch.includes(c.id) ?? false;
                const active = view.chat?.id === c.id;
                const name = discordChatName(c);
                const n = counts.get(name) ?? 0;
                return (
                  <div key={c.id} className={`chan-row${on ? ' on' : ''}${active ? ' active' : ''}`}>
                    <button
                      className="chan-row-main"
                      disabled={busy}
                      onClick={async () => {
                        if (!on) await onToggle('discord', c.id, true);
                        onView({ source: 'discord', guildId: c.guildId, chat: { name, id: c.id } });
                      }}
                    >
                      <span className="chan-hash">#</span>
                      <span className="chan-row-name">{c.name}</span>
                      {n > 0 && <span className="chan-row-n">{n}</span>}
                    </button>
                    <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => onToggle('discord', c.id, !on)} title={on ? 'remove from feed' : 'add to feed'}>
                      {on ? '✓' : '+'}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {inGuild.length === 0 && <div className="empty">{channels.length ? 'No text channels.' : 'Waiting for Discord…'}</div>}
        </div>
      </div>
    </aside>
  );
}
