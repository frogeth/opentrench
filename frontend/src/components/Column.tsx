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
}: {
  title: string;
  subtitle?: string;
  count?: number;
  kind?: 'calls' | 'chat';
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
}) {
  return (
    <section className={`col ${className}${drag?.dragging ? ' col-dragging' : ''}${drag?.over ? ' col-over' : ''}`} onDragOver={drag?.onDragOver} onDrop={drag?.onDrop}>
      <div className="col-head">
        {drag && (
          <span className="col-grip" draggable onDragStart={drag.onDragStart} title="drag to reorder" aria-label="Drag to reorder">
            <Icon name="grip" size={14} />
          </span>
        )}
        {kind && (
          <span className="col-kind" title={kind === 'calls' ? 'calls column' : 'chat column'}>
            <Icon name={kind === 'calls' ? 'calls' : 'chat'} size={14} />
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
    </section>
  );
}
