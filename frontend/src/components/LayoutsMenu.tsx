import { useEffect, useState } from 'react';
import type { ColumnDef, Layout } from '../api';

/** Two column sets are the same layout when they serialise the same (ids, order, scope, splits, widths, filters). */
export const sameColumns = (a: ColumnDef[], b: ColumnDef[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The header's Layouts menu: every saved arrangement of the column terminal, the one matching what
 * is on screen marked; click one to switch to it, save the current arrangement under a name, or
 * delete one. Saving under an existing name overwrites it.
 */
export function LayoutsMenu({
  layouts,
  columns,
  onLoad,
  onSave,
  onDelete,
  onClose,
}: {
  layouts: Layout[];
  columns: ColumnDef[];
  onLoad: (l: Layout) => void;
  onSave: (name: string) => Promise<void>;
  onDelete: (l: Layout) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const current = layouts.find((l) => sameColumns(l.columns, columns));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onSave(n);
      setName('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ca-menu-backdrop" onMouseDown={onClose} />
      <div className="ca-menu layouts-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="layouts-head">
          Layouts
          <span className="muted">{current ? ` · on ${current.name}` : layouts.length ? ' · unsaved arrangement' : ''}</span>
        </div>
        {layouts.length === 0 && <div className="layouts-empty muted">Nothing saved yet. Arrange your columns, name the arrangement below, and it shows up here.</div>}
        {layouts.map((l) => (
          <div key={l.id} className={`layouts-row${current?.id === l.id ? ' on' : ''}`}>
            <button className="layouts-load" onClick={() => onLoad(l)} title={`switch to ${l.name} (${l.columns.length} column${l.columns.length === 1 ? '' : 's'})`}>
              <span className="layouts-name">{l.name}</span>
              <span className="muted">{l.columns.map((c) => c.title).join(' · ')}</span>
            </button>
            <button className="layouts-del" onClick={() => onDelete(l)} title={`delete ${l.name}`} aria-label={`delete ${l.name}`}>
              ✕
            </button>
          </div>
        ))}
        <div className="layouts-save">
          <input
            value={name}
            placeholder={current ? `save as… (or overwrite ${current.name})` : 'save current as…'}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            autoFocus
          />
          <button disabled={busy || !name.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </>
  );
}
