// The pure halves of shell-link: the rules that decide where a plugin's fetch may go, what it may
// send and what it may see. They are exported separately from the server so they can run here, in
// plain Node, with no Electron around — which is also the case this file pins: requiring the module
// outside the app must still give these helpers rather than throwing on `require('electron')`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import shellLink from './shell-link.js';

const { isLocalHost, safeResponseHeaders, requestHeadersFor, nextHop, partitionFor, startShellLink } = shellLink;

test('isLocalHost: names and literals that reach this machine or this network', () => {
  const local = [
    'localhost',
    'localhost.', // the root-label spelling resolves the same
    'a.localhost.',
    '127.0.0.1',
    new URL('http://127.1').hostname, // URL folds the short form to 127.0.0.1
    new URL('http://0x7f000001').hostname, // and the hex one
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // the cloud metadata address
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]',
    new URL('http://[::ffff:127.0.0.1]').hostname, // URL writes the mapped tail as two hex groups
    '[64:ff9b::127.0.0.1]',
    'LOCALHOST',
  ];
  for (const h of local) assert.equal(isLocalHost(h), true, `${h} should be local`);

  const public_ = [
    'example.com',
    'not-localhost.example.com',
    '11.0.0.1',
    '172.32.0.1',
    '172.15.0.1',
    '192.169.1.1',
    '100.128.0.1',
    '198.20.0.1',
    '223.255.255.255',
    '[2606:4700::1]',
    '[::ffff:93.184.216.34]',
    '',
  ];
  for (const h of public_) assert.equal(isLocalHost(h), false, `${h} should not be local`);
});

test('safeResponseHeaders: an allow-list, and never a cookie', () => {
  const headers = new Headers([
    ['content-type', 'application/json'],
    ['set-cookie', 'session=abc'],
    ['etag', 'W/"1"'],
    ['x-ratelimit-remaining', '9'],
    ['x-internal-host', 'box-17.internal'],
  ]);
  const out = safeResponseHeaders(headers);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out.etag, 'W/"1"');
  assert.equal(out['x-ratelimit-remaining'], '9');
  assert.equal('set-cookie' in out, false);
  assert.equal('x-internal-host' in out, false);
});

test('safeResponseHeaders: plain objects, mixed case, line breaks, and a cap of 50', () => {
  assert.deepEqual(safeResponseHeaders({ 'Content-Type': 'text/html', 'Set-Cookie2': 'a=1' }), {
    'content-type': 'text/html',
  });
  assert.equal(safeResponseHeaders({ location: 'https://example.com/a\r\nx: y' }).location, 'https://example.com/a x: y');
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`x-ratelimit-${i}`, String(i)]));
  assert.equal(Object.keys(safeResponseHeaders(many)).length, 50);
  assert.deepEqual(safeResponseHeaders(null), {});
});

test('requestHeadersFor: drops the hop-by-hop set and both credential headers', () => {
  const out = requestHeadersFor(
    {
      Host: 'example.com',
      cookie: 'session=abc',
      'content-length': '12',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      upgrade: 'websocket',
      te: 'trailers',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      authorization: 'Bearer plugin-token',
      'proxy-authorization': 'Basic abc',
      'content-type': 'application/json',
      accept: 'text/html',
    },
    { crossOrigin: false },
  );
  assert.deepEqual(out, { 'content-type': 'application/json', accept: 'text/html' });
});

test('requestHeadersFor: bad names, long values, line breaks, and a cap of 40', () => {
  assert.deepEqual(requestHeadersFor({ 'x bad': 'v', 'x-good': 'v' }, {}), { 'x-good': 'v' });
  assert.equal(requestHeadersFor({ 'x-long': 'a'.repeat(9000) }, {})['x-long'].length, 4000);
  assert.equal('x-split' in requestHeadersFor({ 'x-split': 'a\r\nb: c' }, {}), false);
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`x-${i}`, String(i)]));
  assert.equal(Object.keys(requestHeadersFor(many, {})).length, 40);
});

test('requestHeadersFor: a hop that left the origin sheds the headers naming the old one', () => {
  const sent = { origin: 'https://a.example.com', referer: 'https://a.example.com/x', accept: 'text/html' };
  assert.deepEqual(requestHeadersFor(sent, { crossOrigin: false }), sent);
  assert.deepEqual(requestHeadersFor(sent, { crossOrigin: true }), { accept: 'text/html' });
});

test('nextHop: 303 and POST-on-301/302 become a bodyless GET', () => {
  assert.deepEqual(nextHop('https://example.com/a', '/b', 303, 'POST'), {
    url: 'https://example.com/b',
    method: 'GET',
    dropBody: true,
  });
  assert.deepEqual(nextHop('https://example.com/a', '/b', 302, 'POST'), {
    url: 'https://example.com/b',
    method: 'GET',
    dropBody: true,
  });
  assert.deepEqual(nextHop('https://example.com/a', '/b', 303, 'GET'), {
    url: 'https://example.com/b',
    method: 'GET',
    dropBody: true,
  });
});

test('nextHop: a cross-origin 307 keeps the method but never replays the body', () => {
  assert.deepEqual(nextHop('https://a.example.com/x', 'https://b.example.com/y', 307, 'POST'), {
    url: 'https://b.example.com/y',
    method: 'POST',
    dropBody: true,
  });
  assert.deepEqual(nextHop('https://a.example.com/x', '/y', 307, 'POST'), {
    url: 'https://a.example.com/y',
    method: 'POST',
    dropBody: false,
  });
  assert.deepEqual(nextHop('https://a.example.com/x', '/y', 308, 'PUT'), {
    url: 'https://a.example.com/y',
    method: 'PUT',
    dropBody: false,
  });
});

test('nextHop: a relative Location resolves against the hop it came from', () => {
  assert.equal(nextHop('https://example.com/a/b/c', '../d', 302, 'GET').url, 'https://example.com/a/d');
  assert.equal(nextHop('https://example.com/a/b', 'd?q=1', 302, 'GET').url, 'https://example.com/a/d?q=1');
});

test('nextHop: refuses a downgrade, a local address, and a scheme that is not http(s)', () => {
  assert.throws(() => nextHop('https://example.com/a', 'http://example.com/b', 302, 'GET'), /insecure redirect/);
  assert.throws(() => nextHop('https://example.com/a', 'https://localhost/b', 302, 'GET'), /local address/);
  assert.throws(() => nextHop('https://example.com/a', 'https://169.254.169.254/latest', 302, 'GET'), /local address/);
  assert.throws(() => nextHop('https://example.com/a', 'file:///etc/passwd', 302, 'GET'), /http and https only/);
  assert.throws(() => nextHop('https://example.com/a', 'http://', 302, 'GET'), /unreadable location/);
  assert.equal(nextHop('http://example.com/a', 'https://example.com/b', 302, 'GET').url, 'https://example.com/b');
});

test('partitionFor: one persistent partition per site host', () => {
  assert.equal(partitionFor('https://example.com'), 'persist:site-example.com');
  assert.equal(partitionFor('https://a.example.com/some/path'), 'persist:site-a.example.com');
  assert.equal(partitionFor('https://example.com:8443'), 'persist:site-example.com_8443');
});

test('without Electron the server half says so rather than failing obscurely', async () => {
  await assert.rejects(() => startShellLink({ log: () => {} }), /Electron/);
});
