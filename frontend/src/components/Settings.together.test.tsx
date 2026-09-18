// Settings → Together: rooms first (cards, create, join), the same-network mode under a disclosure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Settings } from './Settings';
import type { Status } from '../types';
import type { RoomInfo, TogetherInfo } from '../api';

const RELAY_PLACEHOLDER = 'wss://your-relay.example';
const room = (over: Partial<RoomInfo> = {}): RoomInfo => ({ id: 'r1', name: 'degen circle', relay: 'wss://relay.example', joinedAt: 1, hasAccess: false, invite: 'opentrench://room/relay.example/' + 'k'.repeat(43), ...over });
const together = (over: Partial<TogetherInfo> = {}): TogetherInfo => ({ share: false, name: 'me', peers: [], pairings: [], rooms: [], memberId: 'm1', relay: '', ...over });

const mocks = vi.hoisted(() => ({
  together: vi.fn(),
  createRoom: vi.fn(),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  rotateRoom: vi.fn(),
  setRoomAccess: vi.fn(),
  setRelay: vi.fn(),
  probeRelay: vi.fn(),
}));
vi.mock('../api', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  api: {
    config: vi.fn(async () => ({})),
    plugins: vi.fn(async () => []),
    addPeer: vi.fn(),
    ...mocks,
  },
}));

type Live = NonNullable<Status['together']>;
const live = (over: Partial<Live> = {}): Live => ({ sharing: false, port: 3211, clients: 0, peers: [], nearby: [], requests: [], outgoing: [], rooms: [], ...over });
const statusWith = (t?: Live) => ({ discord: 'disconnected', telegram: 'disconnected', loginStep: 'none', error: {}, favorites: [], together: t } as unknown as Status);

