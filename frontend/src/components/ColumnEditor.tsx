import { useState } from 'react';
import type { ColumnDef, WatchedChat } from '../api';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { SOUNDS, playSound } from '../sounds';

export const chatKey = (w: { source: string; id: string }) => `${w.source}:${w.id}`;

/** Add or edit one column: type, title, and which watched chats feed it. */
export function ColumnEditor({
  col,
  watched,
  onSave,
  onClose,
}: {
  col?: ColumnDef;
  watched: WatchedChat[];
  onSave: (c: ColumnDef) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<ColumnDef['type']>(col?.type ?? 'chat');
  const [title, setTitle] = useState(col?.title ?? '');
  const [chats, setChats] = useState<string[]>(col?.chats ?? []);
  const [win, setWin] = useState<NonNullable<ColumnDef['window']>>(col?.window ?? '7d');
  const [alertOn, setAlertOn] = useState(col?.alert?.on ?? false);
  const [sound, setSound] = useState(col?.alert?.sound ?? 'ping');
  const [q, setQ] = useState('');
  const all = chats.length === 0;
  const toggle = (k: string) => setChats((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const shown = watched.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));
  // Group by Discord server ("#chan (Server)") with Telegram chats together at the end.
  const groups = (() => {
    const m = new Map<string, WatchedChat[]>();
    for (const w of shown) {
      const server = w.source === 'discord' ? (/\(([^)]*)\)\s*$/.exec(w.name)?.[1] ?? 'Discord') : 'Telegram';
      m.set(server, [...(m.get(server) ?? []), w]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Telegram' ? 1 : b[0] === 'Telegram' ? -1 : a[0].localeCompare(b[0])));
  })();
  const shortName = (w: WatchedChat) => (w.source === 'discord' ? w.name.replace(/\s*\([^)]*\)\s*$/, '') : w.name);
  const groupState = (list: WatchedChat[]) => {
    const n = list.filter((w) => chats.includes(chatKey(w))).length;
    return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
  };
  const toggleGroup = (list: WatchedChat[]) => {
    const keys = list.map(chatKey);
    setChats((s) => (groupState(list) === 'all' ? s.filter((k) => !keys.includes(k)) : [...new Set([...s, ...keys])]));
  };
  const save = () => {
    const t = title.trim() || (type === 'calls' ? (all ? 'All Calls' : 'Calls') : type === 'callers' ? 'Top Callers' : all ? 'All Chats' : 'Chats');
    onSave({
      ...(col ?? {}),
      id: col?.id ?? `c${Date.now().toString(36)}`,
      type,
      title: t,
      chats,
      ...(type === 'callers' ? { window: win } : {}),
      ...(type !== 'callers' ? { alert: { on: alertOn, sound } } : {}),
    });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-column">
        <div className="modal-head">
          <b>{col ? 'Edit column' : 'Add column'}</b>
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <div className="coled">
          <label className="coled-row">
            <span>Shows</span>
            <span className="seg">
              <button className={type === 'calls' ? 'active' : ''} onClick={() => setType('calls')}>
                Calls
              </button>
              <button className={type === 'chat' ? 'active' : ''} onClick={() => setType('chat')}>
                Chat
              </button>
              <button className={type === 'callers' ? 'active' : ''} onClick={() => setType('callers')}>
                Top Callers
              </button>
            </span>
          </label>
          {type === 'callers' && (
            <label className="coled-row">
              <span>Window</span>
              <span className="seg">
                {(['24h', '7d', '30d'] as const).map((w) => (
                  <button key={w} className={win === w ? 'active' : ''} onClick={() => setWin(w)}>
                    {w}
                  </button>
                ))}
              </span>
            </label>
          )}
          <label className="coled-row">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'calls' ? 'All Calls' : type === 'callers' ? 'Top Callers' : 'All Chats'} maxLength={40} />
          </label>
          {type !== 'callers' && (
            <div className="coled-row coled-alert">
              <span>Alert</span>
              <div className="coled-alert-body">
                <label className="check">
                  <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Play a sound when a new call lands in this column
                </label>
                <div className="sound-grid">
                  {SOUNDS.map((s) => (
                    <button key={s} className={`sound${sound === s ? ' active' : ''}`} onClick={() => { setSound(s); playSound(s); }} title={`use “${s}”`}>
                      <Icon name="play" size={10} /> {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="coled-row coled-chats">
            <span>Channels</span>
            <div className="coled-list">
              <label className="check coled-all">
                <input type="checkbox" checked={all} onChange={() => setChats([])} /> All watched channels
              </label>
              <input className="modal-search" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
              {groups.map(([server, list]) => {
                const st = groupState(list);
                return (
                  <div key={server} className="coled-group">
                    <label className="check coled-group-head">
                      <input
                        type="checkbox"
                        checked={st === 'all'}
                        ref={(el) => el && (el.indeterminate = st === 'some')}
                        onChange={() => toggleGroup(list)}
                      />
                      <Logo source={server === 'Telegram' ? 'telegram' : 'discord'} size={12} />
                      <b>{server}</b>
                      <span className="hint">{list.length}</span>
                    </label>
                    {list.map((w) => {
                      const k = chatKey(w);
                      return (
                        <label key={k} className="check coled-chat">
                          <input type="checkbox" checked={chats.includes(k)} onChange={() => toggle(k)} />
                          {w.avatar ? <Avatar src={w.avatar} name={w.name} size={16} /> : <Logo source={w.source} size={12} />}
                          <span className="coled-name">{shortName(w)}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              {watched.length === 0 && <div className="hint">No watched chats yet. Add some with the + in the rail.</div>}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="primary" onClick={save}>
            {col ? 'Save' : 'Add column'}
          </button>
        </div>
      </div>
    </div>
  );
}
