import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PersonSeen } from '../types';
import { Avatar } from './Avatar';

const norm = (n: string) => n.trim().replace(/^@/, '').toLowerCase();

/** What we know about someone, in one line. */
function meta(p: PersonSeen): string {
  if (p.member) return `member of ${p.chats[0] ?? 'a chat'} · hasn't posted here yet`;
  const bits: string[] = [];
  if (p.calls) bits.push(`${p.calls} call${p.calls === 1 ? '' : 's'}`);
  if (p.messages) bits.push(`${p.messages} message${p.messages === 1 ? '' : 's'}`);
  if (!bits.length) bits.push('seen in the feed');
  const where = p.chats.slice(0, 2).join(', ');
  return where ? `${bits.join(' · ')} · ${where}` : bits.join(' · ');
}

/**
 * Search anyone to favorite: people the feed has seen (including those who only chat and never
 * call) plus chat members who have not posted at all. Falls back to the raw name you typed.
 */
export function PeoplePicker({ favorites, onToggle }: { favorites: string[]; onToggle: (name: string) => Promise<unknown> }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PersonSeen[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const favs = new Set(favorites.map(norm));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
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
  }, [q, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = async (name: string) => {
    setBusy(name);
    try {
      await onToggle(name);
    } finally {
      setBusy(null);
    }
  };
  const typed = q.trim();
  const exact = rows.some((p) => norm(p.name) === norm(typed));

  return (
    <div className="ppl" ref={box}>
      <input
        placeholder="search people to favorite…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="ppl-list">
          {loading && rows.length === 0 && <div className="ppl-empty">searching…</div>}
          {!loading && rows.length === 0 && !typed && <div className="ppl-empty">Nobody has posted yet. Type a name to search your servers and chats.</div>}
          {rows.map((p) => {
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
          {typed && !exact && (
            <button className="ppl-row ppl-raw" disabled={busy === typed} onClick={() => void toggle(typed)}>
              <span className="ppl-main">
                <span className="ppl-name">Favorite “{typed}” anyway</span>
                <span className="ppl-meta">use the exact name as it appears on their messages</span>
              </span>
              <span className="ppl-crown">+</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
