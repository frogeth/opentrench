import { useEffect, useRef, useState } from 'react';
import { api, type WatchedChat } from '../api';
import type { PersonSeen } from '../types';
import { Avatar } from './Avatar';

type Row = PersonSeen & { favorite?: boolean };
const norm = (n: string) => n.trim().replace(/^@/, '').toLowerCase();

/** What we know about someone, in one line. */
function meta(p: Row): string {
  if (p.member) return `hasn't posted here yet`;
  const bits: string[] = [];
  if (p.calls) bits.push(`${p.calls} call${p.calls === 1 ? '' : 's'}`);
  if (p.messages) bits.push(`${p.messages} message${p.messages === 1 ? '' : 's'}`);
  if (!bits.length) bits.push('seen in the feed');
  const where = p.chats.slice(0, 2).join(', ');
  return where ? `${bits.join(' · ')} · ${where}` : bits.join(' · ');
}

/**
 * Favorite anyone: search everyone the feed has seen (people who only chat included), or pick a
 * chat and browse its whole member list — so someone who has never posted can be favorited too.
 */
export function PeoplePicker({ favorites, onToggle }: { favorites: string[]; onToggle: (name: string) => Promise<unknown> }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(''); // '' = everyone seen; else "<source>:<chatId>"
  const [chats, setChats] = useState<WatchedChat[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const favs = new Set(favorites.map(norm));
  const listed = useRef<string>('');

  useEffect(() => {
    api.watched().then(setChats).catch(() => {});
  }, []);

  // a chat's member list loads once per chat; the search box then filters it locally
  useEffect(() => {
    let cancelled = false;
    if (scope) {
      if (listed.current === scope) return;
      listed.current = scope;
      setLoading(true);
      const [source, ...rest] = scope.split(':');
      api
        .members(source as 'discord' | 'telegram', rest.join(':'))
        .then((r) => !cancelled && setRows(Array.isArray(r) ? r : []))
        .catch(() => !cancelled && setRows([]))
        .finally(() => !cancelled && setLoading(false));
      return () => {
        cancelled = true;
      };
    }
    listed.current = '';
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .people(q)
        .then((r) => !cancelled && setRows(Array.isArray(r) ? r : []))
        .catch(() => !cancelled && setRows([]))
        .finally(() => !cancelled && setLoading(false));
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, scope]);

  const toggle = async (name: string) => {
    setBusy(name);
    try {
      await onToggle(name);
    } finally {
      setBusy(null);
    }
  };

  const typed = q.trim();
  const shown = scope && typed ? rows.filter((p) => norm(p.name).includes(norm(typed))) : rows;
  const exact = shown.some((p) => norm(p.name) === norm(typed));
  const chatName = chats.find((c) => `${c.source}:${c.id}` === scope)?.name;

  return (
    <div className="ppl">
      <div className="ppl-bar">
        <select value={scope} onChange={(e) => setScope(e.target.value)} title="browse one chat's members">
          <option value="">Everyone seen</option>
          {chats.map((c) => (
            <option key={`${c.source}:${c.id}`} value={`${c.source}:${c.id}`}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder={scope ? `filter ${chatName ?? 'members'}…` : 'search people to favorite…'} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="ppl-list">
        {loading && shown.length === 0 && <div className="ppl-empty">{scope ? 'loading members…' : 'searching…'}</div>}
        {!loading && shown.length === 0 && (
          <div className="ppl-empty">
            {scope
              ? 'No members came back. Telegram hides the member list of large channels, and Discord only knows the members its client has loaded — open the server in Discord and try again.'
              : typed
                ? 'Nobody by that name yet.'
                : 'Nobody has posted yet. Type a name, or pick a chat to browse its members.'}
          </div>
        )}
        {shown.slice(0, 300).map((p) => {
          const on = favs.has(norm(p.name));
          return (
            <button key={`${p.source}:${p.name}`} className={`ppl-row${on ? ' on' : ''}`} disabled={busy === p.name} onClick={() => void toggle(p.name)} title={on ? 'remove favorite' : 'favorite'}>
              <Avatar src={p.avatar} name={p.name} size={24} crown={on} />
              <span className="ppl-main">
                <span className="ppl-name">
                  <span className={`src-dot ${p.source}`} /> {p.name}
                  {p.bot && <span className="ppl-tag">bot</span>}
                </span>
                <span className="ppl-meta">{meta(p)}</span>
              </span>
              <span className="ppl-crown">{on ? '👑' : '+'}</span>
            </button>
          );
        })}
        {typed && !exact && !loading && (
          <button className="ppl-row ppl-raw" disabled={busy === typed} onClick={() => void toggle(typed)}>
            <span className="ppl-main">
              <span className="ppl-name">Favorite “{typed}” anyway</span>
              <span className="ppl-meta">use the exact name as it appears on their messages</span>
            </span>
            <span className="ppl-crown">+</span>
          </button>
        )}
      </div>
    </div>
  );
}
