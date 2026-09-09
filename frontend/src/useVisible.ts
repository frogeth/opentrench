import { useEffect, useRef, useState, type RefObject } from 'react';

/** True while the element is within `margin` of the viewport (for lazy, unloadable embeds). */
export function useVisible<T extends HTMLElement>(margin = '400px'): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, visible];
}
