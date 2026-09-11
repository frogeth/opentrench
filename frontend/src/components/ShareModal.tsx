import { useMemo, useState } from 'react';
import type { DiscordChannel, WatchedChat } from '../api';
import { api } from '../api';
import { telegramShareUrl } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';

const MAX_TARGETS = 6;
const GAP_MS = 1300;
const key = (w: WatchedChat) => `${w.source}:${w.id}`;

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
  const { text, title, preview, hint, onSent } = item;
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      const saved: string[] = JSON.parse(localStorage.getItem('trenchfeed.shareTargets') ?? '[]');
      return saved.filter((k) => watched.some((w) => key(w) === k && canSend[w.source]));
    } catch {
      return [];
    }
  });
  const [status, setStatus] = useState<Record<string, 'sending' | 'sent' | string>>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const cat = new Map(channels.map((c) => [c.id, c.category]));
    const m = new Map<string, { source: 'discord' | 'telegram'; avatar?: string; items: { w: WatchedChat; category?: string }[] }>();
    for (const w of watched) {
      const server = w.source === 'discord' ? (/\(([^)]*)\)\s*$/.exec(w.name)?.[1] ?? 'Discord') : 'Telegram';
      const g = m.get(server) ?? { source: w.source, avatar: undefined, items: [] };
      if (!g.avatar && w.avatar && w.source === 'discord') g.avatar = w.avatar;
      g.items.push({ w, category: w.source === 'discord' ? cat.get(w.id) : undefined });
      m.set(server, g);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Telegram' ? 1 : b[0] === 'Telegram' ? -1 : a[0].localeCompare(b[0])));
  }, [watched, channels]);
  const shortName = (w: WatchedChat) => (w.source === 'discord' ? w.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '') : w.name);
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= MAX_TARGETS ? p : [...p, k]));

  const share = async () => {
    const targets = watched.filter((w) => picked.includes(key(w)) && canSend[w.source]);
    if (targets.length === 0) return;
    setBusy(true);
    try {
      localStorage.setItem('trenchfeed.shareTargets', JSON.stringify(picked));
    } catch {}
    for (let i = 0; i < targets.length; i++) {
      const w = targets[i];
      setStatus((s) => ({ ...s, [key(w)]: 'sending' }));
      try {
        await api.send(w.source, w.id, text);
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
  const anyDiscord = watched.some((w) => w.source === 'discord');
  const anyTelegram = watched.some((w) => w.source === 'telegram');

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
            {watched.length === 0 && <div className="hint">No chats in your feed yet.</div>}
          </div>
        </div>
        <div className="fed-foot">
          <a className="fed-link" href={telegramShareUrl(text, preview ?? text)} target="_blank" rel="noreferrer" title="open the Telegram share sheet for chats outside your feed">
            share via the Telegram app instead
          </a>
          <span className="muted share-count">
            {picked.length}/{MAX_TARGETS}
          </span>
          <button onClick={onClose}>{allDone ? 'Done' : 'Cancel'}</button>
          <button className="primary" disabled={busy || picked.length === 0 || allDone} onClick={() => void share()}>
            {busy ? 'Sharing…' : `Share to ${picked.length || ''} chat${picked.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
