import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RichText } from './RichText';

const CA = '0x6f572e8020247324d7b9dc15c297a32e4187df1c';
let container: HTMLDivElement;
let root: Root;
let clipboard: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => void clipboard.push(s) }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('contract addresses in chat text', () => {
  it('stay the same element across re-renders, so a click that spans a live-feed update still lands and "copied" stays up', async () => {
    const text = `/cx 4h \`${CA}\` and **bold** https://x.com/a`;
    act(() => root.render(<RichText text={text} contracts={[CA]} />));
    const before = container.querySelector('.ca')!;
    await act(async () => {
      before.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clipboard).toEqual([CA]);
    // the feed re-renders the row (a new token tick, the clock) with the same message
    act(() => root.render(<RichText text={text} contracts={[CA]} />));
    const after = container.querySelector('.ca')!;
    expect(after).toBe(before);
    expect(after.querySelector('.ca-tip')?.textContent).toBe('copied');
  });
});

describe('bot panel links', () => {
  it('render a link whose text is itself bracketed, as bots write [[cancel all]](url)', () => {
    const url = 'https://t.me/cove_trading_bot?start=locx_1_2yyQGySj9G17M8G8maRTmahcnf6MxkdJYe5SdyRapump';
    act(() => root.render(<RichText text={`**Active Orders** (2) [[cancel all]](${url})`} />));
    const a = container.querySelector('a.md-link')!;
    expect(a.getAttribute('href')).toBe(url);
    expect(a.textContent).toBe('[cancel all]');
    expect(container.textContent).not.toContain('](');
  });
});

describe('room invites in chat text', () => {
  const invite = 'opentrench://room/relay.example.com/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

  it('are links, bare or in code, so a click reaches the app', () => {
    act(() => root.render(<RichText text={`join us ${invite} and \`${invite}\``} />));
    const links = [...container.querySelectorAll('a.md-link')];
    expect(links).toHaveLength(2);
    for (const a of links) expect(a.getAttribute('href')).toBe(invite);
  });

  it('leave other custom schemes as text', () => {
    act(() => root.render(<RichText text="opentrench://together/10.0.0.2:3211/tok and javascript://x" />));
    expect(container.querySelector('a')).toBeNull();
  });
});
