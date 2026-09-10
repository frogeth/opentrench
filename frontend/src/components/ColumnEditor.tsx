import { useState } from 'react';
import type { ColumnDef, WatchedChat } from '../api';
import { Avatar } from './Avatar';
import { Logo } from './Logo';

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
  const [q, setQ] = useState('');
  const all = chats.length === 0;
  const toggle = (k: string) => setChats((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const shown = watched.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));
  const save = () => {
    const t = title.trim() || (type === 'calls' ? (all ? 'All Calls' : 'Calls') : all ? 'All Chats' : 'Chats');
    onSave({ id: col?.id ?? `c${Date.now().toString(36)}`, type, title: t, chats });
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
            </span>
          </label>
          <label className="coled-row">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'calls' ? 'All Calls' : 'All Chats'} maxLength={40} />
          </label>
          <div className="coled-row coled-chats">
            <span>Channels</span>
            <div className="coled-list">
              <label className="check coled-all">
                <input type="checkbox" checked={all} onChange={() => setChats([])} /> All watched channels
              </label>
              <input className="modal-search" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
              {shown.map((w) => {
                const k = chatKey(w);
                return (
                  <label key={k} className="check coled-chat">
                    <input type="checkbox" checked={chats.includes(k)} onChange={() => toggle(k)} />
                    {w.avatar ? <Avatar src={w.avatar} name={w.name} size={16} /> : <Logo source={w.source} size={12} />}
                    <span className="coled-name">{w.name}</span>
                  </label>
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
