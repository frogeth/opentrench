import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { FeedMessage, PluginInfo, TokenInfo } from '../types';
import { PluginFrame } from './PluginFrame';
import type { PluginContext, SettingField } from './route';
import type { SlotStore } from './slots';

/**
 * Every enabled plugin runs here, in one fixed layer above the columns and below the app's own
 * dialogs — one frame per plugin, mounted for as long as the plugin is enabled and never moved.
 *
 * A plugin column only marks out a rectangle (`.plugin-slot`); this layer measures it and lays the
 * frame over it. That indirection is the point: columns are reordered, split, resized and removed all
 * the time, and any of those would reload a plugin that lived inside one. A plugin with no slot —
 * `ui: false`, or nobody showing it — sits at 0×0, running and invisible.
 */
export function PluginHost({
  plugins,
  messages,
  tokens,
  actionsFor,
  slots,
  layout,
  onTitle,
  onSubtitle,
  onBadge,
  onSchema,
  onError,
}: {
  plugins: PluginInfo[];
  messages: FeedMessage[];
  tokens: Record<string, TokenInfo>;
  /** the actions a given plugin gets: buy and copy name the plugin to the user, so each one is bound to its own */
  actionsFor: (id: string) => PluginContext['actions'];
  slots: SlotStore;
  /**
   * A cheap stand-in for the column layout — ids, order and widths — from App. Frames are laid out
   * again when it changes; without it every render of the app would re-measure every frame.
   */
  layout: string;
  onTitle: (id: string, title: string) => void;
  onSubtitle: (id: string, subtitle: string) => void;
  onBadge: (id: string, n: number | null) => void;
  onSchema: (id: string, schema: SettingField[]) => void;
  onError: (id: string, text: string) => void;
}) {
  const running = useMemo(() => plugins.filter((p) => p.enabled && p.manifest), [plugins]);
  const panes = useRef(new Map<string, HTMLDivElement>());
  const [, slotsChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => slots.subscribe(slotsChanged), [slots]);

  /** lay each frame over its column's rectangle, or nowhere */
  const place = useRef(() => {});
  place.current = () => {
    for (const p of running) {
      const pane = panes.current.get(p.id);
      if (!pane) continue;
      const el = slots.holder(p.id)?.el;
      const r = el?.isConnected ? el.getBoundingClientRect() : null;
      if (!r || r.width < 1 || r.height < 1) {
        pane.classList.add('plugin-pane-hidden');
        continue;
      }
      pane.classList.remove('plugin-pane-hidden');
      pane.style.left = `${r.left}px`;
      pane.style.top = `${r.top}px`;
      pane.style.width = `${r.width}px`;
      pane.style.height = `${r.height}px`;
    }
  };
  /** at most one measuring pass per frame, however many scroll or resize events arrive */
  const pending = useRef(0);
  const soon = useRef(() => {});
  soon.current = () => {
    // nowhere to defer to (jsdom, or a document that never paints): measure now
    if (typeof requestAnimationFrame === 'undefined') return place.current();
    // a pass is already booked for this frame; this event rides along with it
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      place.current();
    });
  };
  /** which column holds which plugin right now */
  const holders = running.map((p) => `${p.id}:${slots.holder(p.id)?.colId ?? ''}`).join('|');
  // The column layout is what moves a frame without resizing it (a reorder, a column removed), and it
  // reaches us as a changed signature — not as "some render happened".
  useLayoutEffect(() => place.current(), [holders, layout]);
  useEffect(() => {
    const onMove = () => soon.current();
    window.addEventListener('resize', onMove);
    // capture, so the columns row scrolling counts as much as the page
    document.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      document.removeEventListener('scroll', onMove, true);
      if (pending.current) cancelAnimationFrame(pending.current);
    };
  }, []);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => soon.current());
    for (const p of running) {
      const el = slots.holder(p.id)?.el;
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holders]);

  return (
    <div className="plugin-layer">
      {running.map((p) => (
        <div
          key={p.id}
          className="plugin-pane plugin-pane-hidden"
          ref={(el) => {
            if (el) panes.current.set(p.id, el);
            else panes.current.delete(p.id);
          }}
        >
          <PluginFrame
            key={`${p.id}:${p.hash}`}
            plugin={p}
            messages={messages}
            tokens={tokens}
            actions={actionsFor(p.id)}
            onTitle={(t) => onTitle(p.id, t)}
            onSubtitle={(t) => onSubtitle(p.id, t)}
            onBadge={(n) => onBadge(p.id, n)}
            onSchema={(s) => onSchema(p.id, s)}
            onError={(t) => onError(p.id, t)}
          />
        </div>
      ))}
    </div>
  );
}
