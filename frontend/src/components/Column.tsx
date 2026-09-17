import { useEffect, useRef, type ReactNode, type RefObject, type UIEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ColumnDef } from '../api';
import { Icon } from './Icon';

/**
 * Follows one pointer from `down` until it is released: the handle captures the pointer, so a release over a chart or
 * website iframe (which would otherwise swallow it) or a trackpad cancel still ends the drag, and the resize cursor holds.
 */
function trackPointer(down: ReactPointerEvent<HTMLElement>, cursor: string, move: (ev: PointerEvent) => void, end: (ev: PointerEvent) => void) {
  down.preventDefault();
  const el = down.currentTarget;
  const id = down.pointerId;
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    el.removeEventListener('pointermove', remember);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', finish);
    el.removeEventListener('lostpointercapture', finish);
    window.removeEventListener('blur', onBlur);
    document.body.style.cursor = '';
    try { el.releasePointerCapture(id); } catch { /* already released */ }
    end(ev);
  };
  const onMove = (ev: PointerEvent) => { if (ev.pointerId === id) move(ev); };
  const onBlur = () => finish(new PointerEvent('pointercancel', { pointerId: id, clientX: last.x, clientY: last.y }));
  const last = { x: down.clientX, y: down.clientY };
  const remember = (ev: PointerEvent) => { last.x = ev.clientX; last.y = ev.clientY; };
  el.addEventListener('pointermove', remember);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  window.addEventListener('blur', onBlur);
  document.body.style.cursor = cursor;
  try { el.setPointerCapture(id); } catch { /* no capture (synthetic event): the listeners above still run while the pointer is over the handle */ }
}

/** The draggable right edge of a column (or a stack of two): live width while dragging, final on release, 0 on double-click = reset. */
export function ResizeHandle({ onResize }: { onResize: (width: number, done: boolean) => void }) {
  return (
    <div
      className="col-resize"
      title="drag to resize · double-click to reset"
      onDoubleClick={() => onResize(0, true)}
      onPointerDown={(e) => {
        const col = e.currentTarget.parentElement!;
        const startX = e.clientX;
        const startW = col.getBoundingClientRect().width;
        const clamp = (x: number) => Math.max(320, Math.min(1600, Math.round(startW + x - startX)));
        trackPointer(e, 'col-resize', (ev) => onResize(clamp(ev.clientX), false), (ev) => onResize(clamp(ev.clientX), true));
      }}
    />
  );
}

/** The divider between a stacked pair: drag sets the top share (0.2–0.8), double-click halves it. */
export function SplitHandle({ onRatio }: { onRatio: (ratio: number, done: boolean) => void }) {
  return (
    <div
      className="col-split"
      title="drag to resize · double-click to even out"
      onDoubleClick={() => onRatio(0.5, true)}
      onPointerDown={(e) => {
        const stack = e.currentTarget.parentElement!;
        const at = (y: number) => {
          const r = stack.getBoundingClientRect();
          return Math.max(0.2, Math.min(0.8, (y - r.top) / Math.max(1, r.height)));
        };
        trackPointer(e, 'row-resize', (ev) => onRatio(at(ev.clientY), false), (ev) => onRatio(at(ev.clientY), true));
      }}
    />
  );
}

/**
 * A terminal column: 48px header (grip · type icon · title/subtitle · count · actions) over a scrolling body.
 * Drag the grip onto another column to reorder; pencil edits, × removes (after a confirm).
 */
