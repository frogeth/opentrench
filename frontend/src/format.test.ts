import { describe, expect, it } from 'vitest';
import { plainText } from './format';

describe('plainText', () => {
  it('keeps link words and drops markdown markers, for a notification body', () => {
    expect(plainText('✔️ **Buy Executed**\n\n[$CATTO](https://t.me/x?start=1) ⋅ `0xabc`\n[[cancel all]](https://t.me/y)')).toBe('✔️ Buy Executed\n$CATTO ⋅ 0xabc\n[cancel all]');
  });
});

describe('webHref', () => {
  it('passes plain web links and nothing else into a link or a chart frame', async () => {
    const { webHref, chartEmbedUrl } = await import('./format');
    expect(webHref('https://dexscreener.com/bsc/x')).toBe('https://dexscreener.com/bsc/x');
    for (const bad of ['javascript:alert(1)', 'file://evil/share/x.exe', 'ms-msdt:/id', 'data:text/html,x', 'nope', undefined]) expect(webHref(bad), String(bad)).toBeUndefined();
    expect(chartEmbedUrl({ address: '0xabc', embedUrl: 'javascript:parent.alert(1)' }, 'dexscreener')).toBeUndefined();
  });
});
