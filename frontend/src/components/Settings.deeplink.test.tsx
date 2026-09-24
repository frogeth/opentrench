// An opentrench://room/… invite handed to Settings opens it on the Together tab with the link filled in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Settings } from './Settings';
import type { Status } from '../types';

const together = { share: false, name: 'me', peers: [], pairings: [], rooms: [], memberId: 'm1', relay: '' };
vi.mock('../api', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  api: {
    config: vi.fn(async () => ({})),
    together: vi.fn(async () => together),
    addPeer: vi.fn(async () => together),
    plugins: vi.fn(async () => []),
  },
}));

const INVITE = 'opentrench://room/relay.example/' + 'k'.repeat(43);
const status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'none', error: {}, favorites: [] } as unknown as Status;

let container: HTMLDivElement;
let root: Root;
const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
const settings = (over: { initialTab?: 'together'; initialInvite?: string } = {}) => (
  <Settings
    status={status}
    onClose={() => {}}
    chatOrder="bottom"
    onChatOrder={() => {}}
    autoChart={false}
    onAutoChart={() => {}}
    compactEmbeds={false}
    onCompactEmbeds={() => {}}
    chainTint={false}
    onChainTint={() => {}}
    chartProvider="dexscreener"
    onChartProvider={() => {}}
    plugins={[]}
    pluginErrors={{}}
    pluginSchemas={{}}
    onPluginsChanged={() => {}}
    {...over}
  />
);
const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // the version line asks the backend when there is no desktop bridge
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

describe('Settings with a deep-linked invite', () => {
  it('opens on the Together tab with the invite in the Join field', async () => {
    await render(settings({ initialTab: 'together', initialInvite: INVITE }));
    expect(container.textContent).toContain('TrenchTogether');
    const join = inputs().find((i) => i.placeholder.startsWith('opentrench://room/'));
    expect(join?.value).toBe(INVITE);
  });

  it('leaves the Join field empty when there is no link', async () => {
    await render(settings({ initialTab: 'together' }));
    expect(container.textContent).toContain('TrenchTogether');
    expect(inputs().some((i) => i.value === INVITE)).toBe(false);
    const join = inputs().find((i) => i.placeholder.startsWith('opentrench://room/'));
    expect(join?.value).toBe('');
  });
});
