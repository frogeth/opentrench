import { useEffect, useState } from 'react';

const EVENT = 'trenchfeed:lightbox';

/** Open an image full-size, Discord style. Callable from anywhere without prop drilling. */
export function openImage(src: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src } }));
}

export function Lightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setSrc((e as CustomEvent<{ src: string }>).detail.src);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSrc(null);
    };
    window.addEventListener(EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!src) return null;
  return (
    <div className="lightbox" onMouseDown={() => setSrc(null)}>
      <img src={src} alt="" onMouseDown={(e) => e.stopPropagation()} />
      <a className="lightbox-open" href={src} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()}>
        Open original
      </a>
    </div>
  );
}
