import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeInvite,
  encodeInvite,
  isMemberId,
  isRoomId,
  isRoomKey,
  newMemberId,
  newRoomKey,
  open,
  relayHostOf,
  relayUrlOf,
  roomIdOf,
  seal,
} from './crypto.js';

const B64URL = /^[A-Za-z0-9_-]+$/;

describe('keys and ids', () => {
  it('newRoomKey is 43 chars of base64url with no padding', () => {
    const key = newRoomKey();
    expect(key).toHaveLength(43);
    expect(key).toMatch(B64URL);
    expect(isRoomKey(key)).toBe(true);
    expect(newRoomKey()).not.toBe(key);
  });
  it('roomIdOf is 22 chars and stable for the same key', () => {
    const key = newRoomKey();
    const id = roomIdOf(key);
    expect(id).toHaveLength(22);
    expect(id).toMatch(B64URL);
    expect(roomIdOf(key)).toBe(id);
    expect(isRoomId(id)).toBe(true);
  });
  it('two random keys give different ids', () => {
    expect(roomIdOf(newRoomKey())).not.toBe(roomIdOf(newRoomKey()));
  });
  it('newMemberId is 22 chars of base64url', () => {
    const m = newMemberId();
    expect(m).toHaveLength(22);
    expect(m).toMatch(B64URL);
    expect(isMemberId(m)).toBe(true);
    expect(newMemberId()).not.toBe(m);
  });
  it('validators reject the wrong length or alphabet', () => {
    expect(isRoomId('a'.repeat(21))).toBe(false);
    expect(isRoomId('a'.repeat(23))).toBe(false);
    expect(isRoomId('a'.repeat(21) + '=')).toBe(false);
    expect(isRoomId('a'.repeat(21) + '+')).toBe(false);
    expect(isMemberId('a'.repeat(22))).toBe(true);
    expect(isMemberId(undefined)).toBe(false);
    expect(isMemberId(22)).toBe(false);
    expect(isRoomKey('a'.repeat(42))).toBe(false);
    expect(isRoomKey('a'.repeat(43))).toBe(true);
    expect(isRoomKey('a'.repeat(43) + '=')).toBe(false);
    expect(isRoomKey(null)).toBe(false);
  });
});

