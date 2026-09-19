import { useMemo, useState } from 'react';
import { canWrite } from '../feedKeys';
import type { DiscordChannel, WatchedChat } from '../api';
import { api } from '../api';
import { telegramShareUrl } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';

const MAX_TARGETS = 6;
const GAP_MS = 1300;
const key = (w: SendableChat) => `${w.source}:${w.id}`;

/** Sharing only ever reaches a platform chat: a plugin chat has nowhere to send to. */
export type SendableChat = Omit<WatchedChat, 'source'> & { source: 'discord' | 'telegram' };

/**
 * Share a contract address to chats in your feed, on either platform. Sends the
 * bare address and nothing else, one chat at a time with a pause between, and
 * only to platforms where sending is switched on.
 */
export interface ShareItem {
  /** exactly what gets sent */
  text: string;
  /** modal title, e.g. "Share $BONK" or "Share tweet" */
  title: string;
  /** what the preview line shows instead of the raw text (a tweet's first words, say) */
  preview?: string;
  hint?: string;
  /** called with the chat names each successful send went to */
  onSent?: (names: string[]) => void;
  /** how to deliver to one chat, instead of sending `text` (a forward, say); the note comes separately */
  send?: (target: SendableChat, note: string) => Promise<void>;
  /** the button's verb ("Forward") */
  verb?: string;
}