let container: HTMLDivElement;
let root: Root;
const render = async (status: Status, initialInvite?: string) => {
  await act(async () => {
    root.render(
      <Settings
        status={status}
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
        initialTab="together"
        initialInvite={initialInvite}
      />,
    );
  });
};
const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[];
const byPlaceholder = (start: string) => inputs().find((i) => i.placeholder.startsWith(start))!;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
let clipboard: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.together.mockImplementation(async () => together());
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ version: '0.0.0' }) })));
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => void clipboard.push(s) }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Settings → Together: rooms', () => {
  it('shows a room card with its name, relay host, state and who is online', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    await render(statusWith(live({ rooms: [{ id: 'r1', name: 'degen circle', relay: 'wss://relay.example', state: 'connected', members: 2, pending: 0 }] })));
    const card = container.querySelector('.room-card')!;
    expect(card).toBeTruthy();
    expect(card.querySelector('b')?.textContent).toBe('degen circle');
    expect(card.textContent).toContain('relay.example');
    expect(card.textContent).toContain('connected');
    expect(card.textContent).toContain('2 online');
    expect(container.textContent).not.toContain('No rooms yet');
  });

  it('says so when there are no rooms', async () => {
    await render(statusWith(live()));
    expect(container.textContent).toContain('No rooms yet. Create one and send the invite, or paste an invite you were given.');
  });

  it('Copy invite puts the invite on the clipboard and says Copied', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    await render(statusWith(live()));
    await click(button('Copy invite'));
    expect(clipboard).toEqual([room().invite]);
    expect(button('Copied')).toBeTruthy();
  });

  it('New invite asks inline first, then re-keys the room and copies the new invite', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    mocks.rotateRoom.mockResolvedValue({ room: room({ invite: 'opentrench://room/relay.example/NEW' }), status: live() });
    await render(statusWith(live()));
    await click(button('New invite'));
    expect(container.querySelector('.room-card')?.textContent).toContain('Make a new invite? Everyone in the room has to join again with it.');
    await click(button('No'));
    expect(mocks.rotateRoom).not.toHaveBeenCalled();
    expect(button('New invite')).toBeTruthy();
    await click(button('New invite'));
    await click(button('Yes'));
    expect(mocks.rotateRoom).toHaveBeenCalledWith('r1');
    expect(clipboard).toEqual(['opentrench://room/relay.example/NEW']);
    expect(container.querySelector('.room-notice')?.textContent).toBe('New invite copied. Send it to your friends.');
  });

  it('after New invite, says the invite is ready even when the clipboard is off', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    mocks.rotateRoom.mockResolvedValue({ room: room({ invite: 'opentrench://room/relay.example/NEW' }), status: live() });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await render(statusWith(live()));
    await click(button('New invite'));
    await click(button('Yes'));
    expect(container.querySelector('.room-notice')?.textContent).toBe('New invite ready. Copy it and send it to your friends.');
  });

  it('Leave asks inline, then leaves the room', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    mocks.leaveRoom.mockResolvedValue({ ok: true, status: live() });
    await render(statusWith(live()));
    await click(button('Leave'));
    expect(container.querySelector('.room-card')?.textContent).toContain('Leave this room?');
    await click(button('No'));
    expect(mocks.leaveRoom).not.toHaveBeenCalled();
    await click(button('Leave'));
    await click(button('Yes'));
    expect(mocks.leaveRoom).toHaveBeenCalledWith('r1');
  });

  it('shows the error with a Retry when the page cannot load', async () => {
    mocks.together.mockRejectedValueOnce(new Error('backend is away'));
    await render(statusWith(live()));
    expect(container.querySelector('.err')?.textContent).toContain('backend is away');
    await click(button('Retry'));
    expect(container.querySelector('.err')).toBeNull();
    expect(container.textContent).toContain('No rooms yet');
  });

  it('puts every state into plain words', async () => {
    const states: [Live['rooms'][number]['state'], string][] = [
      ['connected', 'connected'],
      ['connecting', 'connecting…'],
      ['disconnected', 'offline · retrying · could not reach relay.example'],
      ['key-mismatch', 'invite changed — ask for the new one'],
      ['relay-too-old', 'this relay needs updating'],
      ['access-denied', 'relay wants an access code'],
      ['full', 'room is full'],
      ['rate-limited', 'slow down · retrying'],
    ];
    mocks.together.mockImplementation(async () => together({ rooms: states.map(([s], i) => room({ id: `r${i}`, name: `room ${i}`, hasAccess: s === 'access-denied' })) }));
    await render(
      statusWith(
        live({
          rooms: states.map(([state], i) => ({ id: `r${i}`, name: `room ${i}`, relay: 'wss://relay.example', state, members: 0, pending: 0, ...(state === 'disconnected' ? { error: 'ECONNREFUSED' } : {}) })),
        }),
      ),
    );
    const cards = [...container.querySelectorAll('.room-card')];
    expect(cards).toHaveLength(states.length);
    states.forEach(([, words], i) => expect(cards[i].textContent).toContain(words));
    // an access-denied room gets an inline code field; the rest do not
    expect(cards[5].querySelector('input')).toBeTruthy();
    expect(cards[0].querySelector('input')).toBeNull();
    expect(cards[5].textContent).toContain('access code set');
    // "N online" only when connected or when someone is there
    expect(cards[0].textContent).toContain('0 online');
    expect(cards[1].textContent).not.toContain('online');
  });

  it('turns the socket error codes into "could not reach <host>" and leaves other reasons as they came', async () => {
    const errors: [string, string][] = [
      ['ENOTFOUND', 'could not reach relay.example:8443'],
      ['ETIMEDOUT', 'could not reach relay.example:8443'],
      ['EAI_AGAIN', 'could not reach relay.example:8443'],
      ['ECONNRESET', 'could not reach relay.example:8443'],
      ['relay closed: 4006', 'relay closed: 4006'],
    ];
    mocks.together.mockImplementation(async () => together({ rooms: errors.map((_, i) => room({ id: `r${i}`, name: `room ${i}`, relay: 'wss://relay.example:8443/' })) }));
    await render(statusWith(live({ rooms: errors.map(([error], i) => ({ id: `r${i}`, name: `room ${i}`, relay: 'wss://relay.example:8443/', state: 'disconnected', members: 0, pending: 0, error })) })));
    const cards = [...container.querySelectorAll('.room-card')];
    errors.forEach(([, words], i) => expect(cards[i].textContent).toContain(`offline · retrying · ${words}`));
  });

  it('saves an access code for a room the relay turned away', async () => {
    mocks.together.mockImplementation(async () => together({ rooms: [room()] }));
    mocks.setRoomAccess.mockResolvedValue({ ok: true });
    await render(statusWith(live({ rooms: [{ id: 'r1', name: 'degen circle', relay: 'wss://relay.example', state: 'access-denied', members: 0, pending: 0 }] })));
    await type(container.querySelector('.room-card input') as HTMLInputElement, 'letmein');
    await click(container.querySelector('.room-card button')!);
    expect(mocks.setRoomAccess).toHaveBeenCalledWith('r1', 'letmein');
  });
});

