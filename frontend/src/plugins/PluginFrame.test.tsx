import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactElement } from 'react';
import { PluginFrame } from './PluginFrame';
import type { FeedMessage, PluginInfo } from '../types';
import { api } from '../api';

vi.mock('../api', () => ({ api: { pluginCode: vi.fn() } }));

const code: Record<string, string> = { a: 'export default function main(ot) {}', b: 'export default function main(ot) {}' };
const pending = new Map<string, (c: string) => void>();

const plugin = (id: string, hash = 'h1'): PluginInfo => ({
  id,
  file: `${id}.js`,
  hash,
  manifest: { id, name: `Plugin ${id}`, version: '1.0.0', api: 1, sites: [], permissions: [], ui: true, description: '' },
  enabled: true,
  needsApproval: false,
  chats: {},
  signedIn: [],
});

const actions = { openToken: vi.fn(), jump: vi.fn(), buy: vi.fn(), research: vi.fn(), copy: vi.fn(), notify: vi.fn() };

const msg = (id: string, over: Partial<FeedMessage> = {}): FeedMessage => ({ id, source: 'plugin', chatId: 'c', chatName: 'C', author: 'a', text: id, ts: 1, ...over }) as FeedMessage;

let container: HTMLDivElement;
let root: Root;

const render = async (el: ReactElement) => {
  await act(async () => {
    root.render(el);
  });
};
const frame = () => container.querySelector('iframe');
const srcdoc = () => frame()!.getAttribute('srcdoc')!;
/** which load of the code the document in the frame is: the number the host loop answers for */
const gen = () => Number(/window\.__otGen=(\d+)/.exec(srcdoc())![1]);
const send = async (source: unknown, data: unknown) => {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });
};
const setTitle = (g: number, title: string) => ({ ot: 1, kind: 'call', id: 1, method: 'ui.setTitle', args: [title], gen: g });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(api.pluginCode).mockImplementation(
    (id: string) => (id in code ? Promise.resolve(code[id]) : new Promise<string>((resolve) => pending.set(id, resolve))) as Promise<string>,
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  pending.clear();
  vi.clearAllMocks();
});

describe('PluginFrame', () => {
  it('answers its own frame and ignores anyone else claiming to be it', async () => {
    const onTitle = vi.fn();
    await render(<PluginFrame plugin={plugin('a')} messages={[]} tokens={{}} actions={actions} onTitle={onTitle} />);
    const g = gen();
    // the same well-formed call, from the page itself rather than from the frame
    await send(window, setTitle(g, 'from elsewhere'));
    expect(onTitle).not.toHaveBeenCalled();
    await send(frame()!.contentWindow, setTitle(g, 'from the frame'));
    expect(onTitle).toHaveBeenCalledWith('from the frame');
  });

  it('carries the plugin code as data, so nothing in it can break out of the bootstrap', async () => {
    const nasty = `const s = "</script><img src=x onerror='boom'>";\nconst sep = '\u2028\u2029';\nexport default function main(ot) { return s + sep; }`;
    code.nasty = nasty;
    await render(<PluginFrame plugin={plugin('nasty')} messages={[]} tokens={{}} actions={actions} />);
    const doc = srcdoc();
    expect(doc).not.toContain('<img');
    expect(doc).not.toContain('onerror=');
    expect(doc).not.toContain('\u2028');
    const b64 = /data:text\/javascript;base64,([^"]+)/.exec(doc)![1];
    expect(decodeURIComponent(escape(atob(b64)))).toBe(nasty);
    // and the plugin's own name is an attribute React escapes, not markup
    expect(frame()!.title).toBe('Plugin nasty');
  });

  it('pushes only what is new, never what the feed hides, and at most one batch of fifty', async () => {
    const first = [msg('m1')];
    await render(<PluginFrame plugin={plugin('a')} messages={first} tokens={{}} actions={actions} />);
    const post = vi.spyOn(frame()!.contentWindow!, 'postMessage');
    // the ones already there when it started are history, not events
    expect(post).not.toHaveBeenCalled();
    await render(<PluginFrame plugin={plugin('a')} messages={[msg('m3'), msg('m2', { hidden: true }), ...first]} tokens={{}} actions={actions} />);
    expect(post.mock.calls.map(([m]) => (m as { data: FeedMessage }).data.id)).toEqual(['m3']);
    post.mockClear();
    const flood = Array.from({ length: 60 }, (_, i) => msg(`f${60 - i}`));
    await render(<PluginFrame plugin={plugin('a')} messages={[...flood, msg('m3')]} tokens={{}} actions={actions} />);
    expect(post.mock.calls).toHaveLength(50);
    // the newest are the ones kept, and they arrive oldest first
    expect((post.mock.calls[0][0] as { data: FeedMessage }).data.id).toBe('f11');
    expect((post.mock.calls[49][0] as { data: FeedMessage }).data.id).toBe('f60');
  });

  it('routes nothing under a plugin whose code is not in the frame yet, nor for an older load', async () => {
    const onTitle = vi.fn();
    await render(<PluginFrame plugin={plugin('a')} messages={[]} tokens={{}} actions={actions} onTitle={onTitle} />);
    const old = frame()!.contentWindow;
    const oldGen = gen();
    // switching to a plugin whose file has not arrived: the old document goes first
    await render(<PluginFrame plugin={plugin('slow')} messages={[]} tokens={{}} actions={actions} onTitle={onTitle} />);
    expect(frame()).toBeNull();
    await send(old, setTitle(oldGen, 'A talking under B'));
    expect(onTitle).not.toHaveBeenCalled();
    // now the new code lands
    await act(async () => {
      pending.get('slow')!('export default function main(ot) {}');
    });
    expect(frame()).not.toBeNull();
    expect(gen()).toBeGreaterThan(oldGen);
    await send(frame()!.contentWindow, setTitle(oldGen, 'still the old load'));
    expect(onTitle).not.toHaveBeenCalled();
    await send(frame()!.contentWindow, setTitle(gen(), 'the new one'));
    expect(onTitle).toHaveBeenCalledWith('the new one');
  });
});
