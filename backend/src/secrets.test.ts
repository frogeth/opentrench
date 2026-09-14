import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, isSealed, readSecretKey } from './secrets.js';

const KEY = crypto.randomBytes(32);

describe('SecretBox', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const box = new SecretBox(KEY);
    const a = box.seal('hunter2');
    const b = box.seal('hunter2');
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe('hunter2');
    expect(box.open(b)).toBe('hunter2');
  });
  it('passes plain text through, and refuses sealed values it cannot open', () => {
    const box = new SecretBox(KEY);
    expect(box.open('plain')).toBe('plain');
    const sealed = box.seal('x');
    expect(new SecretBox(crypto.randomBytes(32)).open(sealed)).toBeUndefined();
    expect(new SecretBox().open(sealed)).toBeUndefined();
    expect(box.open(sealed.slice(0, -4) + 'AAAA')).toBeUndefined(); // tampered
  });
  it('without a key seals to plain text', () => {
    const box = new SecretBox();
    expect(box.hasKey).toBe(false);
    expect(box.seal('x')).toBe('x');
  });
  it('rejects a wrong-sized key', () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('readSecretKey', () => {
  it('takes 64 hex chars from the environment and ignores junk', () => {
    expect(readSecretKey({ TRENCHFEED_SECRET_KEY: KEY.toString('hex') })).toEqual(KEY);
    expect(readSecretKey({ TRENCHFEED_SECRET_KEY: ' ' + KEY.toString('hex') + '\n' })).toEqual(KEY);
    expect(readSecretKey({ TRENCHFEED_SECRET_KEY: 'nope' })).toBeUndefined();
    expect(readSecretKey({})).toBeUndefined();
  });
});
