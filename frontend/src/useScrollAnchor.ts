import { useLayoutEffect, useRef } from 'react';

/**
 * Keep whatever the reader is looking at where it is when the list under it changes
 * (new messages, a reload, the ring buffer dropping old rows). Call the returned
 * `capture` from the scroll handler; the hook restores on every `listKey` change
 * while `active()` says the reader is not pinned to the live end.
 */
export function useScrollAnchor(getScroller: () => HTMLElement | null, listKey: unknown, active: () => boolean) {
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const capture = () => {
    const el = getScroller();
    if (!el) return;
    const sr = el.getBoundingClientRect();
    let row = document.elementFromPoint(sr.left + Math.min(40, sr.width / 2), sr.top + 2)?.closest('[data-key]') as HTMLElement | null;
    if (!row) {
      for (const r of el.querySelectorAll<HTMLElement>('[data-key]')) {
        if (r.getBoundingClientRect().bottom > sr.top) {
          row = r;
          break;
        }
      }
    }
    anchor.current = row?.dataset.key ? { key: row.dataset.key, top: row.getBoundingClientRect().top - sr.top } : null;
  };
  useLayoutEffect(() => {
    const el = getScroller();
    const a = anchor.current;
    if (!el || !a || !active()) return;
    const row = el.querySelector(`[data-key="${CSS.escape(a.key)}"]`) as HTMLElement | null;
    if (!row) return;
    const diff = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
    if (Math.abs(diff) > 1) el.scrollTop += diff;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);
  return capture;
}
