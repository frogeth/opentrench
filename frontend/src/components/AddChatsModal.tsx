import { useEffect, useMemo, useState } from 'react';
import type { DiscordChannel, MaskedConfig, TelegramDialog } from '../api';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

type TgKind = 'all' | 'group' | 'channel' | 'dm' | 'bot';
import { Icon } from './Icon';
import { discordChatName, discordGlyph } from './ChannelSidebar';

/**
 * Popup picker for both platforms: every Discord server & channel, or every
 * Telegram chat, each with an add/remove toggle and a preview button that
 * opens the chat's recent history without adding it.
 */
export function AddChatsModal({
  initialSource,
  guildId,
  cfg,
  channels,
  dialogs,
  busy,
  onToggle,
  onPreview,
  onClose,
}: {
  initialSource: 'discord' | 'telegram';
  guildId?: string;
  cfg: MaskedConfig | null;
  channels: DiscordChannel[];
  dialogs: TelegramDialog[];
  busy: boolean;
  onToggle: (source: 'discord' | 'telegram', id: string, on: boolean) => Promise<void>;
  onPreview: (source: 'discord' | 'telegram', id: string, name: string, guildId?: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<'discord' | 'telegram'>(initialSource);
  const [q, setQ] = useState('');
  const [guild, setGuild] = useState<string | undefined>(guildId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // a handle pasted from Telegram arrives as "@name" wrapped in invisible bidi marks; a search should survive that
  const query = q.replace(/[\u200e\u200f\u2066-\u2069\u200b\ufeff]/g, '').trim().replace(/^@/, '').toLowerCase();
  const tgHit = (d: TelegramDialog) => d.title.toLowerCase().includes(query) || (d.username?.toLowerCase().includes(query) ?? false);
  // Telegram: groups, channels and DMs pile up fast; narrow by kind, or to what is already in the feed
  const [tgKind, setTgKind] = useState<TgKind>('all');
  const [tgInFeed, setTgInFeed] = useState(false);

  const guilds = useMemo(() => {
    const m = new Map<string, { id: string; name: string; icon?: string; count: number; watched: number }>();
    for (const c of channels) {
      const g = m.get(c.guildId) ?? { id: c.guildId, name: c.guildName, icon: c.guildIcon, count: 0, watched: 0 };
      g.count++;
      if (cfg?.discord.watch.includes(c.id)) g.watched++;
      m.set(c.guildId, g);
    }
    return [...m.values()].sort((a, b) => b.watched - a.watched || a.name.localeCompare(b.name));
  }, [channels, cfg]);
  // the search box narrows the server rail too: a server whose name matches, or that has a matching channel
  const shownGuilds = useMemo(() => {
    if (!query) return guilds;
    const chanHit = new Set(channels.filter((c) => c.name.toLowerCase().includes(query)).map((c) => c.guildId));
    return guilds.filter((g) => g.name.toLowerCase().includes(query) || chanHit.has(g.id));
  }, [guilds, channels, query]);
  useEffect(() => {
    if (shownGuilds.length && !shownGuilds.some((g) => g.id === guild)) setGuild(shownGuilds[0].id);
  }, [guild, shownGuilds]);

  let body;
  if (source === 'telegram') {
    const counts = { all: dialogs.length, group: 0, channel: 0, dm: 0, bot: 0 } as Record<TgKind, number>;
    for (const d of dialogs) counts[d.type]++;
    const inFeed = dialogs.filter((d) => cfg?.telegram.watch.includes(d.id)).length;
    const rows = dialogs
      .filter((d) => (tgKind === 'all' || d.type === tgKind) && (!tgInFeed || (cfg?.telegram.watch.includes(d.id) ?? false)))
      .filter((d) => !query || tgHit(d))
      .sort((a, b) => {
        const wa = cfg?.telegram.watch.includes(a.id) ? 0 : 1;
        const wb = cfg?.telegram.watch.includes(b.id) ? 0 : 1;
        return wa - wb || a.title.localeCompare(b.title);
      });
    body = (
      <div className="modal-list">
        <div className="pick-filters">
          <span className="seg seg-sm">
            {(['all', 'group', 'channel', 'dm', 'bot'] as const).map((k) => (
              <button key={k} className={tgKind === k ? 'active' : ''} onClick={() => setTgKind(k)} title={k === 'bot' ? 'conversations with bots: a custom alert bot posts to you like any chat' : undefined}>
                {k === 'all' ? 'All' : k === 'group' ? 'Groups' : k === 'channel' ? 'Channels' : k === 'dm' ? 'DMs' : 'Bots'} <span className="muted">{counts[k]}</span>
              </button>
            ))}
          </span>
          <button className={`seen-all${tgInFeed ? ' on' : ''}`} onClick={() => setTgInFeed((v) => !v)} title="only the chats already in your feed">
            in feed <span className="muted">{inFeed}</span>
          </button>
        </div>
        {rows.map((d) => {
          const on = cfg?.telegram.watch.includes(d.id) ?? false;
          return (
            <div key={d.id} className={`pick${on ? ' on' : ''}`}>
              <button className="pick-main" onClick={() => onPreview('telegram', d.id, d.title)} title="preview without adding">
                <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={22} />
                <span className="pick-name">{d.title}</span>
                {d.username && <span className="muted pick-handle">@{d.username}</span>}
                <span className="muted">{d.type}</span>
              </button>
              <button className="pick-eye" onClick={() => onPreview('telegram', d.id, d.title)} title="preview">
                <Icon name="explorer" size={13} />
              </button>
              <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => onToggle('telegram', d.id, !on)}>
                {on ? '✓ in feed' : '+ add'}
              </button>
            </div>
          );
        })}
        {rows.length === 0 && <div className="empty">{dialogs.length ? 'No match for this filter.' : 'Telegram not connected.'}</div>}
      </div>
    );
  } else {
    const active = guilds.find((g) => g.id === guild);
    const inGuild = channels
      .filter((c) => c.guildId === guild && (!query || c.name.toLowerCase().includes(query) || (active?.name.toLowerCase().includes(query) ?? false)))
      .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.position - b.position);
    const cats = new Map<string, DiscordChannel[]>();
    for (const c of inGuild) {
      const k = c.category ?? '';
      if (!cats.has(k)) cats.set(k, []);
      cats.get(k)!.push(c);
    }
    body = (
      <div className="modal-discord">
        <div className="guild-rail">
          {shownGuilds.map((g) => (
            <button
              key={g.id}
              className={`guild${g.id === guild ? ' active' : ''}${g.watched ? ' watched' : ''}`}
              title={`${g.name}${g.watched ? ` · ${g.watched} in feed` : ''}`}
              onClick={() => setGuild(g.id)}
            >
              {g.icon ? <img src={g.icon} alt="" loading="lazy" /> : g.id === 'dm' ? <span>@</span> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
            </button>
          ))}
        </div>
        <div className="modal-pane">
          <div className="modal-guild">{active?.name ?? ''}</div>
          <div className="modal-list">
            {[...cats.entries()].map(([cat, chs]) => (
              <div key={cat || '_'}>
                {cat && <div className="chan-cat">{cat}</div>}
                {chs.map((c) => {
                  const on = cfg?.discord.watch.includes(c.id) ?? false;
                  const name = discordChatName(c);
                  return (
                    <div key={c.id} className={`pick${on ? ' on' : ''}`}>
                      <button className="pick-main" onClick={() => onPreview('discord', c.id, name, c.guildId)} title="preview without adding">
                        {discordGlyph(c, 22)}
                        <span className="pick-name">{c.name}</span>
                      </button>
                      <button className="pick-eye" onClick={() => onPreview('discord', c.id, name, c.guildId)} title="preview">
                        <Icon name="explorer" size={13} />
                      </button>
                      <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => onToggle('discord', c.id, !on)}>
                        {on ? '✓ in feed' : '+ add'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            {inGuild.length === 0 && <div className="empty">{channels.length ? 'No match.' : 'Waiting for Discord…'}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div className="seg">
            <button className={source === 'discord' ? 'active' : ''} onClick={() => setSource('discord')}>
              <Logo source="discord" size={13} /> Discord
            </button>
            <button className={source === 'telegram' ? 'active' : ''} onClick={() => setSource('telegram')}>
              <Logo source="telegram" size={13} /> Telegram
            </button>
          </div>
          <input className="modal-search" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <div className="hint modal-hint">Click a name to preview it without adding. "+ add" puts it in your feed.</div>
        {body}
      </div>
    </div>
  );
}
