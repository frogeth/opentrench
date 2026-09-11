import { describe, it, expect } from 'vitest';
import { canonicalChatId, isWatched, sameChat } from './ids.js';

describe('telegram chat ids', () => {
  it('folds a supergroup/channel across its marked and bare forms', () => {
    expect(canonicalChatId('-1001234567890')).toBe('1234567890');
    expect(canonicalChatId('1234567890')).toBe('1234567890');
    expect(sameChat('-1001234567890', '1234567890')).toBe(true);
    expect(sameChat('-1001234567890', '-1009999999999')).toBe(false);
  });
  it('does NOT treat a short basic-group id that happens to start with -100 as a channel', () => {
    // -1001 is basic group 1001, not channel 1
    expect(canonicalChatId('-1001')).toBe('1001');
    expect(canonicalChatId('1001')).toBe('1001');
    expect(sameChat('-1001', '1001')).toBe(true);
    expect(sameChat('-1001', '1')).toBe(false);
    expect(canonicalChatId('-987654')).toBe('987654');
    expect(sameChat('', '')).toBe(false);
  });
  it('matches the watch list regardless of shape', () => {
    const watch = ['-1001234567890', '-1001', '-555'];
    expect(isWatched(watch, '1234567890')).toBe(true);   // channel arrived bare
    expect(isWatched(watch, '-1001234567890')).toBe(true);
    expect(isWatched(watch, '1001')).toBe(true);         // basic group arrived bare
    expect(isWatched(watch, '555')).toBe(true);
    expect(isWatched(watch, '-1007777777777')).toBe(false);
    expect(isWatched(watch, undefined)).toBe(false);
  });
});
