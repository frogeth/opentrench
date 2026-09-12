import { useEffect, useMemo, useState } from 'react';
import type { DiscordChannel, MaskedConfig, TelegramDialog } from '../api';
import type { Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
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
  initialSource: Source;
  guildId?: string;
  cfg: MaskedConfig | null;
  channels: DiscordChannel[];
  dialogs: TelegramDialog[];
  busy: boolean;
  onToggle: (source: Source, id: string, on: boolean) => Promise<void>;
  onPreview: (source: Source, id: string, name: string, guildId?: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>(initialSource);
  const [q, setQ] = useState('');
  const [guild, setGuild] = useState<string | undefined>(guildId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const query = q.trim().toLowerCase();

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
  useEffect(() => {
    if (!guild && guilds.length) setGuild(guilds[0].id);
  }, [guild, guilds]);

  let body;
  if (source === 'telegram') {
    const rows = dialogs
      .filter((d) => !query || d.title.toLowerCase().includes(query))
      .sort((a, b) => {
        const wa = cfg?.telegram.watch.includes(a.id) ? 0 : 1;
        const wb = cfg?.telegram.watch.includes(b.id) ? 0 : 1;
        return wa - wb || a.title.localeCompare(b.title);
      });
    body = (
      <div className="modal-list">
        {rows.map((d) => {
          const on = cfg?.telegram.watch.includes(d.id) ?? false;
          return (
            <div key={d.id} className={`pick${on ? ' on' : ''}`}>
              <button className="pick-main" onClick={() => onPreview('telegram', d.id, d.title)} title="preview without adding">
                <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={22} />
                <span className="pick-name">{d.title}</span>
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
        {rows.length === 0 && <div className="empty">{dialogs.length ? 'No match.' : 'Telegram not connected.'}</div>}
      </div>
    );
  } else {
    const active = guilds.find((g) => g.id === guild);
    const inGuild = channels
      .filter((c) => c.guildId === guild && (!query || c.name.toLowerCase().includes(query)))
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
          {guilds.map((g) => (
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
