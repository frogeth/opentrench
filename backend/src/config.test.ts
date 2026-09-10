import { describe, expect, it } from 'vitest';
import { DEFAULT_COLUMNS, sanitizeColumns } from './config.js';

describe('columns', () => {
  it('falls back to All Calls + All Chats and drops junk', () => {
    expect(sanitizeColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([])).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([{ id: 'a', type: 'calls', title: ' Alpha ', chats: ['discord:1', 'nope', 7] }, { id: 'a', type: 'chat' }, { id: '', type: 'chat' }, 'x'])).toEqual([
      { id: 'a', type: 'calls', title: 'Alpha', chats: ['discord:1'] },
    ]);
    expect(sanitizeColumns([{ id: 'c', type: 'weird' }])).toEqual([{ id: 'c', type: 'chat', title: 'Chats', chats: [] }]);
  });
});
