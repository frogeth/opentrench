// The pure halves of shell-link: the rules that decide where a plugin's fetch may go, what it may
// send and what it may see. They are exported separately from the server so they can run here, in
// plain Node, with no Electron around — which is also the case this file pins: requiring the module
// outside the app must still give these helpers rather than throwing on `require('electron')`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import shellLink from './shell-link.js';

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const { isLocalHost, safeResponseHeaders, requestHeadersFor, nextHop, partitionFor, startShellLink, fetchWithSite } =
  shellLink;

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

test('partitionFor: one partition per origin, named by a hash of it', () => {
  const hashed = (origin) => `persist:site-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;
  assert.equal(partitionFor('https://example.com'), hashed('https://example.com'));
  assert.equal(partitionFor('https://example.com/some/path?q=1'), hashed('https://example.com'));
  // Origins that differ only in scheme or port are different logins and must not share a partition.
  assert.notEqual(partitionFor('https://example.com'), partitionFor('http://example.com'));
  assert.notEqual(partitionFor('https://example.com'), partitionFor('https://example.com:8443'));
  assert.notEqual(partitionFor('https://a.example.com'), partitionFor('https://b.example.com'));
  assert.match(partitionFor('https://example.com'), /^persist:site-[0-9a-f]{16}$/);
});

test('without Electron the server half says so rather than failing obscurely', async () => {
  await assert.rejects(() => startShellLink({ log: () => {} }), /Electron/);
});

// The routes themselves need Electron; the server around them does not, so it gets a stand-in and a
// real socket. What is being pinned here is the shape of the answer, not what the routes do.
const stubImpl = {
  signedIn: async (sites) => sites,
  openSignIn: () => {},
  fetchWithSite: async () => ({ status: 200, headers: {}, body: '', truncated: false }),
};

async function withLink(run) {
  const link = await startShellLink({ log: () => {}, impl: stubImpl });
  try {
    return await run(link, (path, init = {}) =>
      fetch(`http://127.0.0.1:${link.port}${path}`, {
        method: 'POST',
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}`, ...init.headers },
      }),
    );
  } finally {
    link.close();
  }
}

test('an oversize body is answered, not dropped: a killed socket would look like a dead shell', async () => {
  await withLink(async (_link, post) => {
    // Over REQUEST_MAX (8 MB) with room to spare, so the cap trips well before the body ends.
    const res = await post('/fetch', { body: JSON.stringify({ url: 'https://example.com', pad: 'x'.repeat(12 * 1024 * 1024) }) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body is too large' });
  });
});

test('the link answers only a POST that carries its token', async () => {
  await withLink(async (link, post) => {
    const ok = await post('/status', { body: JSON.stringify({ sites: ['https://example.com'] }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { signedIn: ['https://example.com'] });

    const noToken = await post('/status', { body: '{}', headers: { authorization: 'Bearer wrong' } });
    assert.equal(noToken.status, 401);
    // A token of a different length must be refused the same way, not thrown from timingSafeEqual.
    const shortToken = await post('/status', { body: '{}', headers: { authorization: 'Bearer x' } });
    assert.equal(shortToken.status, 401);

    const wrongRoute = await post('/nope', { body: '{}' });
    assert.equal(wrongRoute.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${link.port}/status`, {
      method: 'GET',
      headers: { authorization: `Bearer ${link.token}` },
    });
    assert.equal(wrongMethod.status, 405);
  });
});

