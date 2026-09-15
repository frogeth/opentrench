import { describe, expect, it } from 'vitest';
import { buildOptions, signature, splitArgs } from './slash.js';

describe('slash arguments', () => {
  it('splits words and keeps quoted phrases', () => {
    expect(splitArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(splitArgs('')).toEqual([]);
  });
  it('maps positional values onto typed options and the last string takes the rest', () => {
    const opts = [
      { type: 4, name: 'count', required: true },
      { type: 3, name: 'text' },
    ];
    expect(buildOptions(opts, '3 hello there  friend')).toEqual([
      { type: 4, name: 'count', value: 3 },
      { type: 3, name: 'text', value: 'hello there  friend' },
    ]);
    expect(buildOptions(opts, '3')).toEqual([{ type: 4, name: 'count', value: 3 }]);
    expect(() => buildOptions(opts, '')).toThrow(/needs count/);
    expect(() => buildOptions(opts, 'x')).toThrow(/whole number/);
  });
  it('subcommands, choices, booleans, mentions', () => {
    const defs = [
      { type: 1, name: 'show', options: [{ type: 5, name: 'all' }] },
      { type: 1, name: 'set', options: [{ type: 3, name: 'mode', required: true, choices: [{ name: 'Fast', value: 'fast' }] }, { type: 6, name: 'who' }] },
    ];
    expect(buildOptions(defs, 'show yes')).toEqual([{ type: 1, name: 'show', options: [{ type: 5, name: 'all', value: true }] }]);
    expect(buildOptions(defs, 'set fast <@123456789012345678>')).toEqual([{ type: 1, name: 'set', options: [{ type: 3, name: 'mode', value: 'fast' }, { type: 6, name: 'who', value: '123456789012345678' }] }]);
    expect(() => buildOptions(defs, 'nope')).toThrow(/pick one: show, set/);
    expect(() => buildOptions(defs, 'set slow')).toThrow(/must be one of: Fast/);
  });
  it('refuses stray values and no options at all is fine', () => {
    expect(buildOptions([], '')).toEqual([]);
    expect(() => buildOptions([{ type: 4, name: 'n' }], '1 2')).toThrow(/too many/);
  });
  it('signature', () => {
    expect(signature({ name: 'ping' })).toBe('/ping');
    expect(signature({ name: 'x', options: [{ type: 3, name: 'q', required: true }, { type: 4, name: 'n' }] })).toBe('/x <q> [n]');
    expect(signature({ name: 'x', options: [{ type: 1, name: 'a' }, { type: 1, name: 'b' }] })).toBe('/x a | b');
  });
});
