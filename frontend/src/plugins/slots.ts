import { createContext, useContext, useEffect, useState } from 'react';

/** A column offering itself as the place a plugin's frame should sit. */
export interface PluginSlot {
  colId: string;
  el: HTMLElement;
}

/**
 * Which column shows which plugin, as a tiny store outside React's tree.
 *
 * The frames themselves live in `PluginHost`, one per enabled plugin, and never move in the DOM: a
 * column only marks out a rectangle for one and the host positions the frame over it. That is the
 * whole reason this exists — reordering, splitting, resizing or removing columns must not reload a
 * running plugin, and any arrangement that put the iframe *inside* a column would do exactly that.
 */
export class SlotStore {
  private slots = new Map<string, PluginSlot[]>();
  private listeners = new Set<() => void>();

  /** The column takes the plugin if it is the first to ask; later ones queue behind it. */
  claim(pluginId: string, colId: string, el: HTMLElement) {
    const list = this.slots.get(pluginId) ?? [];
    if (list.some((s) => s.colId === colId && s.el === el)) return;
    this.slots.set(
      pluginId,
      [...list.filter((s) => s.colId !== colId), { colId, el }],
    );
    this.emit();
  }

  release(pluginId: string, colId: string) {
    const list = this.slots.get(pluginId);
    if (!list) return;
    const left = list.filter((s) => s.colId !== colId);
    if (left.length === list.length) return;
    if (left.length) this.slots.set(pluginId, left);
    else this.slots.delete(pluginId);
    this.emit();
  }

  /** where this plugin's frame goes right now, or nothing when no column shows it */
  holder(pluginId: string): PluginSlot | undefined {
    return this.slots.get(pluginId)?.[0];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export const SlotContext = createContext<SlotStore | null>(null);

/**
 * A column's end of it: hand back a ref for the placeholder div and say where this column stands —
 * `pending` until the claim is in (nothing to say yet, so the column says nothing), then `holds` for
 * the column the frame sits over, or `taken` for a second column on the same plugin, which is told
 * rather than left blank. Starting at `pending` is what keeps either column from flashing the other's
 * words for a frame.
 */
export type SlotState = 'pending' | 'holds' | 'taken';

export function usePluginSlot(pluginId: string | undefined, colId: string): { ref: (el: HTMLElement | null) => void; state: SlotState } {
  const store = useContext(SlotContext);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<SlotState>('pending');
  useEffect(() => {
    if (!store || !pluginId || !el) return;
    store.claim(pluginId, colId, el);
    const read = () => setState(store.holder(pluginId)?.colId === colId ? 'holds' : 'taken');
    read();
    const off = store.subscribe(read);
    return () => {
      off();
      store.release(pluginId, colId);
      setState('pending');
    };
  }, [store, pluginId, colId, el]);
  return { ref: setEl, state };
}
