import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Secrets at rest. The desktop app keeps a random 32-byte key in the OS keychain (Electron's
 * safeStorage) and hands it to the backend on stdin; the backend seals every token, session and
 * wallet key in config.json with it (AES-256-GCM). A backend started without a key — `npm start`
 * from the repo — reads and writes plain text as before, and leaves sealed values it cannot open
 * untouched on disk so the desktop app still finds them.
 *
 * Wire format: `enc:v1:` + base64(iv[12] ‖ tag[16] ‖ ciphertext).
 */
const PREFIX = 'enc:v1:';

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export class SecretBox {
  constructor(private readonly key?: Buffer) {
    if (key && key.length !== 32) throw new Error('secret key must be 32 bytes');
  }

  get hasKey(): boolean {
    return !!this.key;
  }

  seal(plain: string): string {
    if (!this.key) return plain;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  /** The plain text, or undefined when the value is sealed and this box cannot open it (no key, wrong key, tampered). */
  open(v: string): string | undefined {
    if (!isSealed(v)) return v;
    if (!this.key) return undefined;
    try {
      const buf = Buffer.from(v.slice(PREFIX.length), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }
}

/**
 * The key the desktop app passes in: 64 hex chars in TRENCHFEED_SECRET_KEY, or on stdin when
 * TRENCHFEED_SECRET_KEY_STDIN=1 (stdin, unlike the environment, is not readable by other
 * processes of the same user). Missing or malformed → undefined, and secrets stay plain text.
 */
export function readSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  let hex = env.TRENCHFEED_SECRET_KEY;
  if (!hex && env.TRENCHFEED_SECRET_KEY_STDIN === '1') {
    try {
      hex = readStdin();
    } catch (e) {
      console.warn('[secrets] could not read the key from stdin:', (e as Error).message);
    }
  }
  if (!hex) return undefined;
  hex = hex.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    console.warn('[secrets] ignoring malformed secret key (expected 64 hex chars)');
    return undefined;
  }
  return Buffer.from(hex, 'hex');
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(4096);
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    if (chunks.reduce((a, c) => a + c.length, 0) > 1024) break; // a key is 64 chars; never slurp more
  }
  return Buffer.concat(chunks).toString('utf8');
}
