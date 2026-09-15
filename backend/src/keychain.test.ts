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
    expect(calls[1]).toContain('-U');
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
