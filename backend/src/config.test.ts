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
    expect(sanitizeColumns([{ id: 'k', type: 'callers', width: 500.4, window: '7d', alert: { on: 1, sound: 'coin' } }, { id: 'w', type: 'calls', width: 10, window: 'x' }])).toEqual([
      { id: 'k', type: 'callers', title: 'Top Callers', chats: [], width: 500, window: '7d', alert: { on: true, sound: 'coin' } },
      { id: 'w', type: 'calls', title: 'Calls', chats: [] },
    ]);
    expect(sanitizeColumns([{ id: 'f', type: 'calls', filters: { chains: ['base', 7], mcMin: 5000, excludeBots: true, search: 'x', bad: { nested: 1 }, 'we ird': 1 } }])[0].filters).toEqual({
      chains: ['base', '7'],
      mcMin: 5000,
      excludeBots: true,
      search: 'x',
    });
  });
});
