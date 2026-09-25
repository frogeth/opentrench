import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WatchlistColumn } from './WatchlistColumn';
import type { TokenInfo, WatchEntry } from '../types';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const token = (address: string, extra: Partial<TokenInfo>): TokenInfo => ({ chain: 'evm', address, seen: 0, calledIn: [], calls: [], firstSeenTs: 0, lastCallTs: 0, ...extra });
const entries: WatchEntry[] = [
  { address: A, chain: 'evm', addedAt: 2, addedMarketCap: 1000 },
  { address: B, chain: 'evm', addedAt: 1 },
];
const tokens = { [A]: token(A, { symbol: 'AAA', marketCap: 2000 }), [B]: token(B, { symbol: 'BBB', marketCap: 9000, change1h: -12 }) };

function render(props: Partial<Parameters<typeof WatchlistColumn>[0]> = {}) {
  const handlers = { onSort: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onOpen: vi.fn(), onAlerts: vi.fn() };
  act(() => root.render(<WatchlistColumn entries={entries} pending={[]} tokens={tokens} now={10} telegramConnected={false} {...handlers} {...props} />));
  return handlers;
}
const symbols = () => [...container.querySelectorAll('.wl-row .wl-tok b')].map((b) => b.textContent);

describe('WatchlistColumn', () => {
  it('shows one row per token, newest added first, with the numbers', () => {
    render();
    expect(symbols()).toEqual(['AAA', 'BBB']);
    const first = container.querySelector('.wl-item')!;
    expect(first.textContent).toContain('$2.0K');
    expect(first.textContent).toContain('+100%'); // since added
    expect(container.querySelectorAll('.wl-item')[1].textContent).toContain('-12%');
  });

  it('sorts by the header it is given, and a header click asks for the other direction', () => {
    const h = render({ sort: { key: 'marketCap', dir: 'desc' } });
    expect(symbols()).toEqual(['BBB', 'AAA']);
    act(() => (container.querySelector('.wl-head button.on') as HTMLButtonElement).click());
    expect(h.onSort).toHaveBeenCalledWith({ key: 'marketCap', dir: 'asc' });
  });

  it('removes with the row ✕ and unfolds the alerts under a clicked row', () => {
    const h = render();
    act(() => (container.querySelector('.wl-x') as HTMLButtonElement).click());
    expect(h.onRemove).toHaveBeenCalledWith(A);
    act(() => (container.querySelector('.wl-row .wl-tok') as HTMLElement).click());
    expect(container.querySelector('.wl-alerts')).not.toBeNull();
  });

  it('has an empty state, and shows adds still being looked up', () => {
    render({ entries: [], tokens: {} });
    expect(container.querySelector('.wl-empty')).not.toBeNull();
    render({ entries: [], tokens: {}, pending: [A] });
    expect(container.querySelector('.wl-skel')?.textContent).toContain('looking up');
  });
});
