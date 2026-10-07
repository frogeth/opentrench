// The Discord card on Settings → Accounts names the client mod the plugin is connected through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Settings } from './Settings';

// a desktop shell that ships both client mods, with Vencord injected
const shell = vi.hoisted(() => ({
  discordStatus: vi.fn(async () => ({
    available: true,
    mods: { vencord: true, betterdiscord: true },
    installs: [{ id: 'stable', name: 'Discord', path: '/x', injected: true, mod: 'vencord', ours: true, running: true }],
  })),
  discordSetup: vi.fn(async (opts?: { mod?: string }) => ({ ok: true, install: 'Discord', mod: opts?.mod ?? 'vencord', replaced: true, replacedMod: 'vencord' })),
  discordRemove: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../desktop', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  desktop: shell,
  hasBridge: (name: string) => typeof (shell as Record<string, unknown>)[name] === 'function',
}));
import type { Status } from '../types';

let cfg: Record<string, unknown> = {};
vi.mock('../api', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  api: {
    config: vi.fn(async () => cfg),
    together: vi.fn(async () => ({ share: false, name: 'me', peers: [], pairings: [], rooms: [], memberId: 'm1', relay: '' })),
    plugins: vi.fn(async () => []),
  },
}));

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
    chainTint={false}
    onChainTint={() => {}}
    chartProvider="dexscreener"
    onChartProvider={() => {}}
    plugins={[]}
    pluginErrors={{}}
    pluginSchemas={{}}
    onPluginsChanged={() => {}}
  />
);

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

const cardTitle = () => [...container.querySelectorAll('.acct-card-title b')].map((b) => b.textContent).find((t) => t?.startsWith('opentrench plugin'));

describe('Discord plugin card', () => {
  beforeEach(() => {
    cfg = { ...base };
  });

  it('names BetterDiscord when the plugin connected through it', async () => {
    await render(settings(status({ discord: 'connected', discordMode: 'bridge', discordUser: 'frog.eth', discordClient: 'betterdiscord' })));
    expect(cardTitle()).toBe('opentrench plugin for BetterDiscord');
  });

  it('names Vencord when the plugin connected through it', async () => {
    await render(settings(status({ discord: 'connected', discordMode: 'bridge', discordUser: 'frog.eth', discordClient: 'vencord' })));
    expect(cardTitle()).toBe('opentrench plugin for Vencord');
  });

  it('offers both while nothing is connected', async () => {
    await render(settings(status()));
    expect(cardTitle()).toBe('opentrench plugin for Vencord or BetterDiscord');
  });

  it('offers a one-click switch to the other client mod and sends that choice to the shell', async () => {
    await render(settings(status({ discord: 'connected', discordMode: 'bridge', discordUser: 'frog.eth', discordClient: 'vencord' })));
    const sw = [...container.querySelectorAll('button')].find((b) => b.textContent === 'switch to BetterDiscord');
    expect(sw).toBeDefined();
    await act(async () => sw!.click());
    expect(shell.discordSetup).toHaveBeenCalledWith({ mod: 'betterdiscord' });
    expect(container.textContent).toContain('Installed into Discord with BetterDiscord (Vencord was removed from Discord');
  });

  it('switches back the other way', async () => {
    await render(settings(status({ discord: 'connected', discordMode: 'bridge', discordUser: 'frog.eth', discordClient: 'betterdiscord' })));
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'switch to Vencord')).toBe(true);
  });
});
