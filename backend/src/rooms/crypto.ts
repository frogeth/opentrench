import crypto from 'node:crypto';

/**
 * Room crypto and invites (spec §1 and §3).
 *
 * A room is a 32-byte key. Whoever has the key is in; the relay only ever learns the room id,
 * which is SHA-256 of the key truncated to 16 bytes, so it cannot recover the key or read the
 * traffic. Every message is AES-256-GCM with the room id as AAD: an envelope replayed from one
 * room into another with the same key (a rotated invite shares no key, but a copied one might)
 * fails to authenticate instead of decrypting.
 *
 * Everything on the wire and in invites is base64url without padding so it survives URLs, chat
 * apps and copy/paste unchanged.
 */

const B64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function isRoomId(s: unknown): s is string {
  return typeof s === 'string' && B64URL_22.test(s);
}

export function isMemberId(s: unknown): s is string {
  return typeof s === 'string' && B64URL_22.test(s);
}

export function isRoomKey(s: unknown): s is string {
  return typeof s === 'string' && B64URL_43.test(s);
}

/** 32 random bytes, base64url: 43 chars, no padding. */
export function newRoomKey(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** The relay-facing name of a room: SHA-256 of the raw key bytes, first 16 bytes, base64url. */
export function roomIdOf(key: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64url')).digest();
  return digest.subarray(0, 16).toString('base64url');
}

/** A random 16-byte id the app generates once per install. Not a secret; names travel inside ciphertext. */
export function newMemberId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `wss://host[:port]` → `host[:port]`, the form an invite carries. Plain `ws://` is accepted only
 * for loopback hosts: a relay reached over the internet must be TLS or the ciphertext's metadata
 * (room id, member id, timing) leaks to anyone on the path. Throws a readable Error otherwise so
 * the UI can show it as-is.
 */
export function relayHostOf(relay: string): string {
  const s = relay.trim();
  if (!/^wss?:\/\//i.test(s)) throw new Error('relay must be a wss:// URL, like wss://relay.example.com');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    // The scheme is right, so what the URL parser choked on is the host part (`wss://` alone, a bad port).
    throw new Error('relay URL has no valid host');
  }
  if (!u.hostname) throw new Error('relay URL has no host');
  if (u.username || u.password) throw new Error('relay URL must not carry credentials');
  if (u.search || u.hash) throw new Error('relay URL must not carry a query or fragment');
  if (u.pathname !== '/' && u.pathname !== '') {
    throw new Error('relay URL must not carry a path; the app adds /v1 itself');
  }
  if (u.protocol === 'ws:' && !LOOPBACK.has(u.hostname)) {
    throw new Error('relay must be wss:// unless it is localhost');
  }
  // URL.host already drops a default port (443 for wss, 80 for ws), which is what invites want.
  return u.host;
}

/** `host[:port]` → `wss://host[:port]`; loopback hosts get `ws://` because a local relay has no TLS. */
export function relayUrlOf(host: string): string {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return (LOOPBACK.has(name) ? 'ws://' : 'wss://') + host;
}

export function encodeInvite({ relay, key }: { relay: string; key: string }): string {
  return `opentrench://room/${relayHostOf(relay)}/${key}`;
}

const INVITE = /^opentrench:\/\/room\/([^/]+)\/([A-Za-z0-9_-]{43})$/;

/**
 * Parses an invite pasted from anywhere. Undefined for anything malformed: the caller shows
 * "not an invite" rather than a stack trace, and a link from a chat is never trusted to throw.
 */
export function decodeInvite(s: string): { relay: string; key: string; id: string } | undefined {
  if (typeof s !== 'string') return undefined;
  const m = INVITE.exec(s.trim());
  if (!m) return undefined;
  const [, host, key] = m;
  let relay: string;
  try {
    // Round-tripping through relayHostOf validates the host the same way the create form does.
    relay = relayUrlOf(host);
    if (relayHostOf(relay) !== host) return undefined;
  } catch {
    return undefined;
  }
  return { relay, key, id: roomIdOf(key) };
}

/** JSON → base64url(nonce ‖ ciphertext ‖ tag) under AES-256-GCM with the room id as AAD. */
export function seal(key: string, id: string, plain: unknown): string {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), nonce);
  c.setAAD(Buffer.from(id, 'utf8'));
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url');
}

/** The inverse of seal. Undefined on any failure (bad base64, short body, wrong key or id, bad JSON); never throws. */
export function open(key: string, id: string, body: string): unknown | undefined {
  if (typeof body !== 'string' || typeof key !== 'string' || typeof id !== 'string') return undefined;
  try {
    const raw = Buffer.from(body, 'base64url');
    if (raw.length < NONCE_BYTES + TAG_BYTES) return undefined;
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), raw.subarray(0, NONCE_BYTES));
    d.setAAD(Buffer.from(id, 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([d.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return undefined;
  }
}
