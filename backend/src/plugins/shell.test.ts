import { describe, expect, it, vi } from 'vitest';
import { makeSafeLookup, safeDispatcher, ShellLink } from './shell.js';

/** Tests that never reach the network do not need the real dispatcher; this stands in for it. */
const noAgent = {} as unknown;

describe('ShellLink', () => {
  it('without a shell: no sessions, sign-in unavailable, fetch goes plain', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const link = new ShellLink(fetchImpl as any);
    expect(link.available()).toBe(false);
    expect(await link.signedIn(['https://example.com'])).toEqual([]);
    await expect(link.signIn('https://example.com')).rejects.toThrow('desktop app');
    const r = await link.fetch('https://example.com/api', { method: 'GET' }, false);
    expect(r).toEqual({ status: 200, headers: { 'content-type': 'text/plain', 'content-length': '2' }, body: 'ok', truncated: false });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({ method: 'GET', redirect: 'manual' }));
    // every plain hop goes out on the dispatcher that resolves and pins the address first
    expect((fetchImpl.mock.calls[0][1] as any).dispatcher).toBeTruthy();
  });
  it('with a shell: site fetches and status go to the callback with the token', async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith('/status')) return new Response(JSON.stringify({ signedIn: ['https://example.com'] }), { status: 200 });
      return new Response(
        JSON.stringify({ status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1', 'X-Internal': 'secret' }, body: '{"x":1}' }),
        { status: 200 },
      );
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'tok');
    expect(link.available()).toBe(true);
    expect(await link.signedIn(['https://example.com', 'https://other.example'])).toEqual(['https://example.com']);
    const r = await link.fetch('https://example.com/api', { method: 'POST', body: '{}' }, true);
    expect(r).toEqual({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '7' }, body: '{"x":1}', truncated: false });
    expect(calls[1].url).toBe('http://127.0.0.1:45678/fetch');
    expect(calls[1].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[1].init.body)).toEqual({ url: 'https://example.com/api', init: { method: 'POST', body: '{}' } });
  });
  it('plain fetch follows up to 5 redirects but never to a local address, and caps the body', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      if (url === 'https://example.com/a') return new Response(null, { status: 302, headers: { location: '/b' } });
      if (url === 'https://example.com/b') return new Response('there', { status: 200 });
      if (url === 'https://example.com/local') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3210/api/config' } });
      if (url === 'https://example.com/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
      if (url === 'https://example.com/big') return new Response('x'.repeat(5 * 1024 * 1024), { status: 200 });
      return new Response('?', { status: 404 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    expect((await link.fetch('https://example.com/a', {}, false)).body).toBe('there');
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b']);
    await expect(link.fetch('https://example.com/local', {}, false)).rejects.toThrow('local address');
    await expect(link.fetch('https://example.com/loop', {}, false)).rejects.toThrow('redirects');
    await expect(link.fetch('http://127.0.0.1:3210/api/config', {}, false)).rejects.toThrow('local address');
    const big = await link.fetch('https://example.com/big', {}, false);
    expect(big.body.length).toBe(4 * 1024 * 1024);
    expect(big.truncated).toBe(true);
    expect(big.headers['content-length']).toBe(String(4 * 1024 * 1024));
  });
  it('a shell that stops answering is treated as gone for status, and a site fetch fails rather than going out without the login', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('http://127.0.0.1:')) throw new Error('ECONNREFUSED');
      return new Response('plain', { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'tok');
    expect(await link.signedIn(['https://example.com'])).toEqual([]);
    await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('shell');
  });
  it('cookies and headers the plugin has no business with are dropped on both paths', async () => {
    const plainImpl = vi.fn(
      async () =>
        new Response('hi', {
          status: 200,
          headers: { 'content-type': 'text/html', 'set-cookie': 'sid=1; HttpOnly', 'x-internal-route': 'admin', 'x-ratelimit-remaining': '9' },
        }),
    );
    const plain = new ShellLink(plainImpl as any, noAgent);
    const viaPlain = await plain.fetch('https://example.com/', {}, false);
    expect(viaPlain.headers).toEqual({ 'content-type': 'text/html', 'x-ratelimit-remaining': '9', 'content-length': '2' });

    const shellImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: 200, headers: { 'set-cookie': 'sid=1', 'Set-Cookie2': 'sid=2', etag: 'W/"7"', 'x-internal-route': 'admin' }, body: 'hi' }),
          { status: 200 },
        ),
    );
    const shell = new ShellLink(shellImpl as any, noAgent);
    await shell.hello(45678, 'tok');
    const viaShell = await shell.fetch('https://example.com/', {}, true);
    expect(viaShell.headers).toEqual({ etag: 'W/"7"', 'content-length': '2' });
  });
  it('a redirect that crosses origins leaves the login behind; one that stays keeps it', async () => {
    const seen: { url: string; headers: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      seen.push({ url, headers: init.headers });
      if (url === 'https://example.com/same') return new Response(null, { status: 302, headers: { location: 'https://example.com/next' } });
      if (url === 'https://example.com/away') return new Response(null, { status: 302, headers: { location: 'https://other.example/next' } });
      return new Response('done', { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.fetch('https://example.com/same', { headers: { Authorization: 'Bearer site', Cookie: 'sid=1', Host: 'spoof.example' } }, false);
    expect(seen[0].headers).toEqual({ authorization: 'Bearer site' }); // cookie and host never leave here
    expect(seen[1].headers.authorization).toBe('Bearer site');
    seen.length = 0;
    await link.fetch('https://example.com/away', { headers: { authorization: 'Bearer site' } }, false);
    expect(seen[1].url).toBe('https://other.example/next');
    expect(seen[1].headers.authorization).toBeUndefined();
  });
  it('a POST that is redirected becomes a GET without its body or content-type', async () => {
    const seen: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      seen.push({ url, init });
      if (url === 'https://example.com/post') return new Response(null, { status: 303, headers: { location: '/done' } });
      return new Response('done', { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.fetch('https://example.com/post', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, false);
    expect(seen[1].init.method).toBe('GET');
    expect(seen[1].init.body).toBeUndefined();
    expect(seen[1].init.headers['content-type']).toBeUndefined();
  });
  it('every hop must be http or https, and https never hands off to http', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/data') return new Response(null, { status: 302, headers: { location: 'data:text/html,x' } });
      if (url === 'https://example.com/down') return new Response(null, { status: 302, headers: { location: 'http://example.com/' } });
      return new Response('ok', { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await expect(link.fetch('https://example.com/data', {}, false)).rejects.toThrow('http and https only');
    await expect(link.fetch('https://example.com/down', {}, false)).rejects.toThrow('insecure redirect');
    await expect(link.fetch('file:///etc/passwd', {}, false)).rejects.toThrow('http and https only');
  });
  it('a name that resolves to a local address is refused before the socket opens', async () => {
    const rebind = makeSafeLookup(((_h: string, _o: any, cb: any) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as any);
    const refused = await new Promise<Error | null>((done) => rebind('rebind.example', { all: true }, (err) => done(err as Error)));
    expect(refused?.message).toContain('local address');

    const public_ = makeSafeLookup(((_h: string, _o: any, cb: any) => cb(null, [{ address: '203.0.113.7', family: 4 }])) as any);
    const pinned = await new Promise<unknown>((done) => public_('example.com', { all: true }, (_err, addresses) => done(addresses)));
    expect(pinned).toEqual([{ address: '203.0.113.7', family: 4 }]); // the connection gets what we checked
  });
  it('a shell reply that is not shaped like a response is refused', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'two hundred', headers: {}, body: 'x' }), { status: 200 }));
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'tok');
    await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('bad status');
  });
  it('a second hello is ignored while the first shell answers, and taken once it has stopped', async () => {
    let live = true;
    const fetchImpl = vi.fn(async () => {
      if (!live) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ signedIn: [] }), { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'first');
    await link.hello(45679, 'second'); // probes the first, which answers, so the first keeps the link
    await link.signedIn(['https://example.com']);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:45678/status');

    live = false;
    for (let i = 0; i < 3; i++) await link.signedIn(['https://example.com']);
    expect(link.available()).toBe(false);

    live = true;
    await link.hello(45679, 'second');
    expect(link.available()).toBe(true);
    await link.signedIn(['https://example.com']);
    const last = fetchImpl.mock.calls.at(-1)!;
    expect(last[0]).toBe('http://127.0.0.1:45679/status');
    expect((last[1] as any).headers.authorization).toBe('Bearer second');

    link.goodbye();
    expect(link.available()).toBe(false);
  });

  it('a site fetch with no desktop app says so rather than quietly going out without the login', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain', { status: 200 }));
    const link = new ShellLink(fetchImpl as any, noAgent);
    await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('not connected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('a shell that answers badly keeps the link; only silence takes it away', async () => {
    let dead = false;
    const oversize = JSON.stringify({ status: 200, headers: {}, body: 'x'.repeat(7 * 1024 * 1024) });
    const fetchImpl = vi.fn(async () => {
      if (dead) throw new Error('ECONNREFUSED');
      return new Response(oversize, { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'tok');
    for (let i = 0; i < 3; i++) await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('size cap');
    expect(link.available()).toBe(true); // a bad reply is this request going wrong, not the shell going away
    dead = true;
    for (let i = 0; i < 3; i++) await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('shell unreachable');
    expect(link.available()).toBe(false);
  });
  it('a hello while the registered shell is silent takes the link over at once', async () => {
    let live = true;
    const fetchImpl = vi.fn(async () => {
      if (!live) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ signedIn: [] }), { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any, noAgent);
    await link.hello(45678, 'first');
    live = false;
    await link.hello(45680, 'restarted'); // the probe goes unanswered: no waiting out three real requests
    expect(link.available()).toBe(true);
    live = true;
    await link.signedIn(['https://example.com']);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe('http://127.0.0.1:45680/status');
  });
  it('the default fetch and the pinning agent come from the same undici', async () => {
    // Node's global fetch carries its own bundled undici; handed our Agent it dies with 'invalid
    // onRequestStart method' before it ever resolves a name. The resolver is injected rather than letting a
    // real lookup of .invalid decide, because a resolver that hijacks NXDOMAIN would answer with an address.
    const enotfound = ((host: string, _o: any, cb: any) => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))) as any;
    const link = new ShellLink(undefined, safeDispatcher(makeSafeLookup(enotfound)));
    const err = await link.fetch('https://does-not-exist.invalid/', {}, false).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string; code?: string } },
    );
    const reported = [err?.message, err?.cause?.message, err?.cause?.code].join(' | ');
    expect(reported).not.toContain('onRequestStart');
    expect(reported).toMatch(/ENOTFOUND|EAI_AGAIN|could not resolve/i);
  });
  it('an IPv4 smuggled inside an IPv6, and IPv6 multicast, are refused too', async () => {
    for (const address of ['64:ff9b::7f00:1', '0:0:0:0:0:0:0:1', 'ff02::1', '::ffff:169.254.169.254']) {
      const lookup = makeSafeLookup(((_h: string, _o: any, cb: any) => cb(null, [{ address, family: 6 }])) as any);
      const refused = await new Promise<Error | null>((done) => lookup('sneaky.example', { all: true }, (e) => done(e as Error)));
      expect(refused?.message, address).toContain('local address');
    }
  });
});