describe('Settings → Together: create', () => {
  it('starts with an empty relay field (there is no official relay), remembers the last one used, and explains what a relay is', async () => {
    await render(statusWith(live()));
    expect(byPlaceholder(RELAY_PLACEHOLDER).value).toBe('');
    expect((button('Create') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.together.mockImplementation(async () => together({ relay: 'wss://mine.example' }));
    await render(statusWith(live()));
    expect(byPlaceholder(RELAY_PLACEHOLDER).value).toBe('wss://mine.example');
    const help = container.querySelector('.relay-help')!;
    expect(help.querySelector('summary')?.textContent).toBe("What's a relay?");
    expect(help.textContent).toContain("The server the room lives on. It passes messages between members and can't read them");
    expect(help.querySelector('a')?.getAttribute('href')).toContain('/docs/together/#relay');
  });

  it('creates on the typed relay, remembers it, and copies the invite', async () => {
    const made = room({ relay: 'wss://relay.example' });
    // once created, the reload lists it: the card is where the "copied" line goes
    mocks.createRoom.mockImplementation(async () => {
      mocks.together.mockImplementation(async () => together({ rooms: [made] }));
      return { room: made, status: live() };
    });
    mocks.setRelay.mockResolvedValue({ relay: 'wss://relay.example' });
    await render(statusWith(live()));
    await type(byPlaceholder('e.g. degen circle'), 'degen circle');
    await type(byPlaceholder(RELAY_PLACEHOLDER), 'wss://relay.example');
    await click(button('Create'));
    expect(mocks.setRelay).toHaveBeenCalledWith('wss://relay.example');
    expect(mocks.createRoom).toHaveBeenCalledWith('degen circle', 'wss://relay.example');
    expect(clipboard).toEqual([made.invite]);
    expect(container.querySelector('.room-card .room-notice')?.textContent).toBe('Invite copied. Send it to your friends.');
    expect(byPlaceholder('e.g. degen circle').value).toBe('');
  });

  it('does not touch the preference when the relay is the one already remembered', async () => {
    mocks.createRoom.mockResolvedValue({ room: room(), status: live() });
    mocks.together.mockImplementation(async () => together({ relay: 'wss://mine.example' }));
    await render(statusWith(live()));
    await type(byPlaceholder('e.g. degen circle'), 'x');
    await click(button('Create'));
    expect(mocks.setRelay).not.toHaveBeenCalled();
    expect(mocks.createRoom).toHaveBeenCalledWith('x', 'wss://mine.example');
  });

  it("shows the relay's answer under the form when create fails", async () => {
    mocks.createRoom.mockRejectedValueOnce(new Error('could not reach mine.example'));
    mocks.together.mockImplementation(async () => together({ relay: 'wss://mine.example' }));
    await render(statusWith(live()));
    await type(byPlaceholder('e.g. degen circle'), 'x');
    await click(button('Create'));
    expect(container.querySelector('.room-form .err')?.textContent).toBe('could not reach mine.example');
  });

  it('Check probes the relay and shows what it found', async () => {
    mocks.probeRelay.mockResolvedValue({ ok: true, v: 1, rooms: 3 });
    mocks.together.mockImplementation(async () => together({ relay: 'wss://mine.example' }));
    await render(statusWith(live()));
    await click(button('Check'));
    expect(mocks.probeRelay).toHaveBeenCalledWith('wss://mine.example');
    expect(container.querySelector('.probe-ok')?.textContent).toBe('relay v1 · 3 rooms');
    mocks.probeRelay.mockResolvedValue({ ok: false, error: 'could not reach mine.example' });
    await click(button('Check'));
    expect(container.querySelector('.probe-err')?.textContent).toBe('could not reach mine.example');
  });
});

describe('Settings → Together: join', () => {
  const INVITE = 'opentrench://room/relay.example/' + 'k'.repeat(43);

  it('joins with just the invite', async () => {
    mocks.joinRoom.mockResolvedValue({ room: room(), status: live() });
    await render(statusWith(live()));
    await type(byPlaceholder('opentrench://room/'), INVITE);
    await click(button('Join'));
    expect(mocks.joinRoom).toHaveBeenCalledWith(INVITE, undefined, undefined);
    expect(byPlaceholder('opentrench://room/').value).toBe('');
  });

  it('reveals the access-code field from its link and sends the code', async () => {
    mocks.joinRoom.mockResolvedValue({ room: room(), status: live() });
    await render(statusWith(live()));
    expect(byPlaceholder('access code')).toBeUndefined();
    await click(button('This relay asks for an access code'));
    expect(byPlaceholder('access code')).toBeTruthy();
    await type(byPlaceholder('opentrench://room/'), INVITE);
    await type(byPlaceholder('access code'), 'letmein');
    await click(button('Join'));
    expect(mocks.joinRoom).toHaveBeenLastCalledWith(INVITE, undefined, 'letmein');
  });

  it('shows a join error under the form', async () => {
    mocks.joinRoom.mockRejectedValueOnce(new Error('relay wants an access code'));
    await render(statusWith(live()));
    await type(byPlaceholder('opentrench://room/'), INVITE);
    await click(button('Join'));
    expect(container.querySelector('.err')?.textContent).toBe('relay wants an access code');
  });

  it('a deep-linked invite lands in the Join field', async () => {
    await render(statusWith(live()), INVITE);
    expect(byPlaceholder('opentrench://room/').value).toBe(INVITE);
  });
});

describe('Settings → Together: same Wi-Fi', () => {
  it('is folded away when nothing on the network is in use', async () => {
    await render(statusWith(live()));
    const d = container.querySelector('details.lan-details') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')?.textContent).toBe('Same Wi-Fi instead (no relay, nothing leaves your network)');
  });

  it('opens on its own when a friend is followed', async () => {
    mocks.together.mockImplementation(async () => together({ peers: [{ host: '10.0.0.2', port: 3211, name: 'bob' }] }));
    await render(statusWith(live({ peers: [{ name: 'bob', url: 'ws://10.0.0.2:3211', state: 'connected' }] })));
    const d = container.querySelector('details.lan-details') as HTMLDetailsElement;
    expect(d.open).toBe(true);
    expect(d.textContent).toContain('bob');
  });

  it('opens on its own when sharing is on', async () => {
    mocks.together.mockImplementation(async () => together({ share: true, pairings: ['opentrench://together/x'] }));
    await render(statusWith(live({ sharing: true })));
    expect((container.querySelector('details.lan-details') as HTMLDetailsElement).open).toBe(true);
  });
});