export function Column({
  title,
  subtitle,
  count,
  kind,
  extra,
  children,
  className = '',
  bodyRef,
  onScroll,
  footer,
  onEdit,
  onRemove,
  drag,
  width,
  onResize,
  alertOn,
  onAlert,
  fill = false,
  filtered = false,
  composer,
  stacked = false,
  stackShare = 0.5,
  zoom,
  onZoom,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  kind?: ColumnDef['type'];
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyRef?: RefObject<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  footer?: ReactNode;
  onEdit?: () => void;
  onRemove?: () => void;
  /** drag-to-reorder wiring from the parent */
  drag?: { onDragStart: (e: DragEvent) => void; onDragEnd?: () => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; dragging?: boolean; /** where a drop lands: in front of this column, or stacked under it */ zone?: 'before' | 'stack' };
  /** fixed width (px); unset shares the row */
  width?: number;
  /** drag the right edge: called with the live width, and once more with `done` on release (0 = reset) */
  onResize?: (width: number, done: boolean) => void;
  /** per-column sound alert state; the bell toggles it */
  alertOn?: boolean;
  onAlert?: () => void;
  /** the last column: stretches over whatever the others leave */
  fill?: boolean;
  /** filters set on this column (lights the funnel) */
  filtered?: boolean;
  /** message box under the body (chat columns) */
  composer?: ReactNode;
  /** one half of a vertical stack: the stack owns the width, this takes `stackShare` of the height */
  stacked?: boolean;
  stackShare?: number;
  /** content scale for this column only (0.5–1.5); ctrl/⌘ + wheel over the column changes it, the header chip resets it */
  zoom?: number;
  onZoom?: (zoom: number) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const latest = useRef({ zoom: zoom ?? 1, onZoom });
  latest.current = { zoom: zoom ?? 1, onZoom };
  // ctrl/⌘ + wheel (and a trackpad pinch, which arrives as a ctrl-wheel) zooms this column, not the page.
  // A React onWheel is passive and could not preventDefault the browser's own zoom, so the listener is attached by hand.
  useEffect(() => {
    const el = section.current;
    if (!el || !onZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { zoom: cur, onZoom: set } = latest.current;
      if (!set || e.deltaY === 0) return;
      const step = Math.abs(e.deltaY) < 10 ? 0.02 : 0.05; // pinch sends small deltas
      const next = Math.min(1.5, Math.max(0.5, Math.round((cur + (e.deltaY > 0 ? -step : step)) * 100) / 100));
      if (next === cur) return;
      latest.current.zoom = next; // ticks inside one frame compound instead of all starting from the rendered value
      set(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [!!onZoom]);
  return (
    <section
      ref={section}
      className={`col ${className}${drag?.dragging ? ' col-dragging' : ''}${width ? ' col-fixed' : ''}${stacked ? ' col-stacked' : ''}`}
      style={stacked ? { flex: `${stackShare} 1 0px` } : fill ? { flex: `1 1 ${width ?? 380}px` } : width ? { flex: `0 0 ${width}px` } : undefined}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      <div className="col-head">
        {drag && (
          <span className="col-grip" draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} title="drag onto another column: its left half puts this one in front, its lower half stacks it underneath" aria-label="Drag to move or stack">
            <Icon name="grip" size={14} />
          </span>
        )}
        {kind && (
          <span className="col-kind" title={`${kind} column`}>
            <Icon name={kind === 'mints' ? 'mint' : kind === 'nftvol' ? 'sea' : kind === 'osmint' ? 'wallet' : kind === 'calls' ? 'calls' : kind === 'callers' ? 'people' : kind === 'trending' ? 'top' : kind === 'cove' || kind === 'tgbot' ? 'send' : kind === 'salpha' ? 'search' : kind === 'j7' ? 'x' : kind === 'web' ? 'globe' : kind === 'plugin' ? 'plug' : 'chat'} size={14} />
          </span>
        )}
        <div className="col-title">
          <h2>{title}</h2>
          {subtitle && <span className="col-sub">{subtitle}</span>}
        </div>
        {count !== undefined && <span className="col-count">{count}</span>}
        {zoom !== undefined && zoom !== 1 && onZoom && (
          <button className="col-zoom" onClick={() => onZoom(1)} title="this column's zoom — click to reset · ctrl/⌘ + scroll over the column to change">
            {Math.round(zoom * 100)}%
          </button>
        )}
        <div className="col-extra">{extra}</div>
        {(onEdit || onRemove || onAlert) && (
          <div className="col-actions">
            {onAlert && (
              <button className={`col-btn${alertOn ? ' col-btn-on' : ''}`} onClick={onAlert} title={alertOn ? 'Alerts on — click to mute (sound in ✎)' : 'Alert on new calls here'} aria-label="Edit alerts">
                <Icon name="bell" size={14} />
              </button>
            )}
            {onEdit && (
              <button className={`col-btn${filtered ? ' col-btn-on' : ''}`} onClick={onEdit} title={filtered ? 'Filters on — click to edit' : 'Filter this column'} aria-label="Filter column">
                <Icon name="filter" size={14} />
              </button>
            )}
            {onEdit && (
              <button className="col-btn" onClick={onEdit} title="Edit column" aria-label="Edit column">
                <Icon name="pencil" size={14} />
              </button>
            )}
            {onRemove && (
              <button className="col-btn" onClick={onRemove} title="Remove column" aria-label="Remove column">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="col-body" ref={bodyRef} onScroll={onScroll} style={zoom !== undefined && zoom !== 1 ? { zoom } : undefined}>
        {children}
      </div>
      {composer}
      {footer}
      {drag?.zone && <div className={`col-drop col-drop-${drag.zone}`} aria-hidden />}
      {onResize && !stacked && <ResizeHandle onResize={onResize} />}
    </section>
  );
}
