import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AuthorMenu } from './AuthorMenu';

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

const items = () => {
  act(() => container.querySelector<HTMLButtonElement>('.amenu-btn')!.click());
  return [...container.querySelectorAll('.amenu-pop button')].map((b) => b.textContent ?? '');
};

describe('author menu', () => {
  it('lets a shown bot be favorited, next to hiding it', () => {
    act(() => root.render(<AuthorMenu author="AlertBot" bot />));
    const list = items();
    expect(list.some((t) => t.includes('Favorite caller'))).toBe(true);
    expect(list.some((t) => t.includes('Hide this bot'))).toBe(true);
  });

  it('offers no favorite for a hidden bot, only showing it', () => {
    act(() => root.render(<AuthorMenu author="AlertBot" bot hidden />));
    const list = items();
    expect(list.some((t) => t.includes('Favorite caller'))).toBe(false);
    expect(list.some((t) => t.includes('Show this bot'))).toBe(true);
  });
});
