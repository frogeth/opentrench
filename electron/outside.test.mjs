// Which links stay in the window, which go to the browser, and which are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import outside from './outside.js';

const { isAppUrl, outsideAction } = outside;
const APP = 'http://127.0.0.1:3210';

test('isAppUrl: our origin only, never a look-alike that starts with it', () => {
  assert.equal(isAppUrl('http://127.0.0.1:3210/', APP), true);
  assert.equal(isAppUrl('http://127.0.0.1:3210/?x=1#y', APP), true);
  for (const u of ['http://127.0.0.1:3210@evil.example/', 'http://127.0.0.1:32100/', 'http://127.0.0.1:3210.evil.example/', 'https://127.0.0.1:3210/', 'http://localhost:3210/', 'file:///x', 'not a url', ''])
    assert.equal(isAppUrl(u, APP), false, u);
});

test('outsideAction: web and Telegram links open, invites come back, everything else is refused', () => {
  assert.deepEqual(outsideAction('https://x.com/a'), { action: 'open', href: 'https://x.com/a' });
  assert.equal(outsideAction('http://example.com').action, 'open');
  assert.equal(outsideAction('tg://resolve?domain=x').action, 'open');
  assert.equal(outsideAction('opentrench://room/relay.example/abc').action, 'link');
  for (const u of ['file:///C:/Windows/System32/calc.exe', 'file://attacker.example/share/x.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'smb://attacker/x', 'nope'])
    assert.equal(outsideAction(u).action, 'refuse', u);
});
