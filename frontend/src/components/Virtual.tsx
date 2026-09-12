import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const heights = new Map<string, number>();

/**
 * Windowed rendering without a fixed row height: the children only mount
 * while the slot is near the column's viewport; otherwise a placeholder of
 * the last measured height (or the estimate) keeps the scroll geometry stable.
 */
export function VirtualItem({ id, estimate, children, domKey }: { id: string; estimate: number; children: ReactNode; /** data-key on the slot for scroll-to */ domKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    // Observe against the scrolling column, not the window, and always take the
    // newest record: a row that leaves and re-enters between two frames (the
    // list re-sorted under it) arrives as two records in one callback.
    const root = el.closest('.col-body') as HTMLElement | null;
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), { root, rootMargin: '800px 0px' });
    io.observe(el);
    // belt and braces: if the slot is inside the root right now, mount regardless of observer timing
    const r = el.getBoundingClientRect();
    const rr = root?.getBoundingClientRect();
    if (rr && r.bottom > rr.top - 800 && r.top < rr.bottom + 800) setNear(true);
    return () => io.disconnect();
  }, [id]);
  useLayoutEffect(() => {
    if (near && ref.current) {
      heights.set(id, ref.current.offsetHeight);
      if (heights.size > 4000) {
        const oldest = heights.keys().next().value;
        if (oldest !== undefined) heights.delete(oldest);
      }
    }
  });
  const h = heights.get(id) ?? estimate;
  return (
    <div ref={ref} className="vitem" data-key={domKey} style={near ? undefined : { height: h }}>
      {near ? children : null}
    </div>
  );
}
