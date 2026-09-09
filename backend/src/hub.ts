import { EventEmitter } from 'node:events';
import { detectContracts } from './contracts.js';
import type { TokenFetcher } from './enrich.js';
import { buildCoveLinks, type CoveOptions } from './cove.js';
import type { ExtractedMeta } from './links.js';
import type {
  DiscordState,
  FeedMessage,
  LoginStep,
  Reaction,
  ServerEvent,
  Source,
  Status,
  TelegramState,
  TokenInfo,
} from './types.js';

const META_KEYS = ['website', 'twitter', 'telegram', 'name', 'symbol'] as const;
const DATA_KEYS = ['priceUsd', 'marketCap', 'liquidity', 'change24h', 'imageUrl', 'network', 'pairAddress', 'chartUrl', 'embedUrl', 'explorerUrl'] as const;
const MAX_TOKENS = 2000;
/** Re-fetch a token that came back without a price (fresh pair not indexed yet). */
const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000];

export class MessageHub extends EventEmitter {
  private buffer: FeedMessage[] = [];
  private tokens = new Map<string, TokenInfo>();
  /** address -> chat ids that have posted it */
  private tokenChats = new Map<string, Set<string>>();
  private status: Status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {} };

  private retryDelays: number[];
  private cove: () => CoveOptions;

  constructor(
    private cap = 500,
    private fetcher?: TokenFetcher,
    opts: { retryDelaysMs?: number[]; cove?: () => CoveOptions } = {},
  ) {
    super();
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.cove = opts.cove ?? (() => ({ amounts: [25, 50, 100] }));
  }

  /** Rebuild every token's buy links (after the Cove settings change). */
  recomputeBuyLinks(): void {
    for (const t of this.tokens.values()) {
      this.applyBuy(t);
      this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    }
  }

  private applyBuy(t: TokenInfo): void {
    const network = t.network ?? (t.chain === 'sol' ? 'solana' : undefined);
    t.buy = buildCoveLinks(network, t.address, this.cove());
  }

  push(msg: FeedMessage, meta?: ExtractedMeta): void {
    msg.contracts = detectContracts(msg.text);
    let anyNew = false;
    for (const c of msg.contracts) {
      let t = this.tokens.get(c.address);
      if (!t) {
        t = {
          chain: c.chain,
          address: c.address,
          seen: 0,
          calledIn: [],
          firstSeenTs: msg.ts,
          firstCaller: {
            author: msg.author,
            avatar: msg.avatar,
            chatName: msg.chatName,
            source: msg.source,
            msgId: msg.id,
            link: msg.link,
            ts: msg.ts,
          },
        };
        this.applyBuy(t);
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

  /** Replace a buffered message's reactions (Telegram sends full counts). */
  setReactions(msgId: string, reactions: Reaction[]): void {
    const m = this.buffer.find((x) => x.id === msgId);
    if (!m) return;
    m.reactions = reactions.filter((r) => r.count > 0);
    this.emit('event', { type: 'reactions', msgId, reactions: m.reactions } satisfies ServerEvent);
  }

  /** Adjust one reaction's count (Discord sends add/remove deltas). */
  applyReactionDelta(msgId: string, reaction: Omit<Reaction, 'count'>, delta: number): void {
    const m = this.buffer.find((x) => x.id === msgId);
    if (!m) return;
    const list = m.reactions ?? [];
    const existing = list.find((r) => r.key === reaction.key);
    if (existing) existing.count += delta;
    else if (delta > 0) list.push({ ...reaction, count: delta });
    m.reactions = list.filter((r) => r.count > 0);
    this.emit('event', { type: 'reactions', msgId, reactions: m.reactions } satisfies ServerEvent);
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

  private enrich(t: TokenInfo, attempt = 0): void {
    if (!this.fetcher) return;
    this.fetcher(t.address, t.chain)
      .then((info) => {
        const live = this.tokens.get(t.address);
        if (!live) return;
        if (info) {
          for (const k of DATA_KEYS) if (info[k] !== undefined) (live as any)[k] = info[k];
          for (const k of META_KEYS) if (info[k] && !live[k]) live[k] = info[k];
          this.applyBuy(live);
          this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
        }
        if (live.priceUsd === undefined && attempt < this.retryDelays.length) {
          setTimeout(() => this.enrich(t, attempt + 1), this.retryDelays[attempt]);
        }
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
