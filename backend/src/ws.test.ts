import { describe, it, expect } from 'vitest';
import { allowLocalOrigin, isLoopbackHost } from './ws.js';

const origin = (o?: string) => ({ headers: o === undefined ? {} : { origin: o } });

describe('allowLocalOrigin', () => {
  it('allows a client that sends no origin (curl, Electron, a script)', () => {
    expect(allowLocalOrigin(origin())).toBe(true);
  });

  it('allows the dev server and the packaged app', () => {
    expect(allowLocalOrigin(origin('http://localhost:5173'))).toBe(true);
    expect(allowLocalOrigin(origin('http://127.0.0.1:3210'))).toBe(true);
    expect(allowLocalOrigin(origin('http://[::1]:3210'))).toBe(true);
    expect(allowLocalOrigin(origin('file://'))).toBe(true);
    expect(allowLocalOrigin(origin('null'))).toBe(true); // a file: page
  });

  it('refuses a page on the open web, and anything unparseable', () => {
    expect(allowLocalOrigin(origin('https://evil.example'))).toBe(false);
    expect(allowLocalOrigin(origin('http://localhost.evil.example'))).toBe(false);
    expect(allowLocalOrigin(origin('http://127.0.0.1.evil.example'))).toBe(false);
    expect(allowLocalOrigin(origin('not an origin'))).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('accepts only this machine', () => {
    expect(isLoopbackHost('127.0.0.1:3210')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]:3210')).toBe(true);
    expect(isLoopbackHost('evil.example')).toBe(false);
    expect(isLoopbackHost('192.168.1.20:3210')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});
