import type { ReactNode, RefObject, UIEvent } from 'react';

export function Column({
  title,
  subtitle,
  count,
  extra,
  children,
  className = '',
  bodyRef,
  onScroll,
  footer,
}: {
  title: string;
  subtitle?: string;
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
        <div className="col-title">
          <h2>{title}</h2>
          {subtitle && <span className="col-sub">{subtitle}</span>}
        </div>
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
