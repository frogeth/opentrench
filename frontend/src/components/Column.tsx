import type { ReactNode, RefObject, UIEvent, DragEvent } from 'react';
import { Icon } from './Icon';

/** The draggable right edge of a column (or a stack of two): live width while dragging, final on release, 0 on double-click = reset. */
export function ResizeHandle({ onResize }: { onResize: (width: number, done: boolean) => void }) {
  return (
    <div
      className="col-resize"
      title="drag to resize · double-click to reset"
      onDoubleClick={() => onResize(0, true)}
      onPointerDown={(e) => {
        e.preventDefault();
        const col = (e.currentTarget as HTMLElement).parentElement!;
        const startX = e.clientX;
        const startW = col.getBoundingClientRect().width;
        const clamp = (x: number) => Math.max(320, Math.min(1600, Math.round(startW + x - startX)));
        const move = (ev: PointerEvent) => onResize(clamp(ev.clientX), false);
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          onResize(clamp(ev.clientX), true);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
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
        e.preventDefault();
        const stack = (e.currentTarget as HTMLElement).parentElement!;
        const at = (y: number) => {
          const r = stack.getBoundingClientRect();
          return Math.max(0.2, Math.min(0.8, (y - r.top) / Math.max(1, r.height)));
        };
        const move = (ev: PointerEvent) => onRatio(at(ev.clientY), false);
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          onRatio(at(ev.clientY), true);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
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
}: {
  title: string;
  subtitle?: string;
  count?: number;
  kind?: 'calls' | 'chat' | 'callers' | 'cove' | 'salpha' | 'j7' | 'web';
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyRef?: RefObject<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  footer?: ReactNode;
  onEdit?: () => void;
  onRemove?: () => void;
  /** drag-to-reorder wiring from the parent */
  drag?: { onDragStart: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; dragging?: boolean; over?: boolean; /** the drag would stack under this column */ stack?: boolean };
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
}) {
  return (
    <section
      className={`col ${className}${drag?.dragging ? ' col-dragging' : ''}${drag?.over ? ' col-over' : ''}${drag?.stack ? ' col-over-stack' : ''}${width ? ' col-fixed' : ''}${stacked ? ' col-stacked' : ''}`}
      style={stacked ? { flex: `${stackShare} 1 0px` } : fill ? { flex: `1 1 ${width ?? 380}px` } : width ? { flex: `0 0 ${width}px` } : undefined}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      <div className="col-head">
        {drag && (
          <span className="col-grip" draggable onDragStart={drag.onDragStart} title="drag to reorder · drop on the lower half of a column to stack under it" aria-label="Drag to reorder or stack">
            <Icon name="grip" size={14} />
          </span>
        )}
        {kind && (
          <span className="col-kind" title={`${kind} column`}>
            <Icon name={kind === 'calls' ? 'calls' : kind === 'callers' ? 'people' : kind === 'cove' ? 'send' : kind === 'salpha' ? 'search' : kind === 'j7' ? 'x' : kind === 'web' ? 'globe' : 'chat'} size={14} />
          </span>
        )}
        <div className="col-title">
          <h2>{title}</h2>
          {subtitle && <span className="col-sub">{subtitle}</span>}
        </div>
        {count !== undefined && <span className="col-count">{count}</span>}
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
      <div className="col-body" ref={bodyRef} onScroll={onScroll}>
        {children}
      </div>
      {composer}
      {footer}
      {onResize && !stacked && <ResizeHandle onResize={onResize} />}
    </section>
  );
}
