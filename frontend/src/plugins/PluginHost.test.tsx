import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PluginHost } from './PluginHost';
import { SlotContext, SlotStore, usePluginSlot } from './slots';
import type { PluginInfo } from '../types';
import { api } from '../api';

vi.mock('../api', () => ({ api: { pluginCode: vi.fn(async () => 'export default function main(ot) {}') } }));

const plugin = (id: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
  id,
  file: `${id}.js`,
  hash: 'h1',
  manifest: { id, name: `Plugin ${id}`, version: '1.0.0', api: 1, sites: [], permissions: [], ui: true, description: '' },
  enabled: true,
  needsApproval: false,
  chats: {},
  signedIn: [],
  ...over,
});

const actions = { openToken: vi.fn(), jump: vi.fn(), buy: vi.fn(), research: vi.fn(), copy: vi.fn(), notify: vi.fn() };
const noop = () => {};

/** what App renders for a plugin column: a rectangle, and a note when another column already has the frame */
function Slot({ pluginId, colId }: { pluginId: string; colId: string }) {
  const { ref, holds } = usePluginSlot(pluginId, colId);
  return (
    <div className="plugin-slot" data-col={colId} data-holds={String(holds)} ref={ref} />
  );
}

function Page({ plugins, cols, slots }: { plugins: PluginInfo[]; cols: { colId: string; pluginId: string }[]; slots: SlotStore }) {
  return (
    <SlotContext.Provider value={slots}>
      <div className="terminal">
        {cols.map((c) => (
          <Slot key={c.colId} pluginId={c.pluginId} colId={c.colId} />
        ))}
      </div>
      <PluginHost plugins={plugins} messages={[]} tokens={{}} actionsFor={() => actions} slots={slots} onTitle={noop} onSubtitle={noop} onBadge={noop} onSchema={noop} onError={noop} />
    </SlotContext.Provider>
  );
}

let container: HTMLDivElement;
let root: Root;
let slots: SlotStore;
const render = async (cols: { colId: string; pluginId: string }[], plugins = [plugin('a')]) => {
  await act(async () => {
    root.render(<Page plugins={plugins} cols={cols} slots={slots} />);
  });
};
const frames = () => [...container.querySelectorAll('iframe')];
const slot = (colId: string) => container.querySelector(`.plugin-slot[data-col="${colId}"]`) as HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  slots = new SlotStore();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('PluginHost', () => {
  it('runs one frame per enabled plugin and keeps it through column changes', async () => {
    await render([{ colId: 'c1', pluginId: 'a' }]);
    expect(frames()).toHaveLength(1);
    const live = frames()[0];
    // the column is reordered, then joined by others, then resized: none of that is a reason to reload
    await render([{ colId: 'c0', pluginId: 'b' }, { colId: 'c1', pluginId: 'a' }]);
    await render([{ colId: 'c1', pluginId: 'a' }, { colId: 'c0', pluginId: 'b' }]);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toBe(live);
    expect(api.pluginCode).toHaveBeenCalledTimes(1);
  });

  it('gives the frame to the first column asking for it and tells the second', async () => {
    await render([{ colId: 'c1', pluginId: 'a' }, { colId: 'c2', pluginId: 'a' }]);
    expect(slot('c1').dataset.holds).toBe('true');
    expect(slot('c2').dataset.holds).toBe('false');
    const live = frames()[0];
    // the first column goes away: the second takes over, and the plugin keeps running
    await render([{ colId: 'c2', pluginId: 'a' }]);
    expect(slot('c2').dataset.holds).toBe('true');
    expect(frames()[0]).toBe(live);
    expect(api.pluginCode).toHaveBeenCalledTimes(1);
  });

  it('runs a plugin with no column at all, and stops one that is switched off', async () => {
    await render([], [plugin('a', { manifest: { ...plugin('a').manifest!, ui: false } })]);
    expect(frames()).toHaveLength(1);
    await render([], [plugin('a', { enabled: false })]);
    expect(frames()).toHaveLength(0);
  });
});
