import { useEffect, useMemo, useState } from 'react';
import type { FeedMessage, Mention, Source } from '../types';
import { timeAgo } from '../format';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Icon } from './Icon';

const chatShort = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '');
const KIND = { user: '@you', everyone: '@everyone', role: '@role' } as const;

/** One line of context: raw platform mention markup made readable, whitespace collapsed. */
function oneLine(m: FeedMessage): string {
  const t = (m.body ?? m.text ?? '')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/\s+/g, ' ')
    .trim();
  return t || (m.hasAttachment || m.media?.length ? '📎 media' : m.embeds?.length ? '(embed)' : '');
}

function CtxRow({ m, hit, now, onJump }: { m: FeedMessage; hit?: boolean; now: number; onJump: (id: string) => void }) {
  return (
    <div className={`ping-row${hit ? ' ping-hit' : ''}`} onClick={() => onJump(m.id)} title="jump to this message">
      <span className="ping-row-time">{timeAgo(m.ts, now)}</span>
      <span className="ping-row-who">{m.author}</span>
      <span className="ping-row-text">{oneLine(m)}</span>
    </div>
  );
}

/**
 * Pings: everyone who mentioned you, newest first, each with a few messages before and after
 * so the ping reads in context. Lives bottom-left; minimizes to a pill.
 */
export function PingsPanel({
  mentions,
  now,
  open,
  canSend,
  onOpen,
  onRead,
  onJump,
}: {
  mentions: Mention[];
  now: number;
  open: boolean;
  canSend: Record<Source, boolean>;
  onOpen: (open: boolean) => void;
  onRead: (ids?: string[]) => void;
  onJump: (id: string) => void;
}) {
  const [replying, setReplying] = useState<string | null>(null);
  const list = useMemo(() => [...mentions].sort((a, b) => b.msg.ts - a.msg.ts), [mentions]);
  const unread = list.filter((m) => !m.read).length;
  useEffect(() => {
    if (!open) setReplying(null);
  }, [open]);

  if (!open) {
    if (list.length === 0) return null;
    return (
      <button className={`pings-pill${unread ? ' has-unread' : ''}`} onClick={() => onOpen(true)} title="open pings">
        <Icon name="reply" size={11} /> Pings{unread ? <span className="pings-count">{unread}</span> : null}
      </button>
    );
  }
  return (
    <div className="pings">
      <div className="pings-head">
        <b>Pings</b>
        {unread > 0 && <span className="pings-count">{unread}</span>}
        <span className="pings-spacer" />
        {unread > 0 && (
          <button className="hdr-toggle" onClick={() => onRead()}>
            mark all read
          </button>
        )}
        <button className="pings-min" onClick={() => onOpen(false)} title="minimize">
          –
        </button>
      </div>
      <div className="pings-body">
        {list.length === 0 && <div className="empty">Nobody has pinged you yet. Mentions, replies to you, @everyone and your roles land here.</div>}
        {list.map((p) => {
          const m = p.msg;
          const waiting = p.after.length < 4 && now - m.ts < 30 * 60_000;
          return (
            <div key={p.id} className={`ping${p.read ? '' : ' ping-unread'}`} onMouseEnter={() => !p.read && onRead([p.id])}>
              <div className="ping-head">
                <Avatar src={m.avatar} name={m.author} size={22} />
                <span className="ping-who">
                  <b>{m.author}</b>
                  <span className="muted">
                    <span className={`src-dot ${m.source}`} /> {chatShort(m.chatName)}
                  </span>
                </span>
                <span className="ping-kind">{KIND[m.mention ?? 'user']}</span>
                <span className="ping-time muted">{timeAgo(m.ts, now)}</span>
                {!p.read && <span className="ping-dot" />}
              </div>
              <div className="ping-ctx">
                {p.before.map((x) => (
                  <CtxRow key={x.id} m={x} now={now} onJump={onJump} />
                ))}
                <CtxRow m={m} hit now={now} onJump={onJump} />
                {p.after.map((x) => (
                  <CtxRow key={x.id} m={x} now={now} onJump={onJump} />
                ))}
                {waiting && p.after.length === 0 && <div className="ping-wait muted">waiting for what comes next…</div>}
              </div>
              <div className="ping-actions">
                <button className="hdr-toggle" onClick={() => onJump(m.id)}>
                  jump to chat
                </button>
                <button className={`hdr-toggle${replying === p.id ? ' on' : ''}`} onClick={() => setReplying((r) => (r === p.id ? null : p.id))}>
                  reply
                </button>
              </div>
              {replying === p.id && (
                <div className="ping-reply">
                  <Composer targets={[{ id: m.chatId, name: m.chatName, source: m.source }]} canSend={canSend} reply={m} onCancelReply={() => setReplying(null)} onSent={() => setReplying(null)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
