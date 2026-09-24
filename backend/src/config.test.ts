import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, DEFAULT_COLUMNS, sanitizeColumns, sanitizeLayouts } from './config.js';
import { SecretBox, isSealed } from './secrets.js';
import { isMemberId, newRoomKey, roomIdOf } from './rooms/crypto.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cfg-')), 'config.json');

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
  });
  it('pins a Vampy column to its feed and keeps vampy chat keys on any column', () => {
    // the feed decides the chat list, whatever the client sent
    expect(sanitizeColumns([{ id: 'v', type: 'vampy', feed: '7c4e1f2a', chats: ['discord:1'], filters: { chains: ['solana'] } }])).toEqual([
      { id: 'v', type: 'vampy', title: 'Vampy', feed: '7c4e1f2a', chats: ['vampy:7c4e1f2a'], filters: { chains: ['solana'] } },
    ]);
    // a feed id that is not one leaves the column without a feed (the editor asks for one)
    expect(sanitizeColumns([{ id: 'v', type: 'vampy', feed: 'no way!', chats: ['vampy:x'] }])).toEqual([{ id: 'v', type: 'vampy', title: 'Vampy', chats: ['none'] }]);
    // a Vampy feed is a chat like any other in a Messages or Calls column
    expect(sanitizeColumns([{ id: 'c', type: 'calls', chats: ['vampy:7c4e1f2a', 'vampy:bad id', 'telegram:1'] }])[0].chats).toEqual(['vampy:7c4e1f2a', 'telegram:1']);
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
    expect(c.currency).toBe('native');
  });
  it('keeps a volume column in USD when asked, native for anything else', () => {
    const [a, b] = sanitizeColumns([
      { id: 'a', type: 'nftvol', title: 'V', chats: [], currency: 'usd' },
      { id: 'b', type: 'nftvol', title: 'V', chats: [], currency: 'eur' },
    ]);
    expect(a.currency).toBe('usd');
    expect(b.currency).toBe('native');
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
    // an old config's opensea.rpc folds into the one rpc table
    expect(s.get().rpc).toEqual({ ethereum: 'https://e.io', b3: 'https://b3.io' });
    expect(JSON.stringify(s.masked())).not.toContain('aaaa');
    expect((s.masked() as any).opensea).toEqual({ hasWallet: true });
    expect((s.masked() as any).rpc).toEqual({ ethereum: 'https://e.io', b3: 'https://b3.io' });
    fs.unlinkSync(f);
  });
  it('the one rpc table wins over the legacy opensea.rpc and marketData.rpc entries', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ opensea: { rpc: { ethereum: 'https://old.io', ink: 'https://ink.io' } }, marketData: { rpc: { base: 'https://md.io', ethereum: 'https://mid.io' } }, rpc: { ethereum: 'https://new.io' } }));
    const s = new ConfigStore(f);
    expect(s.get().rpc).toEqual({ ethereum: 'https://new.io', ink: 'https://ink.io', base: 'https://md.io' });
    fs.unlinkSync(f);
  });
  it('keeps an http override only for localhost/loopback, drops it for anything else', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ opensea: { rpc: { evil: 'http://evil.example/rpc', local: 'http://127.0.0.1:8545', secure: 'https://e.io' } } }));
    const s = new ConfigStore(f);
    expect(s.get().rpc).toEqual({ local: 'http://127.0.0.1:8545', secure: 'https://e.io' });
    fs.unlinkSync(f);
  });
  it('drops an invalid wallet key and loads an old config without opensea', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ discord: { watch: [] }, telegram: { watch: [] }, columns: [{ id: 'calls', type: 'calls', title: 'All Calls', chats: [] }] }));
    const s = new ConfigStore(f);
    expect(s.get().opensea).toEqual({});
    expect(s.get().rpc).toEqual({});
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
  const SECRETS = { discord: { token: 'dtok' }, telegram: { apiId: 1, apiHash: 'hash', session: 'sess' }, o1ApiKey: 'o1_launch_x', j7: { token: 'j7' }, vampy: { apiKey: 'vmp_abc' }, opensea: { walletKey: '0x' + 'ab'.repeat(32) } };
  it('seals every token on save and opens them on load', () => {
    const file = tmpFile();
    const a = new ConfigStore(file, new SecretBox(KEY));
    a.update((c) => {
      c.discord.token = 'dtok';
      c.telegram.apiHash = 'hash';
      c.telegram.session = 'sess';
      c.o1ApiKey = 'o1_launch_x';
      c.j7.token = 'j7';
      c.vampy.apiKey = 'vmp_abc';
      c.opensea.walletKey = SECRETS.opensea.walletKey;
    });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const v of [disk.discord.token, disk.telegram.apiHash, disk.telegram.session, disk.o1ApiKey, disk.j7.token, disk.vampy.apiKey, disk.opensea.walletKey]) {
      expect(isSealed(v)).toBe(true);
    }
    expect(fs.readFileSync(file, 'utf8')).not.toContain('dtok');
    const b = new ConfigStore(file, new SecretBox(KEY)).get();
    expect(b.discord.token).toBe('dtok');
    expect(b.telegram).toMatchObject({ apiHash: 'hash', session: 'sess' });
    expect(b.o1ApiKey).toBe('o1_launch_x');
    expect(b.j7.token).toBe('j7');
    expect(b.vampy.apiKey).toBe('vmp_abc');
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

describe('plugins config', () => {
  const HASH = 'a'.repeat(64);
  /** a ConfigStore loaded from a file holding exactly this JSON */
  const loaded = (raw: unknown) => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify(raw));
    return new ConfigStore(f).get();
  };

  it('keeps enabled/approvedHash per plugin, the plugin watch list, and a plugin column', () => {
    const cfg = loaded({
      plugins: { 'hello-feed': { enabled: true, approvedHash: HASH }, 'Bad Id': { enabled: true } },
      pluginWatch: ['plugin:hello-feed:alerts', 5],
      columns: [{ id: 'p1', type: 'plugin', title: 'Hello', chats: ['plugin:hello-feed:alerts', 'plugin:bad key', 'discord:1'], plugin: 'hello-feed' }],
    });
    expect(cfg.plugins).toEqual({ 'hello-feed': { enabled: true, approvedHash: HASH } });
    expect(cfg.pluginWatch).toEqual(['plugin:hello-feed:alerts']);
    expect(cfg.columns[0]).toMatchObject({ type: 'plugin', plugin: 'hello-feed', title: 'Hello' });
    expect(cfg.columns[0].chats).toEqual(['plugin:hello-feed:alerts', 'discord:1']);
  });

  it('defaults to no plugins and an empty watch list', () => {
    const cfg = loaded({ discord: { watch: [] } });
    expect(cfg.plugins).toEqual({});
    expect(cfg.pluginWatch).toEqual([]);
  });

  it('ignores a plugins block that is not an object', () => {
    expect(loaded({ plugins: 'abc' }).plugins).toEqual({});
    expect(loaded({ plugins: [{ enabled: true }] }).plugins).toEqual({});
  });

  it('drops an approvedHash that is not a sha-256', () => {
    expect(loaded({ plugins: { 'hello-feed': { enabled: true, approvedHash: 'abc' } } }).plugins).toEqual({ 'hello-feed': { enabled: true } });
  });

  it('drops a column plugin id that is not a plugin id', () => {
    const [col] = loaded({ columns: [{ id: 'p1', type: 'plugin', title: 'Hello', chats: [], plugin: 'Bad Id' }] }).columns;
    expect(col.plugin).toBeUndefined();
  });

  it('dedupes the watch list', () => {
    expect(loaded({ pluginWatch: ['plugin:hello-feed:alerts', 'plugin:hello-feed:alerts', 'plugin:hello-feed:news'] }).pluginWatch).toEqual([
      'plugin:hello-feed:alerts',
      'plugin:hello-feed:news',
    ]);
  });
});

