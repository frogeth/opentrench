# trenchfeed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that merges selected Discord channels and Telegram chats into one live feed with copyable contract-address chips.

**Architecture:** A Node backend holds a raw Discord gateway WebSocket (user token) and a gramjs Telegram session (user account), normalizes both into one `FeedMessage` shape, runs contract detection, keeps a 500-message ring buffer, and pushes over a local WebSocket. A Vite/React page shows the feed and a settings drawer for tokens and channel picking. Config is one local JSON file; the server binds to 127.0.0.1.

**Tech Stack:** Node 22, TypeScript (ESM), express 4, ws 8, telegram (gramjs) 2.26, bs58 6, vitest 5, Vite 6 + React 18.

Spec: `docs/superpowers/specs/2026-09-08-trenchfeed-design.md`

---

## File map

```
package.json                         npm workspaces + dev/build/start/test scripts
.gitignore
backend/package.json
backend/tsconfig.json
backend/src/types.ts                 FeedMessage, Contract, Status, ServerEvent
backend/src/contracts.ts             detectContracts()
backend/src/contracts.test.ts
backend/src/hub.ts                   MessageHub (buffer + broadcast events)
backend/src/hub.test.ts
backend/src/config.ts                ConfigStore (config.json)
backend/src/discord/gateway.ts       DiscordGateway (raw WS protocol)
backend/src/discord/gateway.test.ts
backend/src/discord/normalize.ts     MESSAGE_CREATE -> FeedMessage
backend/src/discord/normalize.test.ts
backend/src/telegram/normalize.ts    plain values -> FeedMessage
backend/src/telegram/normalize.test.ts
backend/src/telegram/client.ts       TelegramWrapper (login wizard, dialogs, events)
backend/src/services.ts              owns both clients, wires them to hub + config
backend/src/api.ts                   express router
backend/src/ws.ts                    WebSocket server
backend/src/index.ts                 boot
frontend/package.json
frontend/tsconfig.json
frontend/vite.config.ts
frontend/index.html
frontend/src/main.tsx
frontend/src/index.css
frontend/src/types.ts                copy of the shared types
frontend/src/api.ts                  fetch helpers
frontend/src/useFeed.ts              WS client hook
frontend/src/App.tsx
frontend/src/components/Feed.tsx
frontend/src/components/MessageRow.tsx
frontend/src/components/ContractChip.tsx
frontend/src/components/Settings.tsx
README.md
```

---

### Task 1: Workspace scaffolding

**Files:**
- Create: `package.json`, `backend/package.json`, `backend/tsconfig.json`, `backend/src/types.ts`

- [ ] **Step 1: Root package.json**

```json
{
  "name": "trenchfeed",
  "private": true,
  "workspaces": ["backend", "frontend"],
  "scripts": {
    "dev": "concurrently -k -n api,web \"npm run dev -w backend\" \"npm run dev -w frontend\"",
    "build": "npm run build -w frontend && npm run build -w backend",
    "start": "npm start -w backend",
    "test": "npm test -w backend",
    "typecheck": "npm run typecheck -w backend && npm run typecheck -w frontend"
  },
  "devDependencies": {
    "concurrently": "^9.1.2"
  }
}
```

- [ ] **Step 2: backend/package.json**

```json
{
  "name": "backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "bs58": "^6.0.0",
    "express": "^4.21.2",
    "telegram": "^2.26.22",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^5.0.0"
  }
}
```

- [ ] **Step 3: backend/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: backend/src/types.ts**

```ts
export type Source = 'discord' | 'telegram';

export interface Contract {
  chain: 'sol' | 'evm';
  address: string;
}

export interface FeedMessage {
  id: string;
  source: Source;
  chatId: string;
  chatName: string;
  author: string;
  text: string;
  ts: number;
  contracts: Contract[];
  link?: string;
  hasAttachment: boolean;
}

export type DiscordState = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
export type TelegramState = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'auth_error';
export type LoginStep = 'idle' | 'code' | 'password' | 'done';

export interface Status {
  discord: DiscordState;
  telegram: TelegramState;
  loginStep: LoginStep;
  error: { discord?: string; telegram?: string };
}

export type ServerEvent =
  | { type: 'hello'; status: Status; messages: FeedMessage[] }
  | { type: 'message'; msg: FeedMessage }
  | { type: 'status'; status: Status };
```

- [ ] **Step 5: Install and commit**

Run: `cd /Users/moussaboussi/projects/trenchfeed && npm install`
Expected: node_modules created, no errors.

```bash
git add package.json package-lock.json backend
git commit -m "chore: scaffold workspace and backend types"
```

---

### Task 2: Contract detection

