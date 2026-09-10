import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const heights = new Map<string, number>();

/**
 * Windowed rendering without a fixed row height: the children only mount
 * while the slot is near the viewport; otherwise a placeholder of the last
 * measured height (or the estimate) keeps the scroll geometry stable.
 */
export function VirtualItem({ id, estimate, children }: { id: string; estimate: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (near && ref.current) heights.set(id, ref.current.offsetHeight);
  });
  const h = heights.get(id) ?? estimate;
  return (
    <div ref={ref} className="vitem" style={near ? undefined : { height: h }}>
      {near ? children : null}
    </div>
  );
}