test('a route that throws comes back as a message, never a stack', async () => {
  const link = await startShellLink({
    log: () => {},
    impl: { ...stubImpl, fetchWithSite: async () => { throw new Error('nope'); } },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${link.port}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}` },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'nope' });
  } finally {
    link.close();
  }
});

// ---------------------------------------------------------------------------
// The site fetch. `net.request` is stood in for: what is being tested is the hop loop — which hops are
// followed on the same request, which start a fresh one, and which are refused.
// ---------------------------------------------------------------------------

/**
 * A stand-in for Electron's `net.request`. `script` maps a URL to what the server there does:
 * `{ redirect: { status, location } }` or `{ status, headers, body }`. Every request made is recorded.
 */
function fakeNet(script) {
  const sent = [];
  const factory = ({ url, method, partition }) => {
    const req = new EventEmitter();
    const record = { url, method, partition, headers: {}, body: undefined, followed: 0, aborted: false };
    sent.push(record);
    let at = url;
    let following = null; // where a followRedirect() would go, as Electron reports it: absolute
    req.setHeader = (k, v) => (record.headers[k] = v);
    req.write = (b) => (record.body = b);
    req.abort = () => {
      record.aborted = true;
    };
    const step = () => {
      const page = script[at];
      if (!page) throw new Error(`the test script has nothing at ${at}`);
      if (page.redirect) {
        // Electron hands the redirect event an absolute url, whatever the header said.
        following = new URL(page.redirect.location, at).toString();
        req.emit('redirect', page.redirect.status, record.method, following, {});
        return;
      }
      const res = new EventEmitter();
      res.statusCode = page.status ?? 200;
      res.headers = page.headers ?? { 'content-type': 'text/plain' };
      req.emit('response', res);
      for (const chunk of page.chunks ?? [Buffer.from(page.body ?? '')]) res.emit('data', chunk);
      res.emit('end');
    };
    req.followRedirect = () => {
      record.followed++;
      at = following;
      queueMicrotask(step);
    };
    req.end = () => queueMicrotask(step);
    return req;
  };
  factory.sent = sent;
  return factory;
}

test('a redirect chain that ends at a body: same-shape hops ride one request', async () => {
  const net = fakeNet({
    'https://example.com/one': { redirect: { status: 302, location: 'https://example.com/two' } },
    'https://example.com/two': { redirect: { status: 302, location: '/three' } },
    'https://example.com/three': { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
  });
  const out = await fetchWithSite('https://example.com/one', {}, net);
  assert.equal(out.status, 200);
  assert.equal(out.body, '{"ok":true}');
  assert.equal(out.truncated, false);
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.headers['content-length'], '11');
  // A GET that keeps its shape never needs a second request: followRedirect() handles both hops.
  assert.equal(net.sent.length, 1);
  assert.equal(net.sent[0].followed, 2);
});

test('a 303 restarts as a fresh GET, because followRedirect cannot change the method', async () => {
  const net = fakeNet({
    'https://example.com/post': { redirect: { status: 303, location: '/done' } },
    'https://example.com/done': { status: 200, body: 'thanks' },
  });
  const out = await fetchWithSite(
    'https://example.com/post',
    { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    net,
  );
  assert.equal(out.body, 'thanks');
  assert.equal(net.sent.length, 2);
  assert.equal(net.sent[0].method, 'POST');
  assert.equal(net.sent[0].body, 'a=1');
  assert.equal(net.sent[0].aborted, true);
  assert.equal(net.sent[1].method, 'GET');
  assert.equal(net.sent[1].body, undefined);
  assert.equal('content-type' in net.sent[1].headers, false); // a bodyless request describes no body
});

test('a cross-origin 307 keeps the method on a fresh request, without the body', async () => {
  const net = fakeNet({
    'https://a.example.com/x': { redirect: { status: 307, location: 'https://b.example.com/y' } },
    'https://b.example.com/y': { status: 200, body: 'over here' },
  });
  const out = await fetchWithSite('https://a.example.com/x', { method: 'POST', body: 'secret' }, net);
  assert.equal(out.body, 'over here');
  assert.equal(net.sent.length, 2);
  assert.equal(net.sent[1].method, 'POST');
  assert.equal(net.sent[1].body, undefined);
  // Both requests are made from the first site's partition: the login follows the plugin's site.
  assert.equal(net.sent[1].partition, net.sent[0].partition);
});

test('a hop the backend would refuse is refused here, and the request is aborted', async () => {
  const local = fakeNet({
    'https://example.com/a': { redirect: { status: 302, location: 'https://127.0.0.1:3210/api/config' } },
  });
  await assert.rejects(() => fetchWithSite('https://example.com/a', {}, local), /local address/);
  assert.equal(local.sent[0].aborted, true);

  const downgrade = fakeNet({
    'https://example.com/a': { redirect: { status: 302, location: 'http://example.com/a' } },
  });
  await assert.rejects(() => fetchWithSite('https://example.com/a', {}, downgrade), /insecure redirect/);

  const scheme = fakeNet({ 'https://example.com/a': { redirect: { status: 302, location: 'file:///etc/passwd' } } });
  await assert.rejects(() => fetchWithSite('https://example.com/a', {}, scheme), /http and https only/);
});

const MAX_REDIRECTS_IN_TEST = 5;

test('the hop cap holds across both kinds of hop', async () => {
  const chain = {};
  for (let i = 0; i < 9; i++) chain[`https://example.com/${i}`] = { redirect: { status: 302, location: `/${i + 1}` } };
  chain['https://example.com/9'] = { status: 200, body: 'never reached' };
  await assert.rejects(() => fetchWithSite('https://example.com/0', {}, fakeNet(chain)), /too many redirects/);

  // 303s restart, so these are six separate requests rather than one with six followRedirects.
  const restarts = {};
  for (let i = 0; i < 9; i++) restarts[`https://example.com/${i}`] = { redirect: { status: 303, location: `/${i + 1}` } };
  const net = fakeNet(restarts);
  await assert.rejects(() => fetchWithSite('https://example.com/0', {}, net), /too many redirects/);
  assert.equal(net.sent.length, MAX_REDIRECTS_IN_TEST + 1);
});

test('a body past the cap is cut, flagged, and the rest is not waited for', async () => {
  const net = fakeNet({
    'https://example.com/big': {
      status: 200,
      chunks: [Buffer.alloc(3 * 1024 * 1024, 0x61), Buffer.alloc(3 * 1024 * 1024, 0x62)],
    },
  });
  const out = await fetchWithSite('https://example.com/big', {}, net);
  assert.equal(out.truncated, true);
  assert.equal(out.body.length, 4 * 1024 * 1024);
  assert.equal(out.headers['content-length'], String(4 * 1024 * 1024));
  assert.equal(net.sent[0].aborted, true);
});

test('what a plugin may ask for: the url, the method and the body are all checked here too', async () => {
  const net = fakeNet({ 'https://example.com/a': { status: 200, body: 'ok' } });
  await assert.rejects(() => fetchWithSite('http://127.0.0.1/a', {}, net), /local address/);
  await assert.rejects(() => fetchWithSite('nonsense', {}, net), /needs a url/);
  await assert.rejects(() => fetchWithSite('https://example.com/a', { method: 'TRACE' }, net), /does not allow the method/);
  await assert.rejects(() => fetchWithSite('https://example.com/a', { body: { a: 1 } }, net), /body must be text/);
  await assert.rejects(
    () => fetchWithSite('https://example.com/a', { method: 'GET', body: 'x' }, net),
    /GET does not carry a body/,
  );
  assert.equal(net.sent.length, 0); // none of these ever reached the wire
});

test('the shell path sheds the headers that name an origin, always', async () => {
  const net = fakeNet({ 'https://example.com/a': { status: 200, body: 'ok' } });
  await fetchWithSite(
    'https://example.com/a',
    { headers: { origin: 'https://example.com', referer: 'https://example.com/b', accept: 'text/html' } },
    net,
  );
  assert.deepEqual(net.sent[0].headers, { accept: 'text/html' });
});

test('a fetch that fails is a 400, not a 500: a 500 is the backend deciding the shell has died', async () => {
  const link = await startShellLink({
    log: () => {},
    impl: {
      ...stubImpl,
      fetchWithSite: (url, init) => fetchWithSite(url, init, fakeNet({})),
    },
  });
  try {
    const call = (body) =>
      fetch(`http://127.0.0.1:${link.port}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}` },
        body: JSON.stringify(body),
      });
    const localAddress = await call({ url: 'http://169.254.169.254/latest' });
    assert.equal(localAddress.status, 400);
    assert.match((await localAddress.json()).error, /local address/);

    const badMethod = await call({ url: 'https://example.com/a', init: { method: 'CONNECT' } });
    assert.equal(badMethod.status, 400);
    assert.match((await badMethod.json()).error, /does not allow the method/);
  } finally {
    await link.close();
  }
});