**Files:**
- Create: `backend/src/contracts.ts`, `backend/src/contracts.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { detectContracts } from './contracts.js';

const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK mint, 32 bytes
const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';   // USDT
const SOL_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'; // 64 bytes

describe('detectContracts', () => {
  it('finds an EVM address', () => {
    expect(detectContracts(`ape ${EVM} now`)).toEqual([{ chain: 'evm', address: EVM }]);
  });
  it('finds a Solana address', () => {
    expect(detectContracts(`CA: ${SOL}`)).toEqual([{ chain: 'sol', address: SOL }]);
  });
  it('finds both and keeps order', () => {
    expect(detectContracts(`${SOL} and ${EVM}`)).toEqual([
      { chain: 'sol', address: SOL },
      { chain: 'evm', address: EVM },
    ]);
  });
  it('dedupes within a message (EVM case-insensitive)', () => {
    expect(detectContracts(`${EVM} ${EVM.toLowerCase()} ${SOL} ${SOL}`)).toHaveLength(2);
  });
  it('ignores a Solana tx signature (64 bytes)', () => {
    expect(detectContracts(SOL_SIG)).toEqual([]);
  });
  it('ignores an EVM tx hash', () => {
    expect(detectContracts('0x' + 'ab'.repeat(32))).toEqual([]);
  });
  it('finds a Solana address inside a URL path', () => {
    expect(detectContracts(`https://pump.fun/coin/${SOL}`)).toEqual([{ chain: 'sol', address: SOL }]);
  });
  it('ignores plain words', () => {
    expect(detectContracts('thisIsJustAVeryLongWordWithoutAnyNumbersInItAtAll')).toEqual([]);
  });
  it('returns [] for empty text', () => {
    expect(detectContracts('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd /Users/moussaboussi/projects/trenchfeed && npx vitest run -w backend src/contracts.test.ts`
Expected: FAIL, cannot find module `./contracts.js`.

- [ ] **Step 3: Implementation**

```ts
import bs58 from 'bs58';
import type { Contract } from './types.js';

const EVM_RE = /(?<![a-zA-Z0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
const SOL_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

function isSolanaPubkey(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function detectContracts(text: string): Contract[] {
  if (!text) return [];
  const found: { index: number; c: Contract }[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(EVM_RE)) {
    const key = 'evm:' + m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ index: m.index ?? 0, c: { chain: 'evm', address: m[0] } });
  }
  for (const m of text.matchAll(SOL_RE)) {
    if (!isSolanaPubkey(m[0])) continue;
    const key = 'sol:' + m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ index: m.index ?? 0, c: { chain: 'sol', address: m[0] } });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.c);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run -w backend src/contracts.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contracts.ts backend/src/contracts.test.ts
git commit -m "feat: contract address detection"
```

---

### Task 3: MessageHub

**Files:**
- Create: `backend/src/hub.ts`, `backend/src/hub.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { MessageHub } from './hub.js';
import type { FeedMessage, ServerEvent } from './types.js';

function msg(i: number, text = 'hi'): FeedMessage {
  return { id: `discord:${i}`, source: 'discord', chatId: 'c', chatName: '#c', author: 'a', text, ts: i, contracts: [], hasAttachment: false };
}

describe('MessageHub', () => {
  it('detects contracts on push and broadcasts', () => {
    const hub = new MessageHub(10);
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message');
    expect((events[0] as any).msg.contracts).toEqual([{ chain: 'evm', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }]);
  });
  it('caps the buffer', () => {
    const hub = new MessageHub(3);
    for (let i = 0; i < 5; i++) hub.push(msg(i));
    expect(hub.hello().messages.map((m) => m.id)).toEqual(['discord:2', 'discord:3', 'discord:4']);
  });
  it('tracks status and broadcasts it', () => {
    const hub = new MessageHub();
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.setStatus('discord', 'auth_error', 'bad token');
    hub.setStatus('telegram', 'connected');
    expect(hub.hello().status).toEqual({
      discord: 'auth_error', telegram: 'connected', loginStep: 'idle', error: { discord: 'bad token' },
    });
    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
  });
  it('clears the error when a source recovers', () => {
    const hub = new MessageHub();
    hub.setStatus('discord', 'auth_error', 'bad');
    hub.setStatus('discord', 'connected');
    expect(hub.hello().status.error).toEqual({});
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run -w backend src/hub.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implementation**

```ts
import { EventEmitter } from 'node:events';
import { detectContracts } from './contracts.js';
import type { DiscordState, FeedMessage, LoginStep, ServerEvent, Source, Status, TelegramState } from './types.js';

export class MessageHub extends EventEmitter {
  private buffer: FeedMessage[] = [];
  private status: Status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {} };

  constructor(private cap = 500) {
    super();
  }

  push(msg: FeedMessage): void {
    msg.contracts = detectContracts(msg.text);
    this.buffer.push(msg);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    this.emit('event', { type: 'message', msg } satisfies ServerEvent);
  }

  setStatus(source: 'discord', state: DiscordState, error?: string): void;
  setStatus(source: 'telegram', state: TelegramState, error?: string): void;
  setStatus(source: Source, state: DiscordState | TelegramState, error?: string): void {
    (this.status as any)[source] = state;
    if (error) this.status.error[source] = error;
    else delete this.status.error[source];
    this.emitStatus();
  }

  setLoginStep(step: LoginStep): void {
    this.status.loginStep = step;
    this.emitStatus();
  }

  getStatus(): Status {
    return structuredClone(this.status);
  }

  hello(): ServerEvent {
    return { type: 'hello', status: this.getStatus(), messages: [...this.buffer] };
  }

  private emitStatus(): void {
    this.emit('event', { type: 'status', status: this.getStatus() } satisfies ServerEvent);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run -w backend src/hub.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/hub.ts backend/src/hub.test.ts
git commit -m "feat: message hub with ring buffer and status"
```

---

### Task 4: ConfigStore

**Files:**
- Create: `backend/src/config.ts`

- [ ] **Step 1: Implementation** (no unit test; it is a thin fs wrapper exercised by the manual test)

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  discord: { token?: string; watch: string[] };
  telegram: { apiId?: number; apiHash?: string; session?: string; watch: string[] };
}

const DEFAULT: Config = { discord: { watch: [] }, telegram: { watch: [] } };

export class ConfigStore {
  private cfg: Config;

  constructor(private file: string) {
    this.cfg = this.load();
  }

  get(): Config {
    return this.cfg;
  }

  update(fn: (c: Config) => void): void {
    fn(this.cfg);
    this.save();
  }

  /** Tokens/sessions replaced with booleans, safe to send to the UI. */
  masked() {
    return {
      discord: { hasToken: !!this.cfg.discord.token, watch: this.cfg.discord.watch },
      telegram: {
        apiId: this.cfg.telegram.apiId ?? null,
        hasApiHash: !!this.cfg.telegram.apiHash,
        hasSession: !!this.cfg.telegram.session,
        watch: this.cfg.telegram.watch,
      },
    };
  }

  private load(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        discord: { ...DEFAULT.discord, ...raw.discord },
        telegram: { ...DEFAULT.telegram, ...raw.telegram },
      };
    } catch {
      return structuredClone(DEFAULT);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: no output (success).

```bash
git add backend/src/config.ts
git commit -m "feat: config store"
```

---

### Task 5: Discord normalizer

**Files:**
- Create: `backend/src/discord/normalize.ts`, `backend/src/discord/normalize.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeDiscord } from './normalize.js';

const payload = {
  id: '111',
  channel_id: '222',
  guild_id: '333',
  author: { id: '444', username: 'degen', global_name: 'Degen' },
  member: { nick: 'DegenNick' },
  content: 'gm',
  timestamp: '2026-09-08T12:00:00.000Z',
  attachments: [{ id: '1' }],
  embeds: [{ title: 'T', description: 'D', fields: [{ name: 'n', value: 'v' }] }],
};

describe('normalizeDiscord', () => {
  it('maps a MESSAGE_CREATE payload', () => {
    const m = normalizeDiscord(payload, { name: 'alpha', guildName: 'Trenches' });
    expect(m).toEqual({
      id: 'discord:111',
      source: 'discord',
      chatId: '222',
      chatName: '#alpha (Trenches)',
      author: 'DegenNick',
      text: 'gm\nT\nD\nv',
      ts: Date.parse('2026-09-08T12:00:00.000Z'),
      contracts: [],
      link: 'https://discord.com/channels/333/222/111',
      hasAttachment: true,
    });
  });
  it('falls back through nick -> global_name -> username', () => {
    expect(normalizeDiscord({ ...payload, member: undefined }, { name: 'a', guildName: 'g' }).author).toBe('Degen');
    expect(normalizeDiscord({ ...payload, member: undefined, author: { id: '1', username: 'u' } }, { name: 'a', guildName: 'g' }).author).toBe('u');
  });
  it('handles missing embeds/attachments', () => {
    const m = normalizeDiscord({ ...payload, embeds: undefined, attachments: undefined }, { name: 'a', guildName: 'g' });
    expect(m.text).toBe('gm');
    expect(m.hasAttachment).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run -w backend src/discord/normalize.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implementation**

```ts
import type { FeedMessage } from '../types.js';

export interface DiscordChannelInfo {
  name: string;
  guildName: string;
}

export function normalizeDiscord(d: any, ch: DiscordChannelInfo): FeedMessage {
  const parts: string[] = [d.content ?? ''];
  for (const e of d.embeds ?? []) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields ?? []) if (f.value) parts.push(f.value);
  }
  return {
    id: `discord:${d.id}`,
    source: 'discord',
    chatId: String(d.channel_id),
    chatName: `#${ch.name} (${ch.guildName})`,
    author: d.member?.nick ?? d.author?.global_name ?? d.author?.username ?? 'unknown',
    text: parts.filter(Boolean).join('\n'),
    ts: Date.parse(d.timestamp) || Date.now(),
    contracts: [],
    link: d.guild_id ? `https://discord.com/channels/${d.guild_id}/${d.channel_id}/${d.id}` : undefined,
    hasAttachment: (d.attachments?.length ?? 0) > 0,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run -w backend src/discord/normalize.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/discord
git commit -m "feat: discord message normalizer"
```

---

### Task 6: Discord gateway

**Files:**
- Create: `backend/src/discord/gateway.ts`, `backend/src/discord/gateway.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordGateway, type WsLike } from './gateway.js';

class FakeWs implements WsLike {
  sent: any[] = [];
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  closed?: number;
  constructor(public url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number) { this.closed = code; this.fire('close', code ?? 1000); }
  on(ev: string, fn: (...a: any[]) => void) { (this.handlers[ev] ??= []).push(fn); }
  fire(ev: string, ...a: any[]) { for (const h of this.handlers[ev] ?? []) h(...a); }
  recv(obj: any) { this.fire('message', JSON.stringify(obj)); }
}

function setup() {
  const sockets: FakeWs[] = [];
  const gw = new DiscordGateway('tok', { wsFactory: (url) => { const w = new FakeWs(url); sockets.push(w); return w; } });
  const states: string[] = [];
  gw.on('state', (s) => states.push(s));
  return { gw, sockets, states };
}

const READY = {
  op: 0, t: 'READY', s: 1,
  d: {
    session_id: 'sess', resume_gateway_url: 'wss://resume.example',
    guilds: [{ id: 'g1', properties: { name: 'Guild One' }, channels: [
      { id: 'c1', name: 'alpha', type: 0 }, { id: 'c2', name: 'voice', type: 2 }, { id: 'c3', name: 'news', type: 5 },
    ] }],
  },
};

describe('DiscordGateway', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('identifies after HELLO and heartbeats on the interval', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(ws.sent[0].op).toBe(2);
    expect(ws.sent[0].d.token).toBe('tok');
    vi.advanceTimersByTime(1000);
    expect(ws.sent.at(-1)).toEqual({ op: 1, d: null });
  });

  it('extracts text channels from READY and reports connected', () => {
    const { gw, sockets, states } = setup();
    const channels: any[] = [];
    gw.on('channels', (c) => channels.push(...c));
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    expect(channels).toEqual([
      { id: 'c1', name: 'alpha', guildName: 'Guild One' },
      { id: 'c3', name: 'news', guildName: 'Guild One' },
    ]);
    expect(states.at(-1)).toBe('connected');
  });

  it('emits MESSAGE_CREATE payloads', () => {
    const { gw, sockets } = setup();
    const msgs: any[] = [];
    gw.on('message', (m) => msgs.push(m));
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1', channel_id: 'c1', content: 'x' } });
    expect(msgs).toEqual([{ id: 'm1', channel_id: 'c1', content: 'x' }]);
  });

  it('reconnects with RESUME after a non-fatal close', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    ws.fire('close', 1006);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe('wss://resume.example/?v=10&encoding=json');
    sockets[1].fire('open');
    sockets[1].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(sockets[1].sent[0]).toEqual({ op: 6, d: { token: 'tok', session_id: 'sess', seq: 1 } });
  });

  it('closes and reconnects when a heartbeat ACK is missed', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    vi.advanceTimersByTime(1000); // heartbeat 1 sent, no ack
    vi.advanceTimersByTime(1000); // zombie detected
    expect(ws.closed).toBe(4000);
    vi.advanceTimersByTime(1000); // backoff
    expect(sockets).toHaveLength(2);
  });

  it('stops with auth_error on close 4004', () => {
    const { gw, sockets, states } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.fire('close', 4004);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('auth_error');
  });

  it('re-identifies after INVALID_SESSION', () => {
    const { gw, sockets } = setup();
    gw.connect();
    const ws = sockets[0];
    ws.fire('open');
    ws.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    ws.recv(READY);
    ws.recv({ op: 9, d: false });
    vi.advanceTimersByTime(5000);
    const ws2 = sockets[1];
    ws2.fire('open');
    ws2.recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(ws2.sent[0].op).toBe(2);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run -w backend src/discord/gateway.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implementation**

```ts
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { DiscordState } from '../types.js';

export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  on(ev: 'open' | 'message' | 'close' | 'error', fn: (...args: any[]) => void): void;
}
export type WsFactory = (url: string) => WsLike;

export interface DiscordChannel {
  id: string;
  name: string;
  guildName: string;
}

const GATEWAY_HOST = 'wss://gateway.discord.gg';
const QUERY = '/?v=10&encoding=json';
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NO_RESUME_CODES = new Set([4007, 4009]);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const defaultFactory: WsFactory = (url) =>
  new WebSocket(url, { headers: { 'User-Agent': USER_AGENT, Origin: 'https://discord.com' } }) as unknown as WsLike;

/**
 * Raw Discord gateway client for a user token.
 * Events: 'state' (DiscordState, error?), 'channels' (DiscordChannel[]), 'message' (raw MESSAGE_CREATE d).
 */
export class DiscordGateway extends EventEmitter {
  private ws?: WsLike;
  private seq: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private hbTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private acked = true;
  private backoff = 1000;
  private stopped = false;
  private wsFactory: WsFactory;
  state: DiscordState = 'disconnected';

  constructor(private token: string, opts: { wsFactory?: WsFactory } = {}) {
    super();
    this.wsFactory = opts.wsFactory ?? defaultFactory;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.ws = undefined;
    this.setState('disconnected');
  }

  private open(): void {
    this.clearTimers();
    this.acked = true;
    this.setState('connecting');
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl.replace(/\/?$/, '') : GATEWAY_HOST;
    const ws = this.wsFactory(base + QUERY);
    this.ws = ws;
    ws.on('open', () => { /* wait for HELLO */ });
    ws.on('message', (data) => {
      let p: any;
      try { p = JSON.parse(String(data)); } catch { return; }
      if (ws === this.ws) this.handle(p);
    });
    ws.on('close', (code: number) => { if (ws === this.ws) this.onClose(code); });
    ws.on('error', (e: any) => console.warn('[discord] ws error', e?.message ?? e));
  }

  private handle(p: any): void {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10:
        this.startHeartbeat(p.d.heartbeat_interval);
        if (this.sessionId) this.resume(); else this.identify();
        break;
      case 11:
        this.acked = true;
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7: // reconnect
        this.ws?.close(4000);
        break;
      case 9: // invalid session
        if (!p.d) { this.sessionId = undefined; this.seq = null; }
        this.ws?.close(4000);
        break;
      case 0:
        this.dispatch(p.t, p.d);
        break;
    }
  }

  private dispatch(t: string, d: any): void {
    switch (t) {
      case 'READY': {
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.backoff = 1000;
        const channels: DiscordChannel[] = [];
        for (const g of d.guilds ?? []) channels.push(...extractChannels(g));
        this.emit('channels', channels);
        this.setState('connected');
        break;
      }
      case 'RESUMED':
        this.backoff = 1000;
        this.setState('connected');
        break;
      case 'GUILD_CREATE':
        this.emit('channels', extractChannels(d));
        break;
      case 'MESSAGE_CREATE':
        this.emit('message', d);
        break;
    }
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 30717,
        properties: {
          os: 'Mac OS X',
          browser: 'Chrome',
          device: '',
          system_locale: 'en-US',
          browser_user_agent: USER_AGENT,
          browser_version: '128.0.0.0',
          os_version: '10.15.7',
          referrer: '',
          referring_domain: '',
          referrer_current: '',
          referring_domain_current: '',
          release_channel: 'stable',
          client_build_number: 320000,
          client_event_source: null,
        },
        presence: { status: 'online', since: 0, activities: [], afk: false },
        compress: false,
        client_state: { guild_versions: {} },
      },
    });
  }

  private resume(): void {
    this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.acked = true;
    this.hbTimer = setInterval(() => {
      if (!this.acked) {
        console.warn('[discord] missed heartbeat ack, reconnecting');
        this.ws?.close(4000);
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  private send(obj: unknown): void {
    try { this.ws?.send(JSON.stringify(obj)); } catch (e) { console.warn('[discord] send failed', e); }
  }

  private onClose(code: number): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = undefined;
    this.ws = undefined;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.stopped = true;
      this.setState('auth_error', code === 4004 ? 'Discord rejected the token' : `Discord closed the connection (${code})`);
      return;
    }
    if (NO_RESUME_CODES.has(code)) { this.sessionId = undefined; this.seq = null; }
    if (this.stopped) return;
    this.setState('disconnected');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.hbTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setState(state: DiscordState, error?: string): void {
    this.state = state;
    this.emit('state', state, error);
  }
}

function extractChannels(g: any): DiscordChannel[] {
  const guildName = g.properties?.name ?? g.name ?? 'Unknown';
  return (g.channels ?? [])
    .filter((c: any) => c.type === 0 || c.type === 5)
    .map((c: any) => ({ id: String(c.id), name: String(c.name), guildName }));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run -w backend src/discord/gateway.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/discord/gateway.ts backend/src/discord/gateway.test.ts
git commit -m "feat: discord gateway client with heartbeat, resume, reconnect"
```

---

### Task 7: Telegram normalizer

**Files:**
- Create: `backend/src/telegram/normalize.ts`, `backend/src/telegram/normalize.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTelegram } from './normalize.js';

describe('normalizeTelegram', () => {
  it('maps plain fields', () => {
    expect(normalizeTelegram({
      id: 42, chatId: '-1001234', chatTitle: 'Alpha Group', chatUsername: 'alphagrp',
      senderName: '@caller', text: 'CA below', date: 1_757_332_800, hasMedia: true,
    })).toEqual({
      id: 'telegram:-1001234:42',
      source: 'telegram',
      chatId: '-1001234',
      chatName: 'Alpha Group',
      author: '@caller',
      text: 'CA below',
      ts: 1_757_332_800_000,
      contracts: [],
      link: 'https://t.me/alphagrp/42',
      hasAttachment: true,
    });
  });
  it('omits link for private chats', () => {
    const m = normalizeTelegram({ id: 1, chatId: '-5', chatTitle: 'Priv', senderName: 'x', text: '', date: 0, hasMedia: false });
    expect(m.link).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run -w backend src/telegram/normalize.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implementation**

```ts
import type { FeedMessage } from '../types.js';

export interface TelegramPlain {
  id: number;
  chatId: string;
  chatTitle: string;
  chatUsername?: string;
  senderName: string;
  text: string;
  date: number; // unix seconds
  hasMedia: boolean;
}

export function normalizeTelegram(p: TelegramPlain): FeedMessage {
  return {
    id: `telegram:${p.chatId}:${p.id}`,
    source: 'telegram',
    chatId: p.chatId,
    chatName: p.chatTitle,
    author: p.senderName,
    text: p.text,
    ts: p.date * 1000,
    contracts: [],
    link: p.chatUsername ? `https://t.me/${p.chatUsername}/${p.id}` : undefined,
    hasAttachment: p.hasMedia,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run -w backend src/telegram/normalize.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/telegram
git commit -m "feat: telegram message normalizer"
```

---

### Task 8: Telegram client wrapper

**Files:**
- Create: `backend/src/telegram/client.ts`

No unit test (wraps a live network library). Verified in the manual test in Task 12.

- [ ] **Step 1: Implementation**

```ts
import { EventEmitter } from 'node:events';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import type { LoginStep, TelegramState } from '../types.js';
import { normalizeTelegram, type TelegramPlain } from './normalize.js';
import type { FeedMessage } from '../types.js';

export interface TelegramDialog {
  id: string;
  title: string;
  type: 'group' | 'channel';
}

const FATAL_AUTH = ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_DUPLICATED', 'AUTH_KEY_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED'];
const HEALTH_INTERVAL_MS = 30_000;
const STEP_WAIT_MS = 20_000;

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Events: 'state' (TelegramState, error?), 'step' (LoginStep), 'session' (string), 'message' (FeedMessage).
 */
export class TelegramWrapper extends EventEmitter {
  private client?: TelegramClient;
  private pending: { code?: Deferred<string>; password?: Deferred<string> } = {};
  private stepWaiters: ((s: LoginStep) => void)[] = [];
  private healthTimer?: ReturnType<typeof setInterval>;
  private started = false;
  state: TelegramState = 'disconnected';
  step: LoginStep = 'idle';

  constructor(private apiId: number, private apiHash: string, private session: string | undefined) {
    super();
  }

  /** Connect with the saved session, or report needs_login. */
  async connect(): Promise<void> {
    await this.teardown();
    if (!this.session) { this.setState('needs_login'); return; }
    this.setState('connecting');
    try {
      const client = this.makeClient(this.session);
      await client.connect();
      if (!(await client.isUserAuthorized())) {
        await client.disconnect();
        this.setState('needs_login');
        return;
      }
      this.onAuthorized(client);
    } catch (e: any) {
      this.setState(this.isFatal(e) ? 'needs_login' : 'auth_error', e?.message ?? String(e));
    }
  }

  async loginStart(phone: string): Promise<LoginStep> {
    await this.teardown();
    this.setState('connecting');
    const client = this.makeClient('');
    this.client = client;
    this.pending = {};
    const stepChange = this.nextStep();
    client
      .start({
        phoneNumber: async () => phone,
        phoneCode: async () => this.waitFor('code'),
        password: async () => this.waitFor('password'),
        onError: async (err) => {
          console.warn('[telegram] login error', err.message);
          this.setState('needs_login', err.message);
          this.setStep('idle');
          return true;
        },
      })
      .then(() => {
        this.session = client.session.save() as unknown as string;
        this.emit('session', this.session);
        this.setStep('done');
        this.onAuthorized(client);
      })
      .catch((e) => {
        this.setState('needs_login', e?.message ?? String(e));
        this.setStep('idle');
      });
    return stepChange;
  }

  async loginCode(code: string): Promise<LoginStep> {
    const next = this.nextStep();
    this.pending.code?.resolve(code);
    return next;
  }

  async loginPassword(password: string): Promise<LoginStep> {
    const next = this.nextStep();
    this.pending.password?.resolve(password);
    return next;
  }

  async logout(): Promise<void> {
    await this.teardown();
    this.session = undefined;
    this.emit('session', undefined);
    this.setStep('idle');
    this.setState('needs_login');
  }

  async listDialogs(): Promise<TelegramDialog[]> {
    if (!this.client || this.state !== 'connected') return [];
    const dialogs = await this.client.getDialogs({ limit: 500 });
    return dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({ id: String(d.id), title: d.title ?? '(untitled)', type: d.isChannel && !d.isGroup ? 'channel' as const : 'group' as const }));
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.setState('disconnected');
  }

  // --- internals ---

  private makeClient(session: string): TelegramClient {
    return new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
      connectionRetries: 5,
      useWSS: false,
    });
  }

  private onAuthorized(client: TelegramClient): void {
    this.client = client;
    this.started = true;
    client.addEventHandler((ev: NewMessageEvent) => { void this.onNewMessage(ev); }, new NewMessage({}));
    this.healthTimer = setInterval(() => void this.healthCheck(), HEALTH_INTERVAL_MS);
    this.setState('connected');
  }

  private async onNewMessage(ev: NewMessageEvent): Promise<void> {
    try {
      const m = ev.message;
      const chatId = String(m.chatId ?? ev.chatId ?? '');
      if (!chatId) return;
      const chat: any = await m.getChat().catch(() => null);
      const sender: any = await m.getSender().catch(() => null);
      const senderName = sender?.username
        ? `@${sender.username}`
        : [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || sender?.title || chat?.title || 'unknown';
      const plain: TelegramPlain = {
        id: m.id,
        chatId,
        chatTitle: chat?.title ?? chatId,
        chatUsername: chat?.username ?? undefined,
        senderName,
        text: m.message ?? '',
        date: m.date,
        hasMedia: !!m.media,
      };
      this.emit('message', normalizeTelegram(plain) satisfies FeedMessage);
    } catch (e) {
      console.warn('[telegram] dropped message', e);
    }
  }

  private async healthCheck(): Promise<void> {
    if (!this.client) return;
    try {
      await Promise.race([
        this.client.getMe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('health probe timeout')), 15_000)),
      ]);
      if (this.state !== 'connected') this.setState('connected');
    } catch (e: any) {
      console.warn('[telegram] health check failed', e?.message);
      if (this.isFatal(e)) { await this.teardown(); this.setState('needs_login', e.message); return; }
      this.setState('connecting');
      try { await this.client.connect(); } catch { /* next tick retries */ }
    }
  }

  private isFatal(e: any): boolean {
    const msg = String(e?.errorMessage ?? e?.message ?? '');
    return FATAL_AUTH.some((k) => msg.includes(k));
  }

  private waitFor(step: 'code' | 'password'): Promise<string> {
    const d = deferred<string>();
    this.pending[step] = d;
    this.setStep(step);
    return d.promise;
  }

  private nextStep(): Promise<LoginStep> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.stepWaiters = this.stepWaiters.filter((w) => w !== fn); resolve(this.step); }, STEP_WAIT_MS);
      const fn = (s: LoginStep) => { clearTimeout(t); resolve(s); };
      this.stepWaiters.push(fn);
    });
  }

  private setStep(step: LoginStep): void {
    this.step = step;
    this.emit('step', step);
    const ws = this.stepWaiters; this.stepWaiters = [];
    for (const w of ws) w(step);
  }

  private setState(state: TelegramState, error?: string): void {
    this.state = state;
    this.emit('state', state, error);
  }

  private async teardown(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    for (const d of Object.values(this.pending)) d?.reject(new Error('AUTH_USER_CANCEL'));
    this.pending = {};
    const c = this.client;
    this.client = undefined;
    this.started = false;
    if (c) {
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: success. If gramjs types complain about `client.session.save()`, keep the cast shown.

```bash
git add backend/src/telegram/client.ts
git commit -m "feat: telegram client wrapper with web login wizard"
```

---

### Task 9: Services, API, WS, boot

**Files:**
- Create: `backend/src/services.ts`, `backend/src/api.ts`, `backend/src/ws.ts`, `backend/src/index.ts`

- [ ] **Step 1: services.ts**

```ts
import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordGateway, type DiscordChannel } from './discord/gateway.js';
import { normalizeDiscord } from './discord/normalize.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';

export class Services {
  discord?: DiscordGateway;
  telegram?: TelegramWrapper;
  private discordChannels = new Map<string, DiscordChannel>();

  constructor(private cfg: ConfigStore, private hub: MessageHub) {}

  // ---- Discord ----

  startDiscord(): void {
    this.discord?.stop();
    this.discord = undefined;
    this.discordChannels.clear();
    const token = this.cfg.get().discord.token;
    if (!token) { this.hub.setStatus('discord', 'disconnected'); return; }
    const gw = new DiscordGateway(token);
    gw.on('state', (s, err) => this.hub.setStatus('discord', s, err));
    gw.on('channels', (chs: DiscordChannel[]) => { for (const c of chs) this.discordChannels.set(c.id, c); });
    gw.on('message', (d) => {
      const id = String(d.channel_id);
      if (!this.cfg.get().discord.watch.includes(id)) return;
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildName: '?' };
      try { this.hub.push(normalizeDiscord(d, ch)); } catch (e) { console.warn('[discord] dropped message', e); }
    });
    gw.connect();
    this.discord = gw;
  }

  listDiscordChannels(): DiscordChannel[] {
    return [...this.discordChannels.values()].sort((a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name));
  }

  // ---- Telegram ----

  async startTelegram(): Promise<void> {
    await this.telegram?.stop();
    this.telegram = undefined;
    const { apiId, apiHash, session } = this.cfg.get().telegram;
    if (!apiId || !apiHash) { this.hub.setStatus('telegram', 'disconnected'); return; }
    const tg = new TelegramWrapper(apiId, apiHash, session);
    tg.on('state', (s, err) => this.hub.setStatus('telegram', s, err));
    tg.on('step', (step) => this.hub.setLoginStep(step));
    tg.on('session', (sess?: string) => this.cfg.update((c) => { c.telegram.session = sess; }));
    tg.on('message', (m) => {
      if (!this.cfg.get().telegram.watch.includes(m.chatId)) return;
      this.hub.push(m);
    });
    this.telegram = tg;
    await tg.connect();
  }

  async listTelegramDialogs(): Promise<TelegramDialog[]> {
    return this.telegram?.listDialogs() ?? [];
  }
}
```

- [ ] **Step 2: api.ts**

```ts
import { Router, json } from 'express';
import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import type { Services } from './services.js';

export function createApi(cfg: ConfigStore, hub: MessageHub, svc: Services): Router {
  const r = Router();
  r.use(json({ limit: '64kb' }));

  const wrap = (fn: (req: any, res: any) => Promise<unknown> | unknown) => async (req: any, res: any) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e: any) {
      console.error('[api]', req.method, req.path, e);
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };

  r.get('/status', wrap(() => hub.getStatus()));
  r.get('/config', wrap(() => cfg.masked()));

  r.put('/discord/token', wrap((req) => {
    const token = String(req.body?.token ?? '').trim();
    if (!token) throw new Error('token required');
    cfg.update((c) => { c.discord.token = token; });
    svc.startDiscord();
  }));
  r.get('/discord/channels', wrap(() => svc.listDiscordChannels()));
  r.put('/discord/watch', wrap((req) => {
    const ids = (req.body?.ids ?? []).map(String);
    cfg.update((c) => { c.discord.watch = ids; });
  }));

  r.put('/telegram/credentials', wrap(async (req) => {
    const apiId = Number(req.body?.apiId);
    const apiHash = String(req.body?.apiHash ?? '').trim();
    if (!apiId || !apiHash) throw new Error('apiId and apiHash required');
    cfg.update((c) => { c.telegram.apiId = apiId; c.telegram.apiHash = apiHash; c.telegram.session = undefined; });
    await svc.startTelegram();
  }));
  r.post('/telegram/login/start', wrap(async (req) => {
    if (!svc.telegram) throw new Error('set Telegram credentials first');
    return { step: await svc.telegram.loginStart(String(req.body?.phone ?? '').trim()) };
  }));
  r.post('/telegram/login/code', wrap(async (req) => {
    if (!svc.telegram) throw new Error('not started');
    return { step: await svc.telegram.loginCode(String(req.body?.code ?? '').trim()) };
  }));
  r.post('/telegram/login/password', wrap(async (req) => {
    if (!svc.telegram) throw new Error('not started');
    return { step: await svc.telegram.loginPassword(String(req.body?.password ?? '')) };
  }));
  r.post('/telegram/logout', wrap(async () => { await svc.telegram?.logout(); }));
  r.get('/telegram/dialogs', wrap(() => svc.listTelegramDialogs()));
  r.put('/telegram/watch', wrap((req) => {
    const ids = (req.body?.ids ?? []).map(String);
    cfg.update((c) => { c.telegram.watch = ids; });
  }));

  return r;
}
```

- [ ] **Step 3: ws.ts**

```ts
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { MessageHub } from './hub.js';
import type { ServerEvent } from './types.js';

export function attachWs(server: Server, hub: MessageHub): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(hub.hello()));
  });
  hub.on('event', (ev: ServerEvent) => {
    const data = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}
```

- [ ] **Step 4: index.ts**

```ts
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { MessageHub } from './hub.js';
import { Services } from './services.js';
import { createApi } from './api.js';
import { attachWs } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');              // backend/ (dist/ or src/ parent)
const PORT = Number(process.env.PORT ?? 3210);
const HOST = '127.0.0.1';

const cfg = new ConfigStore(process.env.TRENCHFEED_CONFIG ?? path.join(root, 'config.json'));
const hub = new MessageHub(500);
const svc = new Services(cfg, hub);

const app = express();
app.use('/api', createApi(cfg, hub, svc));

const dist = path.resolve(root, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);
attachWs(server, hub);

server.listen(PORT, HOST, () => {
  console.log(`trenchfeed listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
```

- [ ] **Step 5: Typecheck, run all tests, smoke-boot, commit**

Run: `npm run typecheck -w backend && npm test -w backend`
Expected: typecheck clean, all tests pass.

Run: `cd backend && timeout 5 npx tsx src/index.ts; true`
Expected: prints `trenchfeed listening on http://127.0.0.1:3210` then exits on timeout.

```bash
git add backend/src
git commit -m "feat: services, http api, websocket, boot"
```

---

### Task 10: Frontend scaffold and feed

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/index.css`, `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/useFeed.ts`, `frontend/src/App.tsx`, `frontend/src/components/Feed.tsx`, `frontend/src/components/MessageRow.tsx`, `frontend/src/components/ContractChip.tsx`

- [ ] **Step 1: frontend/package.json**

```json
{
  "name": "frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.3",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: frontend/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: frontend/vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3210',
      '/ws': { target: 'ws://127.0.0.1:3210', ws: true },
    },
  },
});
```

- [ ] **Step 4: frontend/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>trenchfeed</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: frontend/src/main.tsx**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: frontend/src/types.ts** — identical to `backend/src/types.ts` (copy the file verbatim).

- [ ] **Step 7: frontend/src/api.ts**

```ts
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export interface MaskedConfig {
  discord: { hasToken: boolean; watch: string[] };
  telegram: { apiId: number | null; hasApiHash: boolean; hasSession: boolean; watch: string[] };
}
export interface DiscordChannel { id: string; name: string; guildName: string }
export interface TelegramDialog { id: string; title: string; type: 'group' | 'channel' }