describe('together rooms', () => {
  afterEach(() => vi.restoreAllMocks());
  const KEY = Buffer.alloc(32, 9);
  const key = newRoomKey();
  const id = roomIdOf(key);
  const room = { id, key, relay: 'wss://relay.example', name: 'degens', joinedAt: 1700000000000 };

  it('round-trips rooms with the key sealed on disk', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => {
      c.together.rooms.push({ ...room });
      c.together.relay = 'wss://mine.example';
    });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(key);
    const disk = JSON.parse(text);
    expect(disk.together.rooms).toHaveLength(1);
    expect(isSealed(disk.together.rooms[0].key)).toBe(true);
    expect(disk.together.rooms[0]).toMatchObject({ id, relay: 'wss://relay.example', name: 'degens', joinedAt: 1700000000000 });
    const again = new ConfigStore(file, new SecretBox(KEY)).get().together;
    expect(again.rooms).toEqual([room]);
    expect(again.relay).toBe('wss://mine.example');
  });

  it('an old config gets no rooms and a member id that survives a save', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ together: { share: true, name: 'me', token: 't', peers: [] } }));
    const a = new ConfigStore(file);
    expect(a.get().together.rooms).toEqual([]);
    expect(a.get().together.relay).toBe('');
    const mid = a.get().together.memberId;
    expect(isMemberId(mid)).toBe(true);
    a.update((c) => c.favorites.push('x'));
    expect(new ConfigStore(file).get().together.memberId).toBe(mid);
    // a fresh store (no file at all) also gets one
    expect(isMemberId(new ConfigStore(tmpFile()).get().together.memberId)).toBe(true);
  });

  it('replaces a junk member id', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ together: { memberId: 'short' } }));
    const mid = new ConfigStore(file).get().together.memberId;
    expect(mid).not.toBe('short');
    expect(isMemberId(mid)).toBe(true);
  });

  it('masked() shows rooms without their keys', () => {
    const file = tmpFile();
    const s = new ConfigStore(file, new SecretBox(KEY));
    s.update((c) => c.together.rooms.push({ ...room }));
    const m = s.masked().together;
    expect(m.rooms).toEqual([{ id, relay: 'wss://relay.example', name: 'degens', joinedAt: 1700000000000, hasAccess: false }]);
    expect(m.memberId).toBe(s.get().together.memberId);
    expect(m.relay).toBe('');
    expect(JSON.stringify(s.masked())).not.toContain(key);
  });

  it('keeps a relay access code with the room, trimmed and capped, and masks it to a boolean', () => {
    const file = tmpFile();
    const k2 = newRoomKey();
    const s = new ConfigStore(file, new SecretBox(KEY));
    s.update((c) => {
      c.together.rooms.push({ ...room, access: '  sesame  ' });
      c.together.rooms.push({ id: roomIdOf(k2), key: k2, relay: 'wss://b', name: 'open', joinedAt: 2 });
    });
    const again = new ConfigStore(file, new SecretBox(KEY));
    expect(again.get().together.rooms.map((r) => r.access)).toEqual(['sesame', undefined]);
    expect(again.masked().together.rooms.map((r) => r.hasAccess)).toEqual([true, false]);
    expect(JSON.stringify(again.masked())).not.toContain('sesame');
    // a hand-edited file: junk types are dropped, long codes cut, an empty one is no code at all
    fs.writeFileSync(
      file,
      JSON.stringify({
        together: {
          rooms: [
            { id, key, relay: 'wss://a', name: 'n', joinedAt: 1, access: 'x'.repeat(150) },
            { id: roomIdOf(k2), key: k2, relay: 'wss://b', name: 'n', joinedAt: 1, access: 42 },
          ],
        },
      }),
    );
    const t = new ConfigStore(file).get().together;
    expect(t.rooms[0].access).toBe('x'.repeat(100));
    expect('access' in t.rooms[1]).toBe(false);
  });

  it('a room sealed with another key stays on disk and out of get()', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => c.together.rooms.push({ ...room }));
    const other = new ConfigStore(file, new SecretBox(Buffer.alloc(32, 1)));
    expect(other.get().together.rooms).toEqual([]);
    expect(other.masked().together.rooms).toEqual([]);
    const key2 = newRoomKey();
    other.update((c) => c.together.rooms.push({ id: roomIdOf(key2), key: key2, relay: 'ws://localhost:8787', name: 'local', joinedAt: 1 }));
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(disk.together.rooms.map((r: any) => r.id).sort()).toEqual([id, roomIdOf(key2)].sort());
    const back = new ConfigStore(file, new SecretBox(KEY)).get().together.rooms;
    expect(back.map((r) => r.id)).toEqual([id]); // key2 was sealed with the other box's key
    expect(back[0].key).toBe(key);
  });

  it('drops rooms with a mismatched id, a bad relay or a bad key, dedupes ids, and defaults name/joinedAt', () => {
    const file = tmpFile();
    const k2 = newRoomKey();
    fs.writeFileSync(
      file,
      JSON.stringify({
        together: {
          relay: 'http://not-a-socket',
          rooms: [
            { id: roomIdOf(k2), key: key, relay: 'wss://a', name: 'wrong id', joinedAt: 1 },
            { id, key, relay: 'https://a', name: 'bad relay', joinedAt: 1 },
            { id, key, relay: 'wss://first', name: '  ', joinedAt: 'soon' },
            { id, key, relay: 'wss://second', name: 'dup', joinedAt: 2 },
            { id: roomIdOf(k2), key: 'nope', relay: 'wss://a', name: 'bad key', joinedAt: 1 },
            { id: roomIdOf(k2), key: k2, relay: 'ws://localhost:1', name: 'x'.repeat(60), joinedAt: 5 },
            'junk',
          ],
        },
      }),
    );
    const before = Date.now();
    const t = new ConfigStore(file).get().together;
    expect(t.relay).toBe('');
    expect(t.rooms.map((r) => [r.id, r.relay, r.name])).toEqual([
      [id, 'wss://first', 'room'],
      [roomIdOf(k2), 'ws://localhost:1', 'x'.repeat(40)],
    ]);
    expect(t.rooms[0].joinedAt).toBeGreaterThanOrEqual(before);
    expect(t.rooms[1].joinedAt).toBe(5);
  });

  it('caps the list at 50 rooms and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tmpFile();
    const rooms = Array.from({ length: 55 }, (_, i) => {
      const k = newRoomKey();
      return { id: roomIdOf(k), key: k, relay: 'wss://r', name: `r${i}`, joinedAt: i + 1 };
    });
    fs.writeFileSync(file, JSON.stringify({ together: { rooms } }));
    expect(new ConfigStore(file).get().together.rooms).toHaveLength(50);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('55 rooms'))).toHaveLength(1);
  });

  it('canonicalises relay URLs with the invite rule and drops what it rejects', () => {
    const file = tmpFile();
    const mk = (relay: string) => {
      const k = newRoomKey();
      return { id: roomIdOf(k), key: k, relay, name: relay, joinedAt: 1 };
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        together: {
          relay: 'WSS://Relay.Example:443/',
          rooms: [mk('ws://relay.example'), mk('wss://relay.example/v1'), mk('wss://a:b@relay.example'), mk('wss://relay.example?x=1'), mk('WSS://Relay.Example:443/'), mk('ws://LOCALHOST:8787')],
        },
      }),
    );
    const t = new ConfigStore(file).get().together;
    expect(t.relay).toBe('wss://relay.example');
    expect(t.rooms.map((r) => r.relay)).toEqual(['wss://relay.example', 'ws://localhost:8787']);
    fs.writeFileSync(file, JSON.stringify({ together: { relay: 'ws://relay.example' } }));
    expect(new ConfigStore(file).get().together.relay).toBe('');
  });

  it('joinedAt must be a positive integer, else now', () => {
    const file = tmpFile();
    const mk = (joinedAt: unknown) => {
      const k = newRoomKey();
      return { id: roomIdOf(k), key: k, relay: 'wss://r', name: 'x', joinedAt };
    };
    fs.writeFileSync(file, JSON.stringify({ together: { rooms: [mk(0), mk(-5), mk(1.5), mk('7'), mk(7)] } }));
    const before = Date.now();
    const got = new ConfigStore(file).get().together.rooms.map((r) => r.joinedAt);
    expect(got.slice(0, 4).every((j) => j >= before)).toBe(true); // a numeric string is not a number JSON wrote
    expect(got[4]).toBe(7);
  });

  it('seals a plain-text room key the moment a keyed store loads it', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ together: { rooms: [room] } }));
    const s = new ConfigStore(file, new SecretBox(KEY));
    expect(s.get().together.rooms[0].key).toBe(key);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(isSealed(disk.together.rooms[0].key)).toBe(true);
    expect(Object.keys(disk.together.rooms[0]).sort()).toEqual(['id', 'joinedAt', 'key', 'name', 'relay']);
  });

  it('a locked room is written back byte-identical, and re-joining it replaces the locked copy', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => c.together.rooms.push({ ...room }));
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')).together.rooms[0].key as string;
    const plain = new ConfigStore(file, new SecretBox());
    plain.update((c) => c.favorites.push('x'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).together.rooms[0].key).toBe(sealed);
    // the same invite pasted again on this keyless backend: one entry on disk, the readable one
    plain.update((c) => c.together.rooms.push({ ...room, name: 'again' }));
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')).together.rooms;
    expect(disk).toHaveLength(1);
    expect(disk[0].name).toBe('again');
    const back = new ConfigStore(file, new SecretBox(KEY)).get().together.rooms;
    expect(back).toEqual([{ ...room, name: 'again' }]);
  });

  it('warns once per locked room and does not count it among the other secrets', () => {
    const file = tmpFile();
    new ConfigStore(file, new SecretBox(KEY)).update((c) => c.together.rooms.push({ ...room }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new ConfigStore(file, new SecretBox());
    const lines = warn.mock.calls.map(([m]) => String(m));
    expect(lines.filter((l) => l.includes('degens'))).toHaveLength(1);
    expect(lines.some((l) => /\d+ secret\(s\)/.test(l))).toBe(false);
  });
});
