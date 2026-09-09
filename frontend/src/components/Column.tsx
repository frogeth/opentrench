import type { ReactNode } from 'react';

export function Column({
  title,
  count,
  extra,
  children,
  className = '',
}: {
  title: string;
  count?: number;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`col ${className}`}>
      <div className="col-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="col-count">{count}</span>}
        <div className="col-extra">{extra}</div>
      </div>
      <div className="col-body">{children}</div>
    </section>
  );
}
