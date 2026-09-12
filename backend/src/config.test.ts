import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_COLUMNS, sanitizeColumns } from './config.js';

describe('columns', () => {
  it('falls back to All Calls + All Chats and drops junk', () => {
    expect(sanitizeColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([])).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([{ id: 'a', type: 'calls', title: ' Alpha ', chats: ['discord:1', 'nope', 7] }, { id: 'a', type: 'chat' }, { id: '', type: 'chat' }, 'x'])).toEqual([
      { id: 'a', type: 'calls', title: 'Alpha', chats: ['discord:1'] },
    ]);
    expect(sanitizeColumns([{ id: 'n', type: 'chat', chats: ['none'] }])).toEqual([{ id: 'n', type: 'chat', title: 'Chats', chats: ['none'] },
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

describe('nft column types', () => {
  it('accepts the three new types with their options', () => {
    const cols = sanitizeColumns([
      { id: 'a', type: 'mints', title: '', chats: [], filters: { chains: ['ethereum', 'bogus'], minQty: 2 } },
      { id: 'b', type: 'nftvol', title: '', chats: [], ranking: 'top', timeframe: '1d' },
      { id: 'c', type: 'osmint', title: '', chats: [] },
    ]);
    expect(cols.map((c) => c.type)).toEqual(['mints', 'nftvol', 'osmint']);
    expect(cols.map((c) => c.title)).toEqual(['MintGo', 'OpenSea Volume', 'OpenSea Mint']);
    expect(cols[0].filters).toEqual({ chains: ['ethereum'], minQty: 2 });
    expect(cols[1].ranking).toBe('top');
    expect(cols[1].timeframe).toBe('1d');
  });
  it('defaults a volume column to trending · 1h', () => {
    const [c] = sanitizeColumns([{ id: 'b', type: 'nftvol', title: 'V', chats: [], ranking: 'nope', timeframe: '7d' }]);
    expect(c.ranking).toBe('trending');
    expect(c.timeframe).toBe('1h');
  });
  it('drops a non-array chains filter and rounds minQty into range', () => {
    const [c] = sanitizeColumns([{ id: 'a', type: 'mints', title: '', chats: [], filters: { chains: 'ethereum', minQty: 2.6 } }]);
    expect(c.filters).toEqual({ minQty: 3 });
  });
});

describe('ConfigStore opensea block', () => {
  const tmp = () => path.join(os.tmpdir(), `trenchfeed-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  it('loads the wallet key and valid RPCs, and never masks the key into the UI', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ opensea: { walletKey: '0x' + 'a'.repeat(64), rpc: { ethereum: 'https://e.io', b3: 'https://b3.io', bad: 'ftp://x', 'Bad Key': 'https://y' } } }));
    const s = new ConfigStore(f);
    expect(s.get().opensea.walletKey).toBe('0x' + 'a'.repeat(64));
    expect(s.get().opensea.rpc).toEqual({ ethereum: 'https://e.io', b3: 'https://b3.io' });
    expect(JSON.stringify(s.masked())).not.toContain('aaaa');
    expect((s.masked() as any).opensea).toEqual({ hasWallet: true, rpc: { ethereum: 'https://e.io', b3: 'https://b3.io' } });
    fs.unlinkSync(f);
  });
  it('drops an invalid wallet key and loads an old config without opensea', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ discord: { watch: [] }, telegram: { watch: [] }, columns: [{ id: 'calls', type: 'calls', title: 'All Calls', chats: [] }] }));
    const s = new ConfigStore(f);
    expect(s.get().opensea).toEqual({ rpc: {} });
    expect(s.get().columns[0].type).toBe('calls');
    fs.writeFileSync(f, JSON.stringify({ opensea: { walletKey: '0Xdeadbeef', rpc: {} } }));
    expect(new ConfigStore(f).get().opensea.walletKey).toBeUndefined();
    fs.unlinkSync(f);
  });
});
