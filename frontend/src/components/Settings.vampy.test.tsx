// The Vampy card on Settings → Accounts: the key field before a key is saved, the plan and Disconnect after.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Settings } from './Settings';
import type { Status } from '../types';

let cfg: Record<string, unknown> = {};
vi.mock('../api', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  api: {
    config: vi.fn(async () => cfg),
    together: vi.fn(async () => ({ share: false, name: 'me', peers: [], pairings: [], rooms: [], memberId: 'm1', relay: '' })),
    plugins: vi.fn(async () => []),
    setVampyKey: vi.fn(async (key: string) => ({ hasKey: !!key })),
  },
}));
import { api } from '../api';

const base = { discord: { hasToken: false, watch: [], canSend: false }, telegram: { apiId: null, hasApiHash: false, hasSession: false, watch: [], canSend: false }, j7: { hasToken: false, favorites: [] }, marketData: {}, rpc: {}, plugins: {}, pluginWatch: [] };
const status = (over: Partial<Status> = {}) => ({ discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {}, favorites: [], ...over }) as unknown as Status;

let container: HTMLDivElement;
let root: Root;
const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
const settings = (st: Status) => (
  <Settings
    status={st}
    onClose={() => {}}
    chatOrder="bottom"
    onChatOrder={() => {}}
    autoChart={false}
    onAutoChart={() => {}}
    compactEmbeds={false}
    onCompactEmbeds={() => {}}
    chartProvider="dexscreener"
    onChartProvider={() => {}}
    plugins={[]}
    pluginErrors={{}}
    pluginSchemas={{}}
    onPluginsChanged={() => {}}
  />
);
const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[];
const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
const click = async (b: HTMLButtonElement | undefined) => {
  expect(b).toBeDefined();
  await act(async () => b!.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ version: '0.0.0' }) })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Settings → Accounts → Vampy', () => {
  it('asks for the key when none is saved and saves it', async () => {
    cfg = { ...base, vampy: { hasKey: false } };
    await render(settings(status()));
    expect(container.textContent).toContain('Vampy');
    expect(container.textContent).toContain('Settings → API');
    const field = inputs().find((i) => i.placeholder === 'vmp_…')!;
    expect(field).toBeDefined();
    const save = buttons().find((b) => b.textContent?.startsWith('Save & connect') && b.closest('section')?.textContent?.includes('vampy.app'))!;
    expect(save.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, ' vmp_abcdefghijklmnop ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    await click(save);
    expect(api.setVampyKey).toHaveBeenCalledWith('vmp_abcdefghijklmnop');
  });

  it('shows the plan once connected, and Disconnect clears the key', async () => {
    cfg = { ...base, vampy: { hasKey: true } };
    await render(settings(status({ vampy: 'connected', vampyPlan: { name: 'Pro Monthly', daysRemaining: 27, feeds: 3, feedIds: ['a', 'b', 'c'] } })));
    const card = [...container.querySelectorAll('section')].find((s) => s.textContent?.includes('vampy.app'))!;
    expect(card.textContent).toContain('connected');
    expect(card.textContent).toContain('key saved');
    expect(card.textContent).toContain('Pro Monthly');
    expect(card.textContent).toContain('27 days left');
    expect(card.textContent).toContain('3 feeds');
    expect(inputs().some((i) => i.placeholder === 'vmp_…')).toBe(false);
    await click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Disconnect') as HTMLButtonElement);
    expect(api.setVampyKey).toHaveBeenCalledWith('');
  });

  it('surfaces the backend error line (a lapsed plan, a rejected key)', async () => {
    cfg = { ...base, vampy: { hasKey: true } };
    await render(settings(status({ vampy: 'auth_error', error: { vampy: 'the Vampy subscription behind this key is not active' } })));
    const card = [...container.querySelectorAll('section')].find((s) => s.textContent?.includes('vampy.app'))!;
    expect(card.textContent).toContain('auth error');
    expect(card.textContent).toContain('subscription behind this key is not active');
  });
});
