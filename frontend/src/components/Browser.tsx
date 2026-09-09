import { useEffect, useMemo, useState } from 'react';
import { api, type DiscordChannel, type MaskedConfig, type TelegramDialog } from '../api';
import type { Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

/** Discord-style channel browser: server rail on the left, channels by category, add/remove toggles. */
export function Browser({ source, onClose }: { source: Source; onClose: () => void }) {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [guild, setGuild] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => api.config().then(setCfg).catch(() => {});
  useEffect(() => {
    reload();
    if (source === 'discord') api.discordChannels().then(setChannels).catch(() => {});
    else api.telegramDialogs().then(setDialogs).catch(() => {});
  }, [source]);

  const guilds = useMemo(() => {
    const m = new Map<string, { id: string; name: string; icon?: string; count: number }>();
    for (const c of channels) {
      const g = m.get(c.guildId) ?? { id: c.guildId, name: c.guildName, icon: c.guildIcon, count: 0 };
      g.count++;
      m.set(c.guildId, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [channels]);
  useEffect(() => {
    if (!guild && guilds.length) setGuild(guilds[0].id);
  }, [guilds, guild]);

  const toggle = async (source: Source, id: string) => {
    if (!cfg) return;
    setBusy(true);
    try {
      if (source === 'discord') {
        const w = cfg.discord.watch;
        await api.setDiscordWatch(w.includes(id) ? w.filter((x) => x !== id) : [...w, id]);
      } else {
        const w = cfg.telegram.watch;
        await api.setTelegramWatch(w.includes(id) ? w.filter((x) => x !== id) : [...w, id]);
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const query = q.trim().toLowerCase();

  if (source === 'telegram') {
    const shown = dialogs.filter((d) => !query || d.title.toLowerCase().includes(query));
    return (
      <aside className="browser">
        <div className="browser-head">
          <Logo source="telegram" size={16} /> <b>Telegram</b>
          <span className="muted">{cfg?.telegram.watch.length ?? 0} in feed</span>
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <input className="browser-search" placeholder="search chats…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chan-list">
          {dialogs.length === 0 && <div className="empty">Loading chats… (Telegram must be connected)</div>}
          {shown.map((d) => {
            const on = cfg?.telegram.watch.includes(d.id) ?? false;
            return (
              <div key={d.id} className={`chan${on ? ' chan-on' : ''}`}>
                <Avatar src={`/api/telegram/avatar/${d.id}`} name={d.title} size={28} />
                <span className="chan-name">{d.title}</span>
                <span className="muted">{d.type}</span>
                <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => toggle('telegram', d.id)}>
                  {on ? '✓ in feed' : '+ add'}
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

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

  return (
    <aside className="browser">
      <div className="browser-head">
        <Logo source="discord" size={16} /> <b>Discord</b>
        <span className="muted">{cfg?.discord.watch.length ?? 0} in feed</span>
        <button className="close" onClick={onClose}>
          close
        </button>
      </div>
      <div className="browser-body">
        <div className="guild-rail">
          {guilds.map((g) => (
            <button
              key={g.id}
              className={`guild${g.id === guild ? ' active' : ''}`}
              title={g.name}
              onClick={() => setGuild(g.id)}
            >
              {g.icon ? <img src={g.icon} alt="" loading="lazy" /> : <span>{g.name.slice(0, 2).toUpperCase()}</span>}
            </button>
          ))}
          {guilds.length === 0 && <div className="empty">Waiting for Discord…</div>}
        </div>
        <div className="chan-pane">
          <div className="chan-guild">{active?.name ?? ''}</div>
          <input className="browser-search" placeholder="search channels…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chan-list">
            {[...cats.entries()].map(([cat, chs]) => (
              <div key={cat || '_'}>
                {cat && <div className="chan-cat">{cat}</div>}
                {chs.map((c) => {
                  const on = cfg?.discord.watch.includes(c.id) ?? false;
                  return (
                    <div key={c.id} className={`chan${on ? ' chan-on' : ''}`}>
                      <span className="chan-hash">#</span>
                      <span className="chan-name">{c.name}</span>
                      <button className={`chan-toggle${on ? ' on' : ''}`} disabled={busy} onClick={() => toggle('discord', c.id)}>
                        {on ? '✓ in feed' : '+ add'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