export const api = {
  config: () => req<MaskedConfig>('GET', '/config'),
  setDiscordToken: (token: string) => req('PUT', '/discord/token', { token }),
  discordChannels: () => req<DiscordChannel[]>('GET', '/discord/channels'),
  setDiscordWatch: (ids: string[]) => req('PUT', '/discord/watch', { ids }),
  setTelegramCreds: (apiId: number, apiHash: string) => req('PUT', '/telegram/credentials', { apiId, apiHash }),
  tgStart: (phone: string) => req<{ step: string }>('POST', '/telegram/login/start', { phone }),
  tgCode: (code: string) => req<{ step: string }>('POST', '/telegram/login/code', { code }),
  tgPassword: (password: string) => req<{ step: string }>('POST', '/telegram/login/password', { password }),
  tgLogout: () => req('POST', '/telegram/logout'),
  telegramDialogs: () => req<TelegramDialog[]>('GET', '/telegram/dialogs'),
  setTelegramWatch: (ids: string[]) => req('PUT', '/telegram/watch', { ids }),
};
```

- [ ] **Step 8: frontend/src/useFeed.ts**

```ts
import { useEffect, useState } from 'react';
import type { FeedMessage, ServerEvent, Status } from './types';

const MAX = 500;

export function useFeed() {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [status, setStatus] = useState<Status>({ discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {} });
  const [wsOpen, setWsOpen] = useState(false);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setWsOpen(true);
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (ev.type === 'hello') { setMessages(ev.messages); setStatus(ev.status); }
        else if (ev.type === 'message') setMessages((m) => [...m.slice(-(MAX - 1)), ev.msg]);
        else if (ev.type === 'status') setStatus(ev.status);
      };
      ws.onclose = () => {
        setWsOpen(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); ws?.close(); };
  }, []);

  return { messages, status, wsOpen };
}
```

- [ ] **Step 9: frontend/src/components/ContractChip.tsx**

```tsx
import { useState } from 'react';
import type { Contract } from '../types';

