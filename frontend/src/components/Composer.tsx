import { useEffect, useRef, useState } from 'react';
import type { FeedMessage, Source } from '../types';
import { api } from '../api';
import { Logo } from './Logo';
import { Icon } from './Icon';

export interface SendTarget {
  id: string;
  name: string;
  source: Source;
}

/** Platform message id from our feed id: discord:<id> | telegram:<chat>:<id> */
export function platformMessageId(m: FeedMessage): string | undefined {
  const parts = m.id.split(':');
  return parts[parts.length - 1] || undefined;
}

/**
 * Message box at the foot of a chat column. Picks a target when the column
 * follows several chats, shows the reply it is answering, and refuses to do
 * anything a human did not type: Enter sends, Shift+Enter is a newline.
 */
export function Composer({
  targets,
  canSend,
  reply,
  onCancelReply,
  onSent,
}: {
  targets: SendTarget[];
  canSend: Record<Source, boolean>;
  reply?: FeedMessage;
  onCancelReply: () => void;
  onSent?: () => void;
}) {
  const [text, setText] = useState('');
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // images pasted or dropped in, sent as attachments (the first one carries the text as its caption)
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const addFiles = (list: Iterable<File>) => {
    const imgs = [...list].filter((f) => f.type.startsWith('image/')).slice(0, 4);
    if (imgs.length) setFiles((cur) => [...cur, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 4));
  };
  const removeFile = (url: string) =>
    setFiles((cur) => {
      URL.revokeObjectURL(url);
      return cur.filter((f) => f.url !== url);
    });

  // a reply pins the target to that message's chat
  const replyTarget = reply ? targets.find((t) => t.name === reply.chatName) : undefined;
  const target = replyTarget ?? targets.find((t) => t.id === targetId) ?? targets[0];
  useEffect(() => {
    if (reply) box.current?.focus();
  }, [reply]);
  useEffect(() => {
    if (!targets.some((t) => t.id === targetId)) setTargetId(targets[0]?.id ?? '');
  }, [targets, targetId]);

  if (targets.length === 0) return null;
  const enabled = !!target && canSend[target.source];
  const max = target?.source === 'discord' ? 2000 : 4096;

  const send = async () => {
    const body = text.trim();
    if (!target || (!body && files.length === 0) || busy || !enabled) return;
    setBusy(true);
    setErr(null);
    try {
      const replyTo = reply ? platformMessageId(reply) : undefined;
      if (files.length) {
        for (let i = 0; i < files.length; i++) {
          await api.sendFile(target.source, target.id, files[i].file, i === 0 ? body : '', i === 0 ? replyTo : undefined);
          if (i < files.length - 1) await new Promise((r) => setTimeout(r, 1100));
        }
        for (const f of files) URL.revokeObjectURL(f.url);
        setFiles([]);
      } else await api.send(target.source, target.id, body, replyTo);
      setText('');
      onCancelReply();
      onSent?.();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  return (
    <div className={`composer${target?.source === 'discord' ? ' composer-discord' : ''}`}>
      {reply && (
        <div className="composer-reply">
          <span className="reply-arrow">↩</span> Replying to <b>{reply.author}</b>
          <span className="muted"> in {reply.chatName.replace(/\s*\([^)]*\)\s*$/, '')}</span>
          <span className="composer-reply-text">{reply.text.slice(0, 80)}</span>
          <button onClick={onCancelReply} title="cancel reply">
            ✕
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <span key={f.url} className="composer-file">
              <img src={f.url} alt="" />
              <button onClick={() => removeFile(f.url)} title="remove">
                ×
              </button>
            </span>
          ))}
          <span className="muted">{files.length === 1 ? 'image attached' : `${files.length} images`} · paste or drop to add</span>
        </div>
      )}
      <div className="composer-row">
        {targets.length > 1 && !replyTarget ? (
          <select className="composer-target" value={target?.id} onChange={(e) => setTargetId(e.target.value)} title="send to">
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.source === 'discord' ? '#' : ''}
                {t.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '')}
              </option>
            ))}
          </select>
        ) : (
          <span className="composer-target composer-target-fixed" title={target?.name}>
            {target && <Logo source={target.source} size={11} />} {target?.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '')}
          </span>
        )}
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={!enabled}
          readOnly={busy}
          placeholder={
            !target ? 'no chat' : enabled ? `Message ${target.source === 'discord' ? '#' : ''}${target.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '')}` : `Sending on ${target.source === 'discord' ? 'Discord' : 'Telegram'} is off — enable it in Settings → Accounts`
          }
          maxLength={max}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const items = [...(e.clipboardData?.files ?? [])];
            if (items.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault();
              addFiles(items);
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer?.files?.length) {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape' && reply) onCancelReply();
          }}
        />
        <button className="composer-send" disabled={!enabled || busy || (!text.trim() && files.length === 0)} onClick={() => void send()} title="send (Enter)">
          <Icon name="send" size={14} />
        </button>
      </div>
      <div className="composer-foot">
        {target?.source === 'discord' && enabled && <span className="composer-warn">sending as your Discord account (self-bot)</span>}
        {text.length > max * 0.8 && (
          <span className={text.length >= max ? 'err' : 'muted'}>
            {text.length}/{max}
          </span>
        )}
        {err && <span className="err">{err}</span>}
      </div>
    </div>
  );
}
