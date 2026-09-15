import { describe, expect, it } from 'vitest';
import { entitiesToDiscord } from './normalize.js';

const ent = (className: string, offset: number, length: number, extra: Record<string, unknown> = {}) => ({ className, offset, length, ...extra });

describe('entitiesToDiscord', () => {
  it('bold, italic, code, strike, spoiler, underline', () => {
    const text = 'Salpha report on PEPE done';
    expect(entitiesToDiscord(text, [ent('MessageEntityBold', 0, 6), ent('MessageEntityItalic', 17, 4), ent('MessageEntityCode', 22, 4)])).toBe('**Salpha** report on *PEPE* `done`');
    expect(entitiesToDiscord('a b c', [ent('MessageEntityStrike', 0, 1), ent('MessageEntitySpoiler', 2, 1), ent('MessageEntityUnderline', 4, 1)])).toBe('~~a~~ ||b|| __c__');
  });
  it('text links become masked links that do not unfurl; a lone bare url keeps its preview', () => {
    expect(entitiesToDiscord('Chart here', [ent('MessageEntityTextUrl', 0, 5, { url: 'https://x.y/c' })])).toBe('[Chart](<https://x.y/c>) here');
    expect(entitiesToDiscord('https://x.y/c', [ent('MessageEntityTextUrl', 0, 13, { url: 'https://x.y/c' })])).toBe('<https://x.y/c>');
    expect(entitiesToDiscord('https://x.y/c', [ent('MessageEntityUrl', 0, 13)])).toBe('https://x.y/c');
    expect(entitiesToDiscord('a https://x.y/1 b https://x.y/2', [ent('MessageEntityUrl', 2, 13), ent('MessageEntityUrl', 18, 13)])).toBe('a <https://x.y/1> b <https://x.y/2>');
  });
  it('nests a link inside bold and marks every quoted line', () => {
    expect(entitiesToDiscord('Buy PEPE now', [ent('MessageEntityBold', 0, 12), ent('MessageEntityTextUrl', 4, 4, { url: 'https://p' })])).toBe('**Buy [PEPE](<https://p>) now**');
    expect(entitiesToDiscord('one\ntwo\nthree', [ent('MessageEntityBlockquote', 0, 7)])).toBe('> one\n> two\nthree');
    expect(entitiesToDiscord('x = 1', [ent('MessageEntityPre', 0, 5, { language: 'js' })])).toBe('```js\nx = 1\n```');
  });
  it('leaves text alone without entities or with bad offsets', () => {
    expect(entitiesToDiscord('plain', undefined)).toBe('plain');
    expect(entitiesToDiscord('plain', [ent('MessageEntityBold', 3, 9)])).toBe('plain');
  });
});
