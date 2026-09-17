import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PluginsSection } from './PluginsSection';
import type { PluginInfo } from '../types';
import { ApiError, api } from '../api';

vi.mock('../api', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  api: {
    pluginSettings: vi.fn(async () => ({ values: {}, schema: [] })),
    pluginSettingsSet: vi.fn(async () => ({ ok: true })),
    pluginLogs: vi.fn(async () => []),
    pluginsShell: vi.fn(async () => ({ available: true })),
    pluginInspect: vi.fn(async () => ({ id: 'hello-feed', name: 'Hello feed', version: '2.0.0', api: 1, sites: [], permissions: [], ui: true, description: '' })),
    pluginAdd: vi.fn(async () => ({ id: 'hello-feed', replaced: false, manifest: { name: 'Hello feed', version: '2.0.0' } })),
    pluginAddUrl: vi.fn(async () => ({ id: 'hello-feed', replaced: true, manifest: { name: 'Hello feed', version: '2.0.0' } })),
    pluginEnable: vi.fn(async () => ({ ok: true })),
    pluginDisable: vi.fn(async () => ({ ok: true })),
    pluginRemove: vi.fn(async () => ({ ok: true })),
    pluginsReload: vi.fn(async () => []),
    pluginApprove: vi.fn(async () => ({ ok: true })),
    pluginSource: vi.fn(async () => 'export const manifest = {};'),
    pluginSignIn: vi.fn(async () => ({ ok: true })),
  },
}));

const plugin = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  id: 'hello-feed',
  file: 'hello-feed.js',
  hash: 'a'.repeat(64),
  manifest: { id: 'hello-feed', name: 'Hello feed', version: '1.0.0', api: 1, sites: [], permissions: ['feed:write'], ui: true, description: 'says hello' },
  enabled: true,
  needsApproval: false,
  chats: { 'plugin:hello-feed:hello': 'Hello' },
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
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label));
const click = async (el: Element | undefined) => {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('PluginsSection', () => {
  it('lists a plugin with what it may do, and offers the approval dialog only when one is needed', async () => {
    await render(<PluginsSection plugins={[plugin()]} errors={{}} schemas={{}} onChanged={() => {}} />);
    expect(text()).toContain('Hello feed');
    expect(text()).toContain('permissions: feed:write');
    expect(text()).toContain('chats: Hello');
    expect(button('review & approve')).toBeUndefined();
    expect(container.querySelector('[role="dialog"]')).toBe(null);

    await render(<PluginsSection plugins={[plugin({ enabled: false, needsApproval: true })]} errors={{}} schemas={{}} onChanged={() => {}} />);
    await click(button('review & approve'));
    expect(container.querySelector('[role="dialog"]')).not.toBe(null);
    expect(text()).toContain('Approve Hello feed?');
  });
  it('shows a running plugin\'s error in the row, not only as a tooltip', async () => {
    await render(<PluginsSection plugins={[plugin()]} errors={{ 'hello-feed': 'TypeError: x is not a function' }} schemas={{}} onChanged={() => {}} />);
    expect(container.querySelector('.plugin-err')?.textContent).toBe('TypeError: x is not a function');
  });
  it('renders the settings form, seeds defaults, keeps a secret off the screen and saves what was typed', async () => {
    vi.mocked(api.pluginSettings).mockResolvedValueOnce({
      values: { greeting: 'hi' },
      schema: [
        { key: 'greeting', label: 'Greeting', type: 'text' },
        { key: 'every', label: 'Minutes', type: 'number', default: 5 },
        { key: 'api_key', label: 'API key', type: 'secret' },
      ],
    });
    await render(<PluginsSection plugins={[plugin()]} errors={{}} schemas={{}} onChanged={() => {}} />);
    const inputs = [...container.querySelectorAll('.plugin-field input')] as HTMLInputElement[];
    expect(inputs.map((i) => i.type)).toEqual(['text', 'number', 'password']);
    expect(inputs[0].value).toBe('hi');
    expect(inputs[1].value).toBe('5'); // the plugin's default, shown before anything is saved
    expect(button('save settings')?.disabled).toBe(true);
    await type(inputs[2], 'secret-token');
    await click(button('save settings'));
    expect(api.pluginSettingsSet).toHaveBeenCalledWith('hello-feed', { greeting: 'hi', every: 5, api_key: 'secret-token' });
    expect(text()).toContain('stored in plain text in your plugins state file');
  });
  it('takes the schema the running plugin declared over the stored one', async () => {
    vi.mocked(api.pluginSettings).mockResolvedValueOnce({ values: {}, schema: [{ key: 'old', label: 'Stored field', type: 'text' }] });
    await render(<PluginsSection plugins={[plugin()]} errors={{}} schemas={{ 'hello-feed': [{ key: 'live', label: 'Live field', type: 'text' }] }} onChanged={() => {}} />);
    expect(text()).toContain('Live field');
    expect(text()).not.toContain('Stored field');
  });
  it('asks before replacing an installed plugin and says what landed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // jsdom's File has no .text() here; the component only needs that much of one
    const file = { name: 'hello-feed.js', text: async () => 'export const manifest = {}' } as unknown as File;
    await render(<PluginsSection plugins={[plugin()]} errors={{}} schemas={{}} onChanged={() => {}} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(confirm).toHaveBeenCalledWith('Replace the installed Hello feed? Its approval is reset.');
    expect(api.pluginAdd).not.toHaveBeenCalled(); // the user said no

    confirm.mockReturnValue(true);
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.pluginAdd).toHaveBeenCalled();
    expect(text()).toContain('added Hello feed 2.0.0 — review & approve');
    confirm.mockRestore();
  });
  it('asks about a link the backend says would replace something, then installs it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(api.pluginAddUrl).mockRejectedValueOnce(new ApiError('would replace Hello feed', 409, { replaces: 'hello-feed' }));
    await render(<PluginsSection plugins={[plugin()]} errors={{}} schemas={{}} onChanged={() => {}} />);
    const url = container.querySelector('input.fed-input') as HTMLInputElement;
    await type(url, 'https://example.com/hello-feed.js');
    await click(button('add from link'));
    expect(confirm).toHaveBeenCalledWith('Replace the installed Hello feed? Its approval is reset.');
    expect(api.pluginAddUrl).toHaveBeenCalledTimes(1); // the user said no: never asked again with replace
    expect(url.value).toBe('https://example.com/hello-feed.js'); // …and the link is still there to retry

    confirm.mockReturnValue(true);
    vi.mocked(api.pluginAddUrl).mockRejectedValueOnce(new ApiError('would replace Hello feed', 409, { replaces: 'hello-feed' }));
    await click(button('add from link'));
    expect(api.pluginAddUrl).toHaveBeenLastCalledWith('https://example.com/hello-feed.js', true);
    expect(text()).toContain('replaced Hello feed; it needs approval again');
    expect(url.value).toBe('');
    confirm.mockRestore();
  });
  it('keeps a link that would not install in the box, with the reason', async () => {
    vi.mocked(api.pluginAddUrl).mockRejectedValueOnce(new ApiError('fetch failed: 404', 400));
    await render(<PluginsSection plugins={[]} errors={{}} schemas={{}} onChanged={() => {}} />);
    const url = container.querySelector('input.fed-input') as HTMLInputElement;
    await type(url, 'https://example.com/nope.js');
    await click(button('add from link'));
    expect(text()).toContain('fetch failed: 404');
    expect(url.value).toBe('https://example.com/nope.js');
  });
});
