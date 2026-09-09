import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { copyText } from '../format';

/**
 * "⋯" next to a name. People: favorite, copy, open, and (behind a confirm) blacklist.
 * Bots: show/hide this bot (the bot policy in settings decides the default).
 * Anyone hidden: unhide.
 */
export function AuthorMenu({
  author,
  link,
  favorite = false,
  bot = false,
  hidden = false,
  onChanged,
}: {
  author: string;
  link?: string;
  favorite?: boolean;
  bot?: boolean;
  hidden?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setConfirm(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirm(false);
  };

  return (
    <span className="amenu" ref={ref}>
      <button className="amenu-btn" title="more" onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="amenu-pop">
          {bot ? (
            <button
              onClick={() => {
                void api.botShow(author, hidden).then(onChanged).catch(() => {});
                close();
              }}
            >
              {hidden ? '🤖 Show this bot (counts its calls)' : '🤖 Hide this bot'}
            </button>
          ) : hidden ? (
            <button
              onClick={() => {
                void api.botShow(author, true).then(onChanged).catch(() => {});
                close();
              }}
            >
              Unblock caller
            </button>
          ) : (
            <button
              onClick={() => {
                void api.favoriteToggle(author).then(onChanged).catch(() => {});
                close();
              }}
            >
              {favorite ? '👑 Unfavorite caller' : '👑 Favorite caller (pings on first calls)'}
            </button>
          )}
          <button
            onClick={() => {
              void copyText(author);
              close();
            }}
          >
            Copy name
          </button>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" onClick={close}>
              Open original
            </a>
          )}
          {bot || hidden ? null : !confirm ? (
            <button className="amenu-danger" onClick={() => setConfirm(true)}>
              Blacklist caller…
            </button>
          ) : (
            <div className="amenu-confirm">
              <span>Hide {author} and drop their calls?</span>
              <button
                className="amenu-danger"
                onClick={() => {
                  void api.blacklistAdd(author).then(onChanged).catch(() => {});
                  close();
                }}
              >
                Blacklist
              </button>
              <button onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