export function ContractChip({ c }: { c: Contract }) {
  const [copied, setCopied] = useState(false);
  const short = `${c.address.slice(0, 4)}…${c.address.slice(-4)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(c.address); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button className={`chip chip-${c.chain}`} onClick={copy} title={c.address}>
      <span className="chip-chain">{c.chain.toUpperCase()}</span>
      <span className="chip-addr">{copied ? 'copied' : short}</span>
    </button>
  );
}
```

- [ ] **Step 10: frontend/src/components/MessageRow.tsx**

```tsx
import type { FeedMessage } from '../types';
import { ContractChip } from './ContractChip';

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function MessageRow({ m }: { m: FeedMessage }) {
  return (
    <div className={`row row-${m.source}`}>
      <div className="row-meta">
        <span className={`badge badge-${m.source}`}>{m.source === 'discord' ? 'DC' : 'TG'}</span>
        <span className="chat">{m.chatName}</span>
        <span className="author">{m.author}</span>
        <span className="time">
          {m.link ? <a href={m.link} target="_blank" rel="noreferrer">{fmtTime(m.ts)}</a> : fmtTime(m.ts)}
        </span>
      </div>
      <div className="row-text">
        {m.text}
        {m.hasAttachment && <span className="attach" title="has attachment"> 📎</span>}
      </div>
      {m.contracts.length > 0 && (
        <div className="row-contracts">
          {m.contracts.map((c) => <ContractChip key={c.chain + c.address} c={c} />)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11: frontend/src/components/Feed.tsx**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedMessage } from '../types';
import { MessageRow } from './MessageRow';

export function Feed({ messages }: { messages: FeedMessage[] }) {
  const [filter, setFilter] = useState('');
  const [onlyContracts, setOnlyContracts] = useState(false);
  const [stick, setStick] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return messages.filter((m) => {
      if (onlyContracts && m.contracts.length === 0) return false;
      if (!q) return true;
      return m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q) || m.chatName.toLowerCase().includes(q);
    });
  }, [messages, filter, onlyContracts]);

  useEffect(() => {
    if (stick && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [shown, stick]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div className="feed">
      <div className="feed-bar">
        <input placeholder="filter text, author, chat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label><input type="checkbox" checked={onlyContracts} onChange={(e) => setOnlyContracts(e.target.checked)} /> contracts only</label>
        <span className="count">{shown.length}</span>
      </div>
      <div className="feed-list" ref={listRef} onScroll={onScroll}>
        {shown.length === 0 && <div className="empty">No messages yet. Pick channels in settings.</div>}
        {shown.map((m) => <MessageRow key={m.id} m={m} />)}
      </div>
      {!stick && <button className="jump" onClick={() => setStick(true)}>↓ latest</button>}
    </div>
  );
}
```

- [ ] **Step 12: frontend/src/App.tsx** (Settings component comes in Task 11; stub it first)

```tsx
import { useState } from 'react';
import { useFeed } from './useFeed';
import { Feed } from './components/Feed';
import { Settings } from './components/Settings';
import type { Status } from './types';

function Pill({ label, state }: { label: string; state: string }) {
  return <span className={`pill pill-${state}`}>{label}: {state.replace('_', ' ')}</span>;
}

export default function App() {
  const { messages, status, wsOpen } = useFeed();
  const [open, setOpen] = useState(false);
  const errors = Object.entries(status.error) as [keyof Status['error'], string][];

  return (
    <div className="app">
      <header>
        <h1>trenchfeed</h1>
        <Pill label="discord" state={status.discord} />
        <Pill label="telegram" state={status.telegram} />
        {!wsOpen && <span className="pill pill-disconnected">server: offline</span>}
        <button className="gear" onClick={() => setOpen((o) => !o)}>⚙</button>
      </header>
      {errors.length > 0 && (
        <div className="banner" onClick={() => setOpen(true)}>
          {errors.map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}
        </div>
      )}
      <main>
        <Feed messages={messages} />
        {open && <Settings status={status} onClose={() => setOpen(false)} />}
      </main>
    </div>
  );
}
```

Temporary stub so this task builds, replaced in Task 11 — create `frontend/src/components/Settings.tsx`:

```tsx
import type { Status } from '../types';
export function Settings({ onClose }: { status: Status; onClose: () => void }) {
  return <aside className="settings"><button onClick={onClose}>close</button></aside>;
}
```

- [ ] **Step 13: frontend/src/index.css**

```css
:root {
  --bg: #0e0f13; --panel: #171922; --line: #262a36; --text: #e6e8ef; --muted: #8a90a5;
  --dc: #5865f2; --tg: #2aabee; --ok: #3ddc84; --warn: #f5b942; --err: #ff5c5c;
  --sol: #9945ff; --evm: #627eea;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.app { display: flex; flex-direction: column; height: 100%; }
header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 16px; margin: 0 8px 0 0; }
.gear { margin-left: auto; background: none; border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.pill-connected { color: var(--ok); border-color: var(--ok); }
.pill-connecting { color: var(--warn); border-color: var(--warn); }
.pill-auth_error, .pill-disconnected { color: var(--err); border-color: var(--err); }
.pill-needs_login { color: var(--warn); border-color: var(--warn); }
.banner { background: #3a1c1c; color: #ffb3b3; padding: 8px 14px; cursor: pointer; border-bottom: 1px solid var(--err); }
main { flex: 1; display: flex; min-height: 0; }
.feed { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
.feed-bar { display: flex; gap: 12px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--line); }
.feed-bar input[type=text], .feed-bar input:not([type]) { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
.count { color: var(--muted); font-size: 12px; }
.feed-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.empty { color: var(--muted); text-align: center; padding: 40px; }
.row { padding: 6px 14px; border-left: 3px solid transparent; }
.row:hover { background: var(--panel); }
.row-discord { border-left-color: var(--dc); }
.row-telegram { border-left-color: var(--tg); }
.row-meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--muted); }
.badge { font-weight: 700; font-size: 10px; padding: 1px 5px; border-radius: 4px; color: #fff; }
.badge-discord { background: var(--dc); }
.badge-telegram { background: var(--tg); }
.chat { color: var(--text); }
.author { font-weight: 600; }
.time a { color: var(--muted); text-decoration: none; }
.time a:hover { text-decoration: underline; }
.row-text { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.row-contracts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.chip { display: inline-flex; gap: 6px; align-items: center; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 2px 8px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; }
.chip-chain { font-weight: 700; font-size: 10px; }
.chip-sol .chip-chain { color: var(--sol); }
.chip-evm .chip-chain { color: var(--evm); }
.chip:hover { border-color: var(--muted); }
.jump { position: absolute; bottom: 14px; right: 14px; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
.settings { width: 380px; border-left: 1px solid var(--line); background: var(--panel); overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 18px; }
.settings h2 { font-size: 14px; margin: 0 0 8px; }
.settings section { display: flex; flex-direction: column; gap: 8px; }
.settings input { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; width: 100%; }
.settings button { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.settings button.primary { border-color: var(--ok); color: var(--ok); }
.settings .hint { color: var(--muted); font-size: 12px; }
.settings .err { color: var(--err); font-size: 12px; }
.picker { max-height: 260px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; padding: 4px; }
.picker label { display: block; padding: 3px 6px; font-size: 13px; cursor: pointer; }
.picker label:hover { background: var(--bg); }
.picker .group { color: var(--muted); font-size: 11px; padding: 6px 6px 2px; text-transform: uppercase; }
.settings .close { align-self: flex-end; }
```

- [ ] **Step 14: Install, typecheck, build, commit**

Run: `cd /Users/moussaboussi/projects/trenchfeed && npm install && npm run typecheck -w frontend && npm run build -w frontend`
Expected: `dist/` built with no type errors.

```bash
git add frontend package-lock.json
git commit -m "feat: frontend feed UI"
```

---

### Task 11: Settings drawer

**Files:**
- Modify: `frontend/src/components/Settings.tsx` (replace the stub)

- [ ] **Step 1: Implementation**

```tsx
import { useEffect, useState } from 'react';
import { api, type DiscordChannel, type MaskedConfig, type TelegramDialog } from '../api';
import type { Status } from '../types';

export function Settings({ status, onClose }: { status: Status; onClose: () => void }) {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const reload = () => api.config().then(setCfg).catch(() => {});
  useEffect(() => { reload(); }, [status.discord, status.telegram]);

  return (
    <aside className="settings">
      <button className="close" onClick={onClose}>close</button>
      {cfg && <DiscordSection cfg={cfg} status={status} onChange={reload} />}
      {cfg && <TelegramSection cfg={cfg} status={status} onChange={reload} />}
    </aside>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };
  return { busy, err, run };
}

function DiscordSection({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [token, setToken] = useState('');
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [search, setSearch] = useState('');
  const { busy, err, run } = useAsync();

  useEffect(() => {
    if (status.discord === 'connected') api.discordChannels().then(setChannels).catch(() => {});
  }, [status.discord]);

  const toggle = (id: string) => run(async () => {
    const next = cfg.discord.watch.includes(id) ? cfg.discord.watch.filter((x) => x !== id) : [...cfg.discord.watch, id];
    await api.setDiscordWatch(next);
    onChange();
  });

  const q = search.toLowerCase();
  const shown = channels.filter((c) => !q || c.name.toLowerCase().includes(q) || c.guildName.toLowerCase().includes(q));
  const groups = new Map<string, DiscordChannel[]>();
  for (const c of shown) (groups.get(c.guildName) ?? groups.set(c.guildName, []).get(c.guildName)!).push(c);

  return (
    <section>
      <h2>Discord</h2>
      <div className="hint">{cfg.discord.hasToken ? 'Token saved.' : 'Paste your Discord user token (DevTools → Network → any request → Authorization header).'}</div>
      <input type="password" placeholder="user token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button className="primary" disabled={busy || !token} onClick={() => run(async () => { await api.setDiscordToken(token); setToken(''); onChange(); })}>
        Save token &amp; connect
      </button>
      {err && <div className="err">{err}</div>}
      {status.discord === 'connected' && (
        <>
          <input placeholder="search channels…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="picker">
            {[...groups.entries()].map(([g, chs]) => (
              <div key={g}>
                <div className="group">{g}</div>
                {chs.map((c) => (
                  <label key={c.id}>
                    <input type="checkbox" checked={cfg.discord.watch.includes(c.id)} onChange={() => toggle(c.id)} /> #{c.name}
                  </label>
                ))}
              </div>
            ))}
            {channels.length === 0 && <div className="hint">Waiting for channel list…</div>}
          </div>
          <div className="hint">{cfg.discord.watch.length} channel(s) watched</div>
        </>
      )}
    </section>
  );
}

function TelegramSection({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [apiId, setApiId] = useState(cfg.telegram.apiId ? String(cfg.telegram.apiId) : '');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [search, setSearch] = useState('');
  const { busy, err, run } = useAsync();

  useEffect(() => {
    if (status.telegram === 'connected') api.telegramDialogs().then(setDialogs).catch(() => {});
  }, [status.telegram]);

  const toggle = (id: string) => run(async () => {
    const next = cfg.telegram.watch.includes(id) ? cfg.telegram.watch.filter((x) => x !== id) : [...cfg.telegram.watch, id];
    await api.setTelegramWatch(next);
    onChange();
  });

  const q = search.toLowerCase();
  const shown = dialogs.filter((d) => !q || d.title.toLowerCase().includes(q));
  const hasCreds = cfg.telegram.apiId && cfg.telegram.hasApiHash;

  return (
    <section>
      <h2>Telegram</h2>
      {!hasCreds && <div className="hint">Get an API ID and hash at my.telegram.org → API development tools.</div>}
      <input placeholder="api id" value={apiId} onChange={(e) => setApiId(e.target.value)} />
      <input type="password" placeholder={cfg.telegram.hasApiHash ? 'api hash (saved)' : 'api hash'} value={apiHash} onChange={(e) => setApiHash(e.target.value)} />
      <button disabled={busy || !apiId || !apiHash} onClick={() => run(async () => { await api.setTelegramCreds(Number(apiId), apiHash); setApiHash(''); onChange(); })}>
        Save credentials
      </button>

      {hasCreds && status.telegram === 'needs_login' && status.loginStep === 'idle' && (
        <>
          <input placeholder="phone, e.g. +15551234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="primary" disabled={busy || !phone} onClick={() => run(() => api.tgStart(phone))}>Send code</button>
        </>
      )}
      {status.loginStep === 'code' && (
        <>
          <input placeholder="login code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" disabled={busy || !code} onClick={() => run(async () => { await api.tgCode(code); setCode(''); })}>Submit code</button>
        </>
      )}
      {status.loginStep === 'password' && (
        <>
          <input type="password" placeholder="2FA password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="primary" disabled={busy || !password} onClick={() => run(async () => { await api.tgPassword(password); setPassword(''); })}>Submit password</button>
        </>
      )}
      {err && <div className="err">{err}</div>}

      {status.telegram === 'connected' && (
        <>
          <input placeholder="search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="picker">
            {shown.map((d) => (
              <label key={d.id}>
                <input type="checkbox" checked={cfg.telegram.watch.includes(d.id)} onChange={() => toggle(d.id)} /> {d.title} <span className="hint">({d.type})</span>
              </label>
            ))}
            {dialogs.length === 0 && <div className="hint">Loading chats…</div>}
          </div>
          <div className="hint">{cfg.telegram.watch.length} chat(s) watched</div>
          <button disabled={busy} onClick={() => run(async () => { await api.tgLogout(); onChange(); })}>Log out</button>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck, build, commit**

Run: `npm run build -w frontend`
Expected: builds clean.

```bash
git add frontend/src/components/Settings.tsx
git commit -m "feat: settings drawer with token entry, telegram login wizard, channel pickers"
```

---

### Task 12: README and manual end-to-end test

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.md**

```markdown
# trenchfeed

One live feed for your Discord channels and Telegram chats, with contract
addresses highlighted and copyable. Runs entirely on your machine.

> Discord side uses your **own account token** (a self-bot). That is against
> Discord's Terms of Service and can get the account banned. Use at your own
> risk. The Telegram side uses your own account via the official MTProto API,
> which Telegram permits.

## Run

```bash
npm install
npm run build
npm start          # http://127.0.0.1:3210
```

Dev mode with hot reload (`http://localhost:5173`):

```bash
npm run dev
```

## Setup (in the browser, ⚙ top right)

1. **Discord** — paste your user token, save. Then tick the channels to watch.
2. **Telegram** — enter API ID + hash from https://my.telegram.org, save.
   Enter phone → code → 2FA password if prompted. Then tick chats to watch.

Everything is stored in `backend/config.json` (git-ignored, mode 600).

## Tests

```bash
npm test
```
```

- [ ] **Step 2: Manual test**

Run: `cd /Users/moussaboussi/projects/trenchfeed && npm run build && npm start`
Then open http://127.0.0.1:3210 and:
1. Paste Discord token → pill turns green, channel list appears. Tick one active channel. Messages appear with DC badge.
2. Enter Telegram creds → phone → code (→ password). Pill turns green, dialogs appear. Tick one. Messages appear with TG badge.
3. Post a Solana CA and an EVM CA in a watched channel → chips appear, click copies.
4. Toggle "contracts only", type in filter.
5. Reload the page → buffer replays.
6. Enter a wrong Discord token → red banner "Discord rejected the token", no reconnect loop in the server log.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with setup and ToS warning"
```
