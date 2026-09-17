import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PluginApproveDialog } from './PluginApproveDialog';
import type { PluginInfo } from '../types';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    pluginApprove: vi.fn(async () => ({ ok: true })),
    pluginEnable: vi.fn(async () => ({ ok: true })),
    pluginSource: vi.fn(async () => 'export const manifest = {};'),
  },
}));

const plugin = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  id: 'hello-feed',
  file: 'hello-feed.js',
  hash: 'a'.repeat(64),
  manifest: { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: [], permissions: ['feed:write', 'actions'], ui: true, description: 'says hello' },
  enabled: false,
  needsApproval: true,
  chats: {},
  signedIn: [],
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label))!;
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('PluginApproveDialog', () => {
  it('says what every plugin can do, then what this one asked for, and names the bytes on screen', async () => {
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={() => {}} />);
    expect(text()).toContain('Every plugin can');
    expect(text()).toContain('post messages into your feed; write your clipboard, and open buys for you to confirm');
    // the short hash of the version being approved
    expect(text()).toContain('a'.repeat(12));
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    // no sites: the warning must not point at a list that is not there
    expect(text()).not.toContain('sites listed above');
    expect(text()).toContain('opentrench cannot check it for you');
  });
  it('warns about site logins only when the plugin declares sites', async () => {
    await render(<PluginApproveDialog plugin={plugin({ manifest: { ...plugin().manifest!, sites: ['https://example.com'] } })} onClose={() => {}} onApproved={() => {}} />);
    expect(text()).toContain('It will use your login on: example.com');
    expect(text()).toContain('your logins on the sites listed above');
  });
  it('approves the exact version it showed, then enables', async () => {
    const onApproved = vi.fn();
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={onApproved} />);
    await click(button('approve and enable'));
    expect(api.pluginApprove).toHaveBeenCalledWith('hello-feed', 'a'.repeat(64));
    expect(api.pluginEnable).toHaveBeenCalledWith('hello-feed');
    expect(onApproved).toHaveBeenCalled();
  });
  it('approves the version it showed even when the list moves on underneath', async () => {
    vi.mocked(api.pluginApprove).mockRejectedValueOnce(new Error('the file changed since you opened it; review it again'));
    const onApproved = vi.fn();
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={onApproved} />);
    // a rescan lands while the dialog is open: same plugin, different bytes
    await render(<PluginApproveDialog plugin={plugin({ hash: 'b'.repeat(64) })} onClose={() => {}} onApproved={onApproved} />);
    expect(text()).toContain('a'.repeat(12)); // still the version on screen when it opened
    await click(button('approve and enable'));
    expect(api.pluginApprove).toHaveBeenCalledWith('hello-feed', 'a'.repeat(64));
    expect(api.pluginEnable).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
    expect(container.querySelector('.plugin-approve-err')?.textContent).toContain('review it again');
  });
  it('keeps Tab inside itself while it is open', async () => {
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={() => {}} />);
    const stops = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    const last = stops[stops.length - 1];
    last.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(stops[0]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });
  it('keeps a failed enable inside the dialog and stays open', async () => {
    vi.mocked(api.pluginEnable).mockRejectedValueOnce(new Error('the plugin file changed on disk'));
    const onApproved = vi.fn();
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={onApproved} />);
    await click(button('approve and enable'));
    expect(onApproved).not.toHaveBeenCalled();
    expect(container.querySelector('.plugin-approve-err')?.textContent).toBe('the plugin file changed on disk');
  });
  it('shows the file on demand, and a failure to read it as an error rather than as the file', async () => {
    await render(<PluginApproveDialog plugin={plugin()} onClose={() => {}} onApproved={() => {}} />);
    await click(button('view code'));
    expect(container.querySelector('pre.plugin-code')?.textContent).toBe('export const manifest = {};');
    await click(button('hide code'));
    expect(container.querySelector('pre.plugin-code')).toBe(null);
    vi.mocked(api.pluginSource).mockRejectedValueOnce(new Error('the plugin file is gone'));
    await click(button('view code'));
    expect(container.querySelector('pre.plugin-code')).toBe(null);
    expect(text()).toContain('could not read the file: the plugin file is gone');
  });
  it('closes on Escape without letting the key reach the window underneath', async () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    await render(<PluginApproveDialog plugin={plugin()} onClose={onClose} onApproved={() => {}} />);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    document.removeEventListener('keydown', outer);
    expect(onClose).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