describe('relay host and url', () => {
  it('relayHostOf turns a wss/ws url into the invite host form', () => {
    expect(relayHostOf('wss://relay.example.com')).toBe('relay.example.com');
    expect(relayHostOf('wss://relay.example.com/')).toBe('relay.example.com');
    expect(relayHostOf('wss://relay.example.com:8443')).toBe('relay.example.com:8443');
    expect(relayHostOf('ws://localhost:8090')).toBe('localhost:8090');
    expect(relayHostOf('ws://127.0.0.1:8090')).toBe('127.0.0.1:8090');
    expect(relayHostOf('  wss://relay.example.com  ')).toBe('relay.example.com');
  });
  it('relayHostOf throws a readable error for anything else', () => {
    expect(() => relayHostOf('http://x')).toThrow(/wss:\/\//);
    expect(() => relayHostOf('wss://x/path')).toThrow(/path/);
    expect(() => relayHostOf('wss://')).toThrow(/host/);
    expect(() => relayHostOf('')).toThrow();
    expect(() => relayHostOf('relay.example.com')).toThrow(/wss:\/\//);
    expect(() => relayHostOf('wss://x?y=1')).toThrow();
    expect(() => relayHostOf('wss://user:pw@x')).toThrow();
  });
  it('relayUrlOf is the inverse, with loopback hosts on plain ws', () => {
    expect(relayUrlOf('relay.example.com')).toBe('wss://relay.example.com');
    expect(relayUrlOf('relay.example.com:8443')).toBe('wss://relay.example.com:8443');
    expect(relayUrlOf('localhost')).toBe('ws://localhost');
    expect(relayUrlOf('localhost:8090')).toBe('ws://localhost:8090');
    expect(relayUrlOf('127.0.0.1:8090')).toBe('ws://127.0.0.1:8090');
    expect(relayUrlOf('[::1]:8090')).toBe('ws://[::1]:8090');
  });
});

describe('invites', () => {
  const key = newRoomKey();
  it.each([
    ['wss://relay.example.com', 'relay.example.com'],
    ['wss://relay.example.com:8443', 'relay.example.com:8443'],
    ['ws://localhost:8090', 'localhost:8090'],
    ['ws://127.0.0.1:8090', '127.0.0.1:8090'],
  ])('round-trips %s', (relay, host) => {
    const invite = encodeInvite({ relay, key });
    expect(invite).toBe(`opentrench://room/${host}/${key}`);
    expect(decodeInvite(invite)).toEqual({ relay, key, id: roomIdOf(key) });
  });
  it('tolerates surrounding whitespace', () => {
    const invite = encodeInvite({ relay: 'wss://relay.example.com', key });
    expect(decodeInvite(`  \n${invite}\t `)).toEqual({ relay: 'wss://relay.example.com', key, id: roomIdOf(key) });
  });
  it('rejects malformed invites without throwing', () => {
    expect(decodeInvite(`https://room/relay.example.com/${key}`)).toBeUndefined(); // wrong scheme
    expect(decodeInvite(`opentrench://rooms/relay.example.com/${key}`)).toBeUndefined(); // wrong kind
    expect(decodeInvite('opentrench://room/relay.example.com')).toBeUndefined(); // missing key
    expect(decodeInvite('opentrench://room/relay.example.com/')).toBeUndefined(); // empty key
    expect(decodeInvite(`opentrench://room/relay.example.com/${key.slice(0, 42)}`)).toBeUndefined(); // short key
    expect(decodeInvite(`opentrench://room/relay.example.com/${key.slice(0, 42)}=`)).toBeUndefined(); // padding
    expect(decodeInvite(`opentrench://room/relay.example.com/${key}/extra`)).toBeUndefined(); // extra segment
    expect(decodeInvite(`opentrench://room/http://relay.example.com/${key}`)).toBeUndefined(); // scheme inside
    expect(decodeInvite(`opentrench://room//${key}`)).toBeUndefined(); // no host
    expect(decodeInvite('')).toBeUndefined();
    expect(decodeInvite('not an invite')).toBeUndefined();
  });
});

describe('envelopes', () => {
  const key = newRoomKey();
  const id = roomIdOf(key);
  const plain = { k: 'token', name: 'Zoë 🐸', token: { symbol: 'ÜBER', n: 1.5, nested: [1, 'два', null] } };

  it('round-trips an object with unicode', () => {
    const body = seal(key, id, plain);
    expect(body).toMatch(B64URL);
    expect(open(key, id, body)).toEqual(plain);
  });
  it('uses a fresh nonce for every seal', () => {
    const a = seal(key, id, plain);
    const b = seal(key, id, plain);
    expect(a).not.toBe(b);
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16)); // the first 12 bytes are the nonce
    expect(open(key, id, a)).toEqual(plain);
    expect(open(key, id, b)).toEqual(plain);
  });
  it('rejects a tampered ciphertext byte', () => {
    const body = seal(key, id, plain);
    const raw = Buffer.from(body, 'base64url');
    raw[20] ^= 0x01; // inside the ciphertext, past the 12-byte nonce
    expect(open(key, id, raw.toString('base64url'))).toBeUndefined();
  });
  it('rejects the wrong room id (AAD)', () => {
    const body = seal(key, id, plain);
    expect(open(key, roomIdOf(newRoomKey()), body)).toBeUndefined();
  });
  it('rejects the wrong key', () => {
    const body = seal(key, id, plain);
    expect(open(newRoomKey(), id, body)).toBeUndefined();
  });
  it('rejects a truncated body', () => {
    const body = seal(key, id, plain);
    expect(open(key, id, body.slice(0, -2))).toBeUndefined();
    expect(open(key, id, body.slice(0, 10))).toBeUndefined();
    expect(open(key, id, '')).toBeUndefined();
  });
  it('rejects junk without throwing', () => {
    expect(open(key, id, '***not base64***')).toBeUndefined();
    expect(open('short-key', id, seal(key, id, plain))).toBeUndefined();
    expect(open(key, id, 12 as unknown as string)).toBeUndefined();
  });
  it('rejects a body that authenticates but is not JSON', () => {
    // Build a valid envelope around non-JSON by hand: same layout, same key, same AAD.
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), nonce);
    c.setAAD(Buffer.from(id, 'utf8'));
    const ct = Buffer.concat([c.update('not json', 'utf8'), c.final()]);
    const body = Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url');
    expect(open(key, id, body)).toBeUndefined();
  });
});
