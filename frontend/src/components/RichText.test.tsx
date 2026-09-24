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