export function ShareModal({
  item,
  watched,
  channels = [],
  canSend,
  onClose,
}: {
  item: ShareItem;
  watched: WatchedChat[];
  channels?: DiscordChannel[];
  canSend: Record<'discord' | 'telegram', boolean>;
  onClose: () => void;
}) {
  const { text, title, preview, hint, onSent, send, verb = 'Share' } = item;
  // plugin chats are not somewhere you can post: they never show up as a share target
  const sendable = useMemo(() => watched.filter((w): w is SendableChat => canWrite(w.source)), [watched]);
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      const saved: string[] = JSON.parse(localStorage.getItem('trenchfeed.shareTargets') ?? '[]');
      return saved.filter((k) => sendable.some((w) => key(w) === k && canSend[w.source]));
    } catch {
      return [];
    }
  });
  const [status, setStatus] = useState<Record<string, 'sending' | 'sent' | string>>({});
  const [busy, setBusy] = useState(false);
  // an optional line above the address, the same one to every chat picked ("looks like a bundle, careful")
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const cat = new Map(channels.map((c) => [c.id, c.category]));
    const m = new Map<string, { source: 'discord' | 'telegram'; avatar?: string; items: { w: SendableChat; category?: string }[] }>();
    for (const w of sendable) {
      const server = w.source === 'discord' ? (/\(([^)]*)\)\s*$/.exec(w.name)?.[1] ?? 'Discord') : 'Telegram';
      const g = m.get(server) ?? { source: w.source, avatar: undefined, items: [] };
      if (!g.avatar && w.avatar && w.source === 'discord') g.avatar = w.avatar;
      g.items.push({ w, category: w.source === 'discord' ? cat.get(w.id) : undefined });
      m.set(server, g);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Telegram' ? 1 : b[0] === 'Telegram' ? -1 : a[0].localeCompare(b[0])));
  }, [sendable, channels]);
  const shortName = (w: SendableChat) => (w.source === 'discord' ? w.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '') : w.name);
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= MAX_TARGETS ? p : [...p, k]));

  const share = async () => {
    const targets = sendable.filter((w) => picked.includes(key(w)) && canSend[w.source]);
    if (targets.length === 0) return;
    setBusy(true);
    try {
      localStorage.setItem('trenchfeed.shareTargets', JSON.stringify(picked));
    } catch {}
    for (let i = 0; i < targets.length; i++) {
      const w = targets[i];
      setStatus((s) => ({ ...s, [key(w)]: 'sending' }));
      try {
        if (send) await send(w, note.trim());
        else await api.send(w.source, w.id, note.trim() ? `${note.trim()}\n${text}` : text);
        setStatus((s) => ({ ...s, [key(w)]: 'sent' }));
        onSent?.([shortName(w)]);
      } catch (e: any) {
        setStatus((s) => ({ ...s, [key(w)]: e?.message ?? 'failed' }));
      }
      if (i < targets.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    setBusy(false);
  };
  const allDone = picked.length > 0 && picked.every((k) => status[k] === 'sent');
  const anyDiscord = sendable.some((w) => w.source === 'discord');
  const anyTelegram = sendable.some((w) => w.source === 'telegram');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal">
        <div className="fed-head">
          <b>{title}</b>
          <button className="close" onClick={onClose} title="close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="share-body">
          <div className="share-ca">
            <code>{preview ?? text}</code>
            <span className="hint">{hint ?? 'Only this is sent, nothing else.'}</span>
            <textarea className="share-note" placeholder="Add a message above it (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1500} disabled={busy} />
          </div>
          {((anyDiscord && !canSend.discord) || (anyTelegram && !canSend.telegram)) && (
            <div className="hint share-off">
              {anyDiscord && !canSend.discord && <span>Discord chats are greyed out: enable sending in Settings → Accounts (read the warning first). </span>}
              {anyTelegram && !canSend.telegram && <span>Telegram chats are greyed out: enable sending in Settings → Accounts.</span>}
            </div>
          )}
          <div className="fed-tree share-tree">
            {groups.map(([server, g]) => {
              const isOpen = open[server] ?? true;
              let lastCat: string | undefined;
              return (
                <div key={server} className="ftree-group">
                  <div className="ftree-head">
                    <button className="ftree-arrow" onClick={() => setOpen((o) => ({ ...o, [server]: !isOpen }))}>
                      {isOpen ? '▾' : '▸'}
                    </button>
                    {g.avatar ? <Avatar src={g.avatar} name={server} size={18} /> : <Logo source={g.source} size={14} />}
                    <b onClick={() => setOpen((o) => ({ ...o, [server]: !isOpen }))}>{server}</b>
                    <span className="muted">{g.items.length}</span>
                  </div>
                  {isOpen &&
                    g.items.map(({ w, category }) => {
                      const showCat = category !== lastCat;
                      lastCat = category;
                      const k = key(w);
                      const st = status[k];
                      const off = !canSend[w.source];
                      return (
                        <div key={k}>
                          {showCat && category && <div className="ftree-cat">{category}</div>}
                          <label className={`ftree-item${off ? ' ftree-off' : ''}`} title={off ? 'sending is off for this platform' : undefined}>
                            <input type="checkbox" checked={picked.includes(k)} disabled={off || busy} onChange={() => toggle(k)} />
                            {w.source === 'discord' ? <span className="muted">#</span> : w.avatar ? <Avatar src={w.avatar} name={w.name} size={14} /> : <Logo source="telegram" size={12} />}
                            <span className="ftree-name">{shortName(w)}</span>
                            {st === 'sending' && <span className="share-st muted">sending…</span>}
                            {st === 'sent' && <span className="share-st up">sent ✓</span>}
                            {st && st !== 'sending' && st !== 'sent' && <span className="share-st err">{st}</span>}
                          </label>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            {sendable.length === 0 && <div className="hint">No chats in your feed yet.</div>}
          </div>
        </div>
        <div className="fed-foot">
          {!send && (
            <a className="fed-link" href={telegramShareUrl(text, preview ?? text)} target="_blank" rel="noreferrer" title="open the Telegram share sheet for chats outside your feed">
              share via the Telegram app instead
            </a>
          )}
          <span className="muted share-count">
            {picked.length}/{MAX_TARGETS}
          </span>
          <button onClick={onClose}>{allDone ? 'Done' : 'Cancel'}</button>
          <button className="primary" disabled={busy || picked.length === 0 || allDone} onClick={() => void share()}>
            {busy ? `${verb === 'Forward' ? 'Forwarding' : 'Sharing'}…` : `${verb} to ${picked.length || ''} chat${picked.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
