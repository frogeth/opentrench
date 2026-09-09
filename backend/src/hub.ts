import { EventEmitter } from 'node:events';
import { detectContracts } from './contracts.js';
import type { TokenFetcher } from './dexscreener.js';
import type { ExtractedMeta } from './links.js';
import type {
  DiscordState,
  FeedMessage,
  LoginStep,
  ServerEvent,
  Source,
  Status,
  TelegramState,
  TokenInfo,
} from './types.js';

const META_KEYS = ['website', 'twitter', 'telegram', 'name', 'symbol'] as const;
const MAX_TOKENS = 2000;

export class MessageHub extends EventEmitter {
  private buffer: FeedMessage[] = [];
  private tokens = new Map<string, TokenInfo>();
  /** address -> chat ids that have posted it */
  private tokenChats = new Map<string, Set<string>>();
  private status: Status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {} };

  constructor(
    private cap = 500,
    private fetcher?: TokenFetcher,
  ) {
    super();
  }

  push(msg: FeedMessage, meta?: ExtractedMeta): void {
    msg.contracts = detectContracts(msg.text);
    let anyNew = false;
    for (const c of msg.contracts) {
      let t = this.tokens.get(c.address);
      if (!t) {
        t = { chain: c.chain, address: c.address, seen: 0, calledIn: [], firstSeenTs: msg.ts };
        this.tokens.set(c.address, t);
        this.tokenChats.set(c.address, new Set());
        if (this.tokens.size > MAX_TOKENS) {
          const oldest = this.tokens.keys().next().value!;
          this.tokens.delete(oldest);
          this.tokenChats.delete(oldest);
        }
        this.enrich(t);
      }
      const chats = this.tokenChats.get(c.address)!;
      if (!chats.has(msg.chatId)) {
        chats.add(msg.chatId);
        t.seen = chats.size;
        t.calledIn.push(msg.chatName);
        anyNew = true;
      }
      if (meta) applyMeta(t, meta, msg.isBot);
      this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    }
    msg.repeat = msg.contracts.length > 0 && !anyNew;
    this.buffer.push(msg);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    this.emit('event', { type: 'message', msg } satisfies ServerEvent);
  }

  setStatus(source: 'discord', state: DiscordState, error?: string): void;
  setStatus(source: 'telegram', state: TelegramState, error?: string): void;
  setStatus(source: Source, state: DiscordState | TelegramState, error?: string): void {
    (this.status as Record<Source, string>)[source] = state;
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

  hello(): Extract<ServerEvent, { type: 'hello' }> {
    return {
      type: 'hello',
      status: this.getStatus(),
      messages: [...this.buffer],
      tokens: [...this.tokens.values()].map((t) => ({ ...t })),
    };
  }

  private enrich(t: TokenInfo): void {
    if (!this.fetcher) return;
    this.fetcher(t.address)
      .then((info) => {
        if (!info) return;
        const live = this.tokens.get(t.address);
        if (!live) return;
        for (const k of ['priceUsd', 'marketCap', 'liquidity', 'change24h', 'imageUrl', 'chartUrl'] as const) {
          if (info[k] !== undefined) (live as any)[k] = info[k];
        }
        for (const k of META_KEYS) if (info[k] && !live[k]) live[k] = info[k];
        this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
      })
      .catch((e) => console.warn('[tokens] enrich failed', t.address, e?.message ?? e));
  }

  private emitStatus(): void {
    this.emit('event', { type: 'status', status: this.getStatus() } satisfies ServerEvent);
  }
}

function applyMeta(t: TokenInfo, meta: ExtractedMeta, override: boolean): void {
  for (const k of META_KEYS) {
    const v = meta[k];
    if (!v) continue;
    if (override || !t[k]) t[k] = v;
  }
}
