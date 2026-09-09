import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { copyText } from '../format';

/** "⋯" next to a name: favorite, copy name, open original, and (behind a confirm) blacklist the caller. */
export function AuthorMenu({ author, link, favorite = false }: { author: string; link?: string; favorite?: boolean }) {
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
          <button
            onClick={() => {
              void api.favoriteToggle(author).catch(() => {});
              close();
            }}
          >
            {favorite ? '👑 Unfavorite caller' : '👑 Favorite caller (pings on first calls)'}
          </button>
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
          {!confirm ? (
            <button className="amenu-danger" onClick={() => setConfirm(true)}>
              Blacklist caller…
            </button>
          ) : (
            <div className="amenu-confirm">
              <span>Hide {author} and drop their calls?</span>
              <button
                className="amenu-danger"
                onClick={() => {
                  void api.blacklistAdd(author).catch(() => {});
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
