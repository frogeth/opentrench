import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AddChatsModal } from './AddChatsModal';
import type { MaskedConfig } from '../api';
import type { PluginInfo } from '../types';

const plugin: PluginInfo = {
  id: 'hello-feed',
  file: 'hello-feed.js',
  hash: 'h',
  manifest: { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: [], permissions: [], ui: true, description: '' },
  enabled: true,
  needsApproval: false,
  chats: { 'plugin:hello-feed:hello': 'Hello' },
  signedIn: [],
};
const cfg = (pluginWatch: string[]) => ({ discord: { watch: [] }, telegram: { watch: [] }, pluginWatch }) as unknown as MaskedConfig;

let container: HTMLDivElement;
let root: Root;
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label))!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('AddChatsModal · Plugins', () => {
  const render = async (watch: string[], onTogglePlugin: (key: string, on: boolean) => Promise<void>, plugins = [plugin]) => {
    await act(async () => {
      root.render(
        <AddChatsModal
          initialSource="telegram"
          cfg={cfg(watch)}
          channels={[]}
          dialogs={[]}
          plugins={plugins}
          busy={false}
          onToggle={async () => {}}
          onTogglePlugin={onTogglePlugin}
          onPreview={() => {}}
          onClose={() => {}}
        />,
      );
    });
    await click(button('Plugins'));
  };

  it('lists a plugin chat under the plugin that posted it and toggles it by its whole key', async () => {
    const onTogglePlugin = vi.fn(async () => {});
    await render([], onTogglePlugin);
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).toContain('Hello feed');
    await click(button('+ add'));
    expect(onTogglePlugin).toHaveBeenCalledWith('plugin:hello-feed:hello', true);
  });
  it('shows a watched chat as in the feed and switches it back off', async () => {
    const onTogglePlugin = vi.fn(async () => {});
    await render(['plugin:hello-feed:hello'], onTogglePlugin);
    await click(button('in feed'));
    expect(onTogglePlugin).toHaveBeenCalledWith('plugin:hello-feed:hello', false);
  });
  it('points at Settings when no plugin has posted anything', async () => {
    await render([], async () => {}, [{ ...plugin, chats: {} }]);
    expect(container.textContent).toContain('No plugin has posted a chat yet. Enable one in ⚙ → Plugins.');
  });
});
