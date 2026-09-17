import { describe, expect, it, vi } from 'vitest';
import { ShellLink } from './shell.js';

describe('ShellLink', () => {
  it('without a shell: no sessions, sign-in unavailable, fetch goes plain', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const link = new ShellLink(fetchImpl as any);
    expect(link.available()).toBe(false);
    expect(await link.signedIn(['https://example.com'])).toEqual([]);
    await expect(link.signIn('https://example.com')).rejects.toThrow('desktop app');
    const r = await link.fetch('https://example.com/api', { method: 'GET' }, false);
    expect(r).toEqual({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({ method: 'GET', redirect: 'manual' }));
  });
  it('with a shell: site fetches and status go to the callback with the token', async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith('/status')) return new Response(JSON.stringify({ signedIn: ['https://example.com'] }), { status: 200 });
      return new Response(JSON.stringify({ status: 200, headers: { a: 'b' }, body: '{"x":1}' }), { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any);
    link.hello(45678, 'tok');
    expect(link.available()).toBe(true);
    expect(await link.signedIn(['https://example.com', 'https://other.example'])).toEqual(['https://example.com']);
    const r = await link.fetch('https://example.com/api', { method: 'POST', body: '{}' }, true);
    expect(r).toEqual({ status: 200, headers: { a: 'b' }, body: '{"x":1}' });
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
    const link = new ShellLink(fetchImpl as any);
    expect((await link.fetch('https://example.com/a', {}, false)).body).toBe('there');
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b']);
    await expect(link.fetch('https://example.com/local', {}, false)).rejects.toThrow('local address');
    await expect(link.fetch('https://example.com/loop', {}, false)).rejects.toThrow('redirects');
    await expect(link.fetch('http://127.0.0.1:3210/api/config', {}, false)).rejects.toThrow('local address');
    expect((await link.fetch('https://example.com/big', {}, false)).body.length).toBe(4 * 1024 * 1024);
  });
  it('a shell that stops answering is treated as gone for status, and fetch falls back to plain', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('http://127.0.0.1:')) throw new Error('ECONNREFUSED');
      return new Response('plain', { status: 200 });
    });
    const link = new ShellLink(fetchImpl as any);
    link.hello(45678, 'tok');
    expect(await link.signedIn(['https://example.com'])).toEqual([]);
    await expect(link.fetch('https://example.com/api', {}, true)).rejects.toThrow('shell');
  });
});
