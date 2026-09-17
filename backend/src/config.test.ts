import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_COLUMNS, sanitizeColumns, sanitizeLayouts } from './config.js';
import { SecretBox, isSealed } from './secrets.js';

describe('columns', () => {
  it('falls back to All Calls + All Chats and drops junk', () => {
    expect(sanitizeColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([])).toEqual([]); // an emptied terminal stays empty; only a missing/invalid list gets the defaults
    expect(sanitizeColumns('junk')).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns([{ id: 'a', type: 'calls', title: ' Alpha ', chats: ['discord:1', 'nope', 7] }, { id: 'a', type: 'chat' }, { id: '', type: 'chat' }, 'x'])).toEqual([
      { id: 'a', type: 'calls', title: 'Alpha', chats: ['discord:1'] },
    ]);
    expect(sanitizeColumns([{ id: 'n', type: 'chat', chats: ['none'] }])).toEqual([{ id: 'n', type: 'chat', title: 'Chats', chats: ['none'] },
    ]);
    expect(sanitizeColumns([{ id: 'c', type: 'weird' }])).toEqual([{ id: 'c', type: 'chat', title: 'Chats', chats: [] }]);
    expect(sanitizeColumns([{ id: 't', type: 'trending', window: '5m' }, { id: 'u', type: 'trending', window: 'never' }])).toEqual([
      { id: 't', type: 'trending', title: 'Trending', chats: [], window: '5m' },
      { id: 'u', type: 'trending', title: 'Trending', chats: [] },
    ]);
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
    expect(cols.map((c) => c.title)).toEqual(['MintGo', 'NFT Volume', 'NFT Mint']);
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
  it('strips minQty and chains from a column type that does not use them', () => {
    const [c] = sanitizeColumns([{ id: 'a', type: 'nftvol', title: '', chats: [], filters: { chains: ['ethereum'], minQty: 2 } }]);
    expect(c.filters).toBeUndefined();
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
  it('keeps an http override only for localhost/loopback, drops it for anything else', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ opensea: { rpc: { evil: 'http://evil.example/rpc', local: 'http://127.0.0.1:8545', secure: 'https://e.io' } } }));
    const s = new ConfigStore(f);
    expect(s.get().opensea.rpc).toEqual({ local: 'http://127.0.0.1:8545', secure: 'https://e.io' });
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

describe('sanitizeLayouts', () => {
  it('keeps named layouts with sanitized columns and drops the rest', () => {
    const out = sanitizeLayouts([
      { id: 'a', name: ' Trading ', columns: [{ id: 'x', type: 'mints', title: '', chats: [] }] },
      { id: 'a', name: 'dup id', columns: [] },
      { id: '', name: 'no id', columns: [] },
      { id: 'b', name: '', columns: [] },
      'junk',
    ]);
    expect(out.map((l) => [l.id, l.name])).toEqual([['a', 'Trading']]);
    expect(out[0].columns.map((c) => c.type)).toEqual(['mints']);
    expect(sanitizeLayouts(undefined)).toEqual([]);
  });
});

describe('column zoom', () => {
  it('keeps a zoom inside 50–150% rounded to a percent, and drops 100% or junk', () => {
    const z = (zoom: unknown) => sanitizeColumns([{ id: 'a', type: 'chat', title: 'x', chats: [], zoom }])[0].zoom;
    expect(z(0.7)).toBe(0.7);
    expect(z(0.7049)).toBe(0.7);
    expect(z(1)).toBeUndefined();
    expect(z(0.2)).toBeUndefined();
    expect(z(3)).toBeUndefined();
    expect(z('big')).toBeUndefined();
  });
});

describe('tgbot columns', () => {
  it('keeps a valid bot username without its @ and drops a bad one', () => {
    const [a, b, c] = sanitizeColumns([
      { id: 'a', type: 'tgbot', title: 'Cielo', bot: '@evmtrackerbot' },
      { id: 'b', type: 'tgbot', bot: 'no spaces here' },
      { id: 'c', type: 'chat', bot: 'evmtrackerbot' },
    ]);
    expect(a).toMatchObject({ type: 'tgbot', title: 'Cielo', bot: 'evmtrackerbot' });
    expect(b).toMatchObject({ type: 'tgbot', title: 'Telegram bot' });
    expect(b.bot).toBeUndefined();
    expect(c.bot).toBeUndefined();
  });
});

describe('secrets at rest', () => {
  const KEY = Buffer.alloc(32, 7);
  const SECRETS = { discord: { token: 'dtok' }, telegram: { apiId: 1, apiHash: 'hash', session: 'sess' }, o1ApiKey: 'o1_launch_x', j7: { token: 'j7' }, opensea: { walletKey: '0x' + 'ab'.repeat(32) } };
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cfg-')), 'config.json');

  it('seals every token on save and opens them on load', () => {
    const file = tmpFile();
    const a = new ConfigStore(file, new SecretBox(KEY));
    a.update((c) => {
      c.discord.token = 'dtok';
      c.telegram.apiHash = 'hash';
      c.telegram.session = 'sess';
      c.o1ApiKey = 'o1_launch_x';
      c.j7.token = 'j7';
      c.opensea.walletKey = SECRETS.opensea.walletKey;
    });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const v of [disk.discord.token, disk.telegram.apiHash, disk.telegram.session, disk.o1ApiKey, disk.j7.token, disk.opensea.walletKey]) {
      expect(isSealed(v)).toBe(true);
    }
    expect(fs.readFileSync(file, 'utf8')).not.toContain('dtok');
    const b = new ConfigStore(file, new SecretBox(KEY)).get();
    expect(b.discord.token).toBe('dtok');
    expect(b.telegram).toMatchObject({ apiHash: 'hash', session: 'sess' });
    expect(b.o1ApiKey).toBe('o1_launch_x');
    expect(b.j7.token).toBe('j7');
    expect(b.opensea.walletKey).toBe(SECRETS.opensea.walletKey);
  });

  it('migrates a plain-text file the moment a key is available', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(SECRETS));
    const store = new ConfigStore(file, new SecretBox(KEY));
    expect(store.get().discord.token).toBe('dtok');
    const disk = fs.readFileSync(file, 'utf8');
    expect(disk).not.toContain('dtok');
    expect(disk).not.toContain('"sess"');
    expect(disk).toContain('enc:v1:');
  });

  it('without a key keeps sealed values it cannot open, and other edits do not lose them', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => {
      c.discord.token = 'dtok';
      c.telegram.session = 'sess';
    });
    const plain = new ConfigStore(file, new SecretBox());
    expect(plain.get().discord.token).toBeUndefined();
    expect(plain.masked().discord.hasToken).toBe(false);
    expect(plain.masked().telegram.hasSession).toBe(false);
    plain.update((c) => c.favorites.push('someone'));
    const again = new ConfigStore(file, new SecretBox(KEY)).get();
    expect(again.discord.token).toBe('dtok');
    expect(again.telegram.session).toBe('sess');
    expect(again.favorites).toEqual(['someone']);
  });

  it('a new value set without a key replaces the sealed one', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => {
      c.discord.token = 'old';
    });
    new ConfigStore(file, new SecretBox()).update((c) => {
      c.discord.token = 'new';
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).discord.token).toBe('new');
    expect(new ConfigStore(file, new SecretBox(KEY)).get().discord.token).toBe('new');
  });

  it('keeps hidden call cards like seen ones, capped and stringly', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ hiddenTokens: ['0xa', 7, '0xb'] }));
    const store = new ConfigStore(file);
    expect(store.get().hiddenTokens).toEqual(['0xa', '7', '0xb']);
    expect(store.masked().hiddenTokens).toEqual(['0xa', '7', '0xb']);
    expect(new ConfigStore(tmpFile()).get().hiddenTokens).toEqual([]);
  });

  it('a plain-text file without a key still works as before', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(SECRETS));
    const store = new ConfigStore(file);
    expect(store.get().discord.token).toBe('dtok');
    store.update((c) => (c.o1ApiKey = 'o1_launch_y'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).o1ApiKey).toBe('o1_launch_y');
  });
});
