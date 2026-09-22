import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * A backend started without a key from the desktop app (`npm start`, a dev checkout the app
 * attaches to) must not leave wallet keys and sessions in plain text either. It keeps its own
 * random 32-byte key in the OS keychain:
 *   macOS    the login keychain, through the `security` tool
 *   Linux    the Secret Service (GNOME Keyring, KWallet) through `secret-tool`, when installed
 *   Windows  DPAPI (CurrentUser scope) through PowerShell, the protected blob in a file next to config
 * Nowhere to keep one → undefined, and the caller warns that secrets stay plain text.
 */
const SERVICE = 'opentrench backend';
const ACCOUNT = 'opentrench';
const HEX = /^[0-9a-f]{64}$/i;

export type Runner = (cmd: string, args: string[], input?: string) => string;
const run: Runner = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 15_000 });

export function keychainKey(opts: { platform?: NodeJS.Platform; run?: Runner; blobFile?: string } = {}): Buffer | undefined {
  const platform = opts.platform ?? process.platform;
  const r = opts.run ?? run;
  try {
    if (platform === 'darwin') return macKey(r);
    if (platform === 'linux') return linuxKey(r);
    if (platform === 'win32' && opts.blobFile) return windowsKey(r, opts.blobFile);
  } catch (e) {
    console.warn('[secrets] OS keychain unavailable:', (e as Error).message.split('\n')[0]);
  }
  return undefined;
}

const fresh = () => crypto.randomBytes(32).toString('hex');
const parse = (hex: string): Buffer | undefined => (HEX.test(hex.trim()) ? Buffer.from(hex.trim(), 'hex') : undefined);

/** `security` exit codes: errSecItemNotFound and errSecDuplicateItem; the message is the fallback for a runner without a status */
const notFound = (e: unknown): boolean => (e as { status?: number })?.status === 44 || /could not be found/i.test(String((e as Error)?.message));
const duplicate = (e: unknown): boolean => (e as { status?: number })?.status === 45 || /already exists/i.test(String((e as Error)?.message));

function macKey(r: Runner): Buffer | undefined {
  const find = () => parse(r('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']));
  try {
    const got = find();
    if (got) return got;
    // something is there but it is not a key of ours: leave it be rather than replace it
    throw new Error('the keychain item is not a 32-byte hex key');
  } catch (e) {
    // Only "not found" means there is nothing to read yet. Anything else (a locked keychain, a denied
    // or timed-out prompt, a sandbox) must never end in a fresh key: every sealed secret depends on
    // the one that is there, and replacing it would orphan them all for good.
    if (!notFound(e)) throw e;
  }
  const hex = fresh();
  try {
    // no -U: an item that appeared between the lookup and now (two backends racing) is kept, and read below
    r('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-l', SERVICE, '-w', hex]);
  } catch (e) {
    if (!duplicate(e)) throw e;
  }
  return find();
}

function linuxKey(r: Runner): Buffer | undefined {
  try {
    const got = parse(r('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]));
    if (got) return got;
  } catch (e) {
    if (/ENOENT/.test(String((e as Error).message))) return undefined; // no secret-tool: nothing to keep a key in
  }
  const hex = fresh();
  r('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', ACCOUNT], hex);
  return parse(r('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]));
}

function windowsKey(r: Runner, blobFile: string): Buffer | undefined {
  const ps = (script: string) => r('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]).trim();
  if (fs.existsSync(blobFile)) {
    const blob = fs.readFileSync(blobFile, 'utf8').trim();
    if (/^[A-Za-z0-9+/=]+$/.test(blob)) {
      const hex = ps(`Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`);
      const got = parse(hex);
      if (got) return got;
    }
  }
  const hex = fresh();
  const blob = ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('${hex}'), $null, 'CurrentUser'))`);
  if (!/^[A-Za-z0-9+/=]+$/.test(blob)) throw new Error('DPAPI returned nothing usable');
  fs.writeFileSync(blobFile, blob + '\n', { mode: 0o600 });
  return Buffer.from(hex, 'hex');
}
