import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SlashItem, SlashOption } from '../api';

/** `/name <required> [optional]`, mirrors the backend's signature() */
export function signature(cmd: { name: string; options?: SlashOption[] }): string {
  const opts = cmd.options ?? [];
  if (opts.some((o) => o.type === 1 || o.type === 2)) return `/${cmd.name} ${opts.map((o) => o.name).join(' | ')}`;
  return `/${cmd.name}${opts.map((o) => (o.required ? ` <${o.name}>` : ` [${o.name}]`)).join('')}`;
}

/** the command a box's text names: `/name` or `/name args…` */
export const commandIn = (text: string): { name: string; args: string } | undefined => {
  const m = /^\/([\w@-]{1,64})(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: m[2] ?? '' } : undefined;
};

/**
 * The "/" menu of a composer. While the box holds a bare `/prefix` it lists the commands the
 * chat offers (loaded per prefix, cached per key); arrows move, Enter or a click picks, Tab fills
 * the command in for arguments, Escape clears. `key` changes when the chat does, dropping the list.
 */
export function useSlashMenu({
  text,
  setText,
  load,
  onPick,
  cacheKey,
  enabled = true,
}: {
  text: string;
  setText: (t: string) => void;
  /** the commands matching a prefix; rejected loads show nothing */
  load: (q: string) => Promise<SlashItem[]>;
  /** a command chosen with Enter or a click (one without arguments to give) */
  onPick: (item: SlashItem) => void;
  cacheKey: string;
  enabled?: boolean;
}): { open: boolean; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; menu: ReactNode; known: (name: string) => SlashItem | undefined } {
  const q = enabled ? /^\/([\w-]*)$/.exec(text.trim())?.[1] : undefined;
  const open = q !== undefined;
  const [items, setItems] = useState<SlashItem[]>([]);
  const [idx, setIdx] = useState(0);
  // a name → item memory of everything loaded for this chat, so `/name args` finds its signature
  const seen = useRef(new Map<string, SlashItem>());
  const cache = useRef(new Map<string, SlashItem[]>());
  const keyRef = useRef(cacheKey);
  if (keyRef.current !== cacheKey) {
    keyRef.current = cacheKey;
    seen.current.clear();
    cache.current.clear();
  }
  useEffect(() => {
    if (q === undefined) return;
    const key = q.toLowerCase();
    const hit = cache.current.get(key);
    if (hit) {
      setItems(hit);
      setIdx(0);
      return;
    }
    // the broadest list already loaded narrows locally while the exact one arrives
    const base = cache.current.get('');
    if (base) setItems(base.filter((c) => c.name.toLowerCase().startsWith(key)));
    let alive = true;
    const timer = setTimeout(() => {
      load(q)
        .then((list) => {
          const filtered = list.filter((c) => c.name.toLowerCase().startsWith(key)).slice(0, 100);
          cache.current.set(key, filtered);
          for (const c of filtered) seen.current.set(c.name.toLowerCase(), c);
          if (alive) {
            setItems(filtered);
            setIdx(0);
          }
        })
        .catch(() => alive && setItems([]));
    }, key ? 120 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cacheKey]);

  const pick = (item: SlashItem) => {
    // a command that takes arguments is filled in for them; one that takes none runs
    if (item.options?.length) setText(`${item.fill} `);
    else {
      setText('');
      onPick(item);
    }
  };
  const list = open ? items : [];
  const cur = list[Math.min(idx, Math.max(0, list.length - 1))];
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || list.length === 0) {
      if (open && e.key === 'Escape') {
        setText('');
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => (i + 1) % list.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => (i - 1 + list.length) % list.length);
      return true;
    }
    if (e.key === 'Tab' && cur) {
      e.preventDefault();
      setText(`${cur.fill} `);
      return true;
    }
    if (e.key === 'Escape') {
      setText('');
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && cur) {
      e.preventDefault();
      pick(cur);
      return true;
    }
    return false;
  };
  const menu =
    open && list.length > 0 ? (
      <div className="cmd-list" role="listbox">
        <div
          className="cmd-rows"
          // the column body clips overflow, so the list gets the room above the box, never more
          ref={(el) => {
            const body = el?.closest('.col-body');
            const row = el?.closest('.composer-row');
            if (!el || !body || !row) return;
            const room = row.getBoundingClientRect().top - body.getBoundingClientRect().top - 44;
            el.style.maxHeight = `${Math.max(64, Math.min(220, room))}px`;
          }}
        >
          {list.map((c, i) => (
            <button
              key={`${c.app ?? ''}/${c.id ?? c.fill}`}
              className={`cmd${c === cur ? ' on' : ''}`}
              ref={c === cur ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
              title={c.options?.length ? signature(c) : `send ${c.fill}`}
            >
              {c.icon && <img src={c.icon} alt="" />}
              <b>{c.options?.length ? signature(c) : c.fill}</b>
              {c.description && <span>{c.description}</span>}
              {c.app && <i>{c.app}</i>}
            </button>
          ))}
        </div>
        <div className="cmd-hint">↑↓ pick · Enter send · Tab fill in</div>
      </div>
    ) : null;
  return { open, onKeyDown, menu, known: (name) => seen.current.get(name.toLowerCase().replace(/@.*$/, '')) };
}
