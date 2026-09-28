import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { LaunchpadBadge } from './LaunchpadBadge';

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

describe('launchpad badge', () => {
  const TOKEN = '0x1234567890abcdef1234567890abcdef12349999';

  it('shows Loong with the logo shipped in the app, linking to its token page', () => {
    act(() => root.render(<LaunchpadBadge launchpad="loong" url={`https://loongfamily.app/#/token/${TOKEN}`} note="on the curve" />));
    const a = container.querySelector('a.lp-loong')!;
    expect(a.getAttribute('href')).toBe(`https://loongfamily.app/#/token/${TOKEN}`);
    expect(a.getAttribute('title')).toBe('launched on Loong · on the curve');
    expect(a.querySelector('img')!.getAttribute('src')).toBe('/launchpads/loong.png');
  });

  it('never links a badge to something that is not a web address', () => {
    act(() => root.render(<LaunchpadBadge launchpad="loong" url="javascript:alert(1)" />));
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('span.lp-loong')).not.toBeNull();
  });
});
