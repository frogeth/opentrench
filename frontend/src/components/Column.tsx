import type { ReactNode, RefObject, UIEvent, DragEvent } from 'react';
import { Icon } from './Icon';

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
}: {
  title: string;
  subtitle?: string;
  count?: number;
  kind?: 'calls' | 'chat' | 'callers';
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyRef?: RefObject<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  footer?: ReactNode;
  onEdit?: () => void;
  onRemove?: () => void;
  /** drag-to-reorder wiring from the parent */
  drag?: { onDragStart: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void; dragging?: boolean; over?: boolean };
  /** fixed width (px); unset shares the row */
  width?: number;
  /** drag the right edge: called with the live width, and once more with `done` on release (0 = reset) */
  onResize?: (width: number, done: boolean) => void;
}) {
  return (
    <section
      className={`col ${className}${drag?.dragging ? ' col-dragging' : ''}${drag?.over ? ' col-over' : ''}${width ? ' col-fixed' : ''}`}
      style={width ? { flex: `0 0 ${width}px`, width } : undefined}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      <div className="col-head">
        {drag && (
          <span className="col-grip" draggable onDragStart={drag.onDragStart} title="drag to reorder" aria-label="Drag to reorder">
            <Icon name="grip" size={14} />
          </span>
        )}
        {kind && (
          <span className="col-kind" title={`${kind} column`}>
            <Icon name={kind === 'calls' ? 'calls' : kind === 'callers' ? 'people' : 'chat'} size={14} />
          </span>
        )}
        <div className="col-title">
          <h2>{title}</h2>
          {subtitle && <span className="col-sub">{subtitle}</span>}
        </div>
        {count !== undefined && <span className="col-count">{count}</span>}
        <div className="col-extra">{extra}</div>
        {(onEdit || onRemove) && (
          <div className="col-actions">
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
      {footer}
      {onResize && (
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
      )}
    </section>
  );
}
