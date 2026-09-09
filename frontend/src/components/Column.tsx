import type { ReactNode, RefObject, UIEvent } from 'react';

export function Column({
  title,
  count,
  extra,
  children,
  className = '',
  bodyRef,
  onScroll,
  footer,
}: {
  title: string;
  count?: number;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyRef?: RefObject<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  footer?: ReactNode;
}) {
  return (
    <section className={`col ${className}`}>
      <div className="col-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="col-count">{count}</span>}
        <div className="col-extra">{extra}</div>
      </div>
      <div className="col-body" ref={bodyRef} onScroll={onScroll}>
        {children}
      </div>
      {footer}
    </section>
  );
}
