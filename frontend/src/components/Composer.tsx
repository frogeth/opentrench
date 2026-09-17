import { useEffect, useRef, useState } from 'react';
import type { FeedMessage } from '../types';
import { api } from '../api';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { commandIn, signature, useSlashMenu } from './SlashMenu';

export interface SendTarget {
  id: string;
  name: string;
  /** a chat you can actually post to; plugin chats are read-only */
  source: 'discord' | 'telegram';
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
  targetId: outerTargetId,
  onTargetChange,
}: {
  targets: SendTarget[];
  canSend: Record<'discord' | 'telegram', boolean>;
  reply?: FeedMessage;
  onCancelReply: () => void;
  onSent?: () => void;
  /** the chat to send to, when the column owns that choice (a click on a message picks it) */
  targetId?: string;
  onTargetChange?: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const [ownTargetId, setOwnTargetId] = useState<string>(targets[0]?.id ?? '');
  const targetId = outerTargetId ?? ownTargetId;
  const setTargetId = (id: string) => {
    setOwnTargetId(id);
    onTargetChange?.(id);
  };
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

  // a reply pins the target to that message's chat — and a reply to a chat this composer cannot
  // send to (a plugin chat, or one outside the column) is dropped rather than sent somewhere else
  const replyTarget = reply ? targets.find((t) => t.name === reply.chatName) : undefined;
  const target = reply ? replyTarget : targets.find((t) => t.id === targetId) ?? targets[0];
  useEffect(() => {
    if (reply && !replyTarget) onCancelReply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply, replyTarget]);
  useEffect(() => {
    if (reply) box.current?.focus();
  }, [reply]);
  useEffect(() => {
    if (!targets.some((t) => t.id === targetId)) setTargetId(targets[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, targetId]);

  const enabled = !!target && canSend[target.source];
  // "/" lists what this chat offers: Discord slash commands, or the commands of the bots in a Telegram chat
  const slash = useSlashMenu({
    text,
    setText,
    cacheKey: target ? `${target.source}:${target.id}` : '',
    enabled: enabled && !reply,
    load: (q) => (target ? api.commands(target.source, target.id, q) : Promise.resolve([])),
    onPick: (item) => void runOrSend(item.fill),
  });
  const typed = target?.source === 'discord' ? commandIn(text) : undefined;
  const typedCmd = typed ? slash.known(typed.name) : undefined;

  if (targets.length === 0) return null;
  const max = target?.source === 'discord' ? 2000 : 4096;

  /** a Discord `/command args` runs as a slash command; anything else is a message */
  const runOrSend = async (body: string) => {
    if (!target || busy || !enabled) return;
    setBusy(true);
    setErr(null);
    try {
      const cmd = target.source === 'discord' ? commandIn(body) : undefined;
      if (cmd && !reply) {
        try {
          await api.runCommand(target.id, cmd.name, cmd.args);
        } catch (e: any) {
          // no such command here: Discord itself would post it as text, so do the same
          if (!/^no \//.test(String(e?.message ?? ''))) throw e;
          await api.send(target.source, target.id, body);
        }
      } else await api.send(target.source, target.id, body);
      setText('');
      onSent?.();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };
  const send = async () => {
    const body = text.trim();
    if (!target || (!body && files.length === 0) || busy || !enabled) return;
    if (files.length === 0 && !reply && target.source === 'discord' && commandIn(body)) return runOrSend(body);
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
            if (slash.onKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape' && reply) onCancelReply();
          }}
        />
        {slash.menu}
        <button className="composer-send" disabled={!enabled || busy || (!text.trim() && files.length === 0)} onClick={() => void send()} title="send (Enter)">
          <Icon name="send" size={14} />
        </button>
      </div>
      <div className="composer-foot">
        {typedCmd ? (
          <span className="cmd-sig" title={typedCmd.description}>
            <b>{signature(typedCmd)}</b>
            {typedCmd.app && <span className="muted"> · {typedCmd.app}</span>}
            {typedCmd.description && <span className="muted"> · {typedCmd.description}</span>}
          </span>
        ) : (
          target?.source === 'discord' && enabled && <span className="composer-warn">sending as your Discord account (self-bot)</span>
        )}
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
