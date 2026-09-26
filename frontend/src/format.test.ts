import { describe, expect, it } from 'vitest';
import { plainText } from './format';

describe('plainText', () => {
  it('keeps link words and drops markdown markers, for a notification body', () => {
    expect(plainText('✔️ **Buy Executed**\n\n[$CATTO](https://t.me/x?start=1) ⋅ `0xabc`\n[[cancel all]](https://t.me/y)')).toBe('✔️ Buy Executed\n$CATTO ⋅ 0xabc\n[cancel all]');
  });
});
