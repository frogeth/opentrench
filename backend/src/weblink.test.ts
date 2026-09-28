import { describe, expect, it } from 'vitest';
import { imageLink, scrubLinks, webLink } from './weblink.js';
import { MessageHub } from './hub.js';
import type { TokenInfo } from './types.js';

describe('token links', () => {
  it('keep plain web addresses only', () => {
    expect(webLink(' https://example.com/x ')).toBe('https://example.com/x');
    expect(webLink('http://example.com')).toBe('http://example.com');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'file://attacker/share/x.exe', '\\\\attacker\\share\\x.exe', 'ms-msdt:/id', 'search-ms:query=x', 'data:text/html,<script>', 'vbscript:x', 'example.com', '', 'https://'])
      expect(webLink(bad), bad).toBeUndefined();
  });

  it('allow images from the web, our IPFS proxy, or inline image data', () => {
    expect(imageLink('/api/ipfs/QmAbc/logo.png')).toBe('/api/ipfs/QmAbc/logo.png');
    expect(imageLink('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(imageLink('/api/config')).toBeUndefined();
    expect(imageLink('/api/ipfs/Qm/../../config')).toBeUndefined();
    expect(imageLink('/api/ipfs/Qm/%2e%2e/%2e%2e/api/config')).toBeUndefined();
    expect(imageLink('/api/ipfs/Qm/a\\b')).toBeUndefined();
    expect(imageLink('/api/ipfs/Qm/x.png?y=1')).toBeUndefined();
    expect(imageLink('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined();
  });

  it('are scrubbed off a token, the chart embed included', () => {
    const t: Partial<TokenInfo> = { website: 'file://attacker/x.exe', twitter: 'https://x.com/a', embedUrl: 'javascript:parent.alert(1)', launchpadUrl: 'ms-msdt:/id', imageUrl: 'https://img.example/a.png' };
    expect(scrubLinks(t)).toBe(3);
    expect(t).toEqual({ twitter: 'https://x.com/a', imageUrl: 'https://img.example/a.png' });
  });
});

describe('a token a friend shares', () => {
  const base = { chain: 'evm' as const, address: '0x' + 'ab'.repeat(20), seen: 0, calledIn: [], firstSeenTs: 1, lastCallTs: 1 };
  const call = { msgId: 'm1', chatName: 'alpha', source: 'telegram' as const, author: 'x', ts: 1 };

  it('arrives without links that are not plain web addresses, new or already known', () => {
    const hub = new MessageHub(10);
    hub.applyRemoteToken('friend', { ...base, calls: [call], website: 'file://evil/x.exe', embedUrl: 'javascript:alert(1)', chartUrl: 'https://dexscreener.com/bsc/x' } as TokenInfo);
    const t = hub.getToken(base.address)!;
    expect(t.website).toBeUndefined();
    expect(t.embedUrl).toBeUndefined();
    expect(t.chartUrl).toBe('https://dexscreener.com/bsc/x');
  });
});
