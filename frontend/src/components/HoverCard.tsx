import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Hover popover anchored to its trigger, rendered in a portal with fixed
 * positioning so it escapes the card's overflow clipping. Opens after a short
 * delay, stays open while the pointer is on the trigger or the card.
 */
export function HoverCard({
  children,
  card,
  delay = 220,
  width = 300,
  className = '',
  onOpen,
}: {
  children: ReactNode;
  card: ReactNode;
  delay?: number;
  width?: number;
  className?: string;
  /** called once when the card opens (start lazy loading) */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const opened = useRef(false);

  const place = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    let left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin);
    const spaceBelow = window.innerHeight - r.bottom;
    const above = spaceBelow < 260 && r.top > spaceBelow;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  };
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      place();
      setOpen(true);
      if (!opened.current) {
        opened.current = true;
        onOpen?.();
      }
    }, delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const off = () => setOpen(false);
    window.addEventListener('scroll', off, true);
    window.addEventListener('resize', off);
    return () => {
      window.removeEventListener('scroll', off, true);
      window.removeEventListener('resize', off);
    };
  }, [open]);

  return (
    <span ref={anchor} className={`hc-anchor ${className}`} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open &&
        pos &&
        createPortal(
          <div
            className={`hc${pos.above ? ' hc-above' : ''}`}
            style={{ left: pos.left, top: pos.top, width, transform: pos.above ? 'translateY(-100%)' : undefined }}
            onMouseEnter={() => window.clearTimeout(timer.current)}
            onMouseLeave={hide}
          >
            {card}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Tiny text tooltip using the same mechanics. */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <HoverCard card={<div className="hc-tip">{text}</div>} width={220} delay={150} className="hc-inline">
      {children}
    </HoverCard>
  );
}
