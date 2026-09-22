import { describe, expect, it } from 'vitest';
import { keychainKey, type Runner } from './keychain.js';

const HEX = 'ab'.repeat(32);

describe('keychainKey', () => {
  it('macOS: reads the existing item, or creates one and reads it back', () => {
    const calls: string[][] = [];
    const existing: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return HEX + '\n';
    };
    expect(keychainKey({ platform: 'darwin', run: existing })?.toString('hex')).toBe(HEX);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['security', 'find-generic-password', '-s', 'opentrench backend', '-a', 'opentrench', '-w']);
    let stored: string | undefined;
    const empty: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'find-generic-password') {
        if (!stored) throw new Error('The specified item could not be found in the keychain.');
        return stored + '\n';
      }
      stored = args[args.indexOf('-w') + 1];
      return '';
    };
    calls.length = 0;
    const key = keychainKey({ platform: 'darwin', run: empty });
    expect(key?.length).toBe(32);
    expect(key?.toString('hex')).toBe(stored);
    expect(calls.map((c) => c[1])).toEqual(['find-generic-password', 'add-generic-password', 'find-generic-password']);
    expect(calls[1]).not.toContain('-U'); // never an update: an item that exists is never replaced
  });
  it('macOS: a lookup that fails for any reason but "not found" never creates a key (the one there is what every secret is sealed with)', () => {
    for (const failure of [Object.assign(new Error('User interaction is not allowed.'), { status: 36 }), new Error('spawnSync security ETIMEDOUT'), Object.assign(new Error('The user name or passphrase you entered is not correct.'), { status: 51 })]) {
      const calls: string[][] = [];
      const locked: Runner = (cmd, args) => {
        calls.push([cmd, ...args]);
        throw failure;
      };
      expect(keychainKey({ platform: 'darwin', run: locked })).toBeUndefined();
      expect(calls.map((c) => c[1])).toEqual(['find-generic-password']);
    }
    // the exit code alone says "not found" too
    const calls: string[][] = [];
    let stored: string | undefined;
    const byStatus: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'find-generic-password') {
        if (!stored) throw Object.assign(new Error('security: SecKeychainSearchCopyNext: nope'), { status: 44 });
        return stored;
      }
      stored = args[args.indexOf('-w') + 1];
      return '';
    };
    expect(keychainKey({ platform: 'darwin', run: byStatus })?.toString('hex')).toBe(stored);
    expect(calls.map((c) => c[1])).toEqual(['find-generic-password', 'add-generic-password', 'find-generic-password']);
  });
  it('macOS: two backends racing agree on the key that landed first', () => {
    const theirs = 'cd'.repeat(32);
    let present = false;
    const race: Runner = (_c, args) => {
      if (args[0] === 'find-generic-password') {
        if (!present) throw Object.assign(new Error('not found'), { status: 44 });
        return theirs;
      }
      // the other backend added its item between our lookup and our add
      present = true;
      throw Object.assign(new Error('The specified item already exists in the keychain.'), { status: 45 });
    };
    expect(keychainKey({ platform: 'darwin', run: race })?.toString('hex')).toBe(theirs);
  });
  it('Linux: no secret-tool means no key; a present one stores through stdin', () => {
    const missing: Runner = () => {
      throw new Error('spawnSync secret-tool ENOENT');
    };
    expect(keychainKey({ platform: 'linux', run: missing })).toBeUndefined();
    let stored: string | undefined;
    const tool: Runner = (_c, args, input) => {
      if (args[0] === 'lookup') {
        if (!stored) throw new Error('exit 1');
        return stored;
      }
      stored = input;
      return '';
    };
    expect(keychainKey({ platform: 'linux', run: tool })?.toString('hex')).toBe(stored);
  });
  it('an unknown platform or a failing tool gives nothing, never throws', () => {
    expect(keychainKey({ platform: 'freebsd' as NodeJS.Platform })).toBeUndefined();
    const broken: Runner = () => {
      throw new Error('keychain locked');
    };
    expect(keychainKey({ platform: 'darwin', run: broken })).toBeUndefined();
  });
  it('a malformed item is not used as a key', () => {
    const junk: Runner = (_c, args) => (args[0] === 'find-generic-password' ? 'not-hex\n' : '');
    expect(keychainKey({ platform: 'darwin', run: junk })).toBeUndefined();
  });
});
