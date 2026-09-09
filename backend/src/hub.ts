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
const DATA_KEYS = [
  'priceUsd',
  'marketCap',
  'liquidity',
  'change24h',
  'volume24h',
  'buys24h',
  'sells24h',
  'pairCreatedAt',
  'launchpad',
  'launchpadUrl',
  'imageUrl',
  'network',
  'pairAddress',
  'chartUrl',
  'embedUrl',
  'explorerUrl',
] as const;
const MAX_TOKENS = 2000;
/** Re-fetch a token that came back without a price (fresh pair not indexed yet). */
const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000];
/** After a restart, tokens this young with no price get another enrichment pass. */
const REENRICH_MAX_AGE_MS = 60 * 60 * 1000;

export interface Snapshot {
  version: 1;
  messages: FeedMessage[];
  tokens: TokenInfo[];
  tokenChats: Record<string, string[]>;
}

export interface HubOptions {
  retryDelaysMs?: number[];
  cove?: () => CoveOptions;
  blacklist?: () => string[];
  favorites?: () => string[];
}

function normName(n: string): string {
  return n.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Events: 'event' (ServerEvent for websocket clients), 'changed' (state worth persisting).
 */
export class MessageHub extends EventEmitter {
  private buffer: FeedMessage[] = [];
  private tokens = new Map<string, TokenInfo>();
  /** address -> chat ids that have posted it */
  private tokenChats = new Map<string, Set<string>>();
  private status: Status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {}, favorites: [] };
  private retryDelays: number[];
  private cove: () => CoveOptions;
  private blacklist: () => string[];
  private favorites: () => string[];

  constructor(
    private cap = 500,
    private fetcher?: TokenFetcher,
    opts: HubOptions = {},
  ) {
    super();
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.cove = opts.cove ?? (() => ({ amounts: [25, 50, 100] }));
    this.blacklist = opts.blacklist ?? (() => []);
    this.favorites = opts.favorites ?? (() => []);
  }

  isFavorite(author: string): boolean {
    const name = normName(author);
    return this.favorites().some((f) => normName(f) === name);
  }

  /** Push the favorites list to clients (crowns) after it changes. */
  favoritesChanged(): void {
    this.emitStatus();
  }

  /** Tokens called within `windowMs`, for the market refresh loop. */
  activeTokens(windowMs: number, now = Date.now()): TokenInfo[] {
    return [...this.tokens.values()].filter((t) => now - t.lastCallTs < windowMs);
  }

  /** Live market numbers from the refresh loop; tracks ATH since first call. */
  updateMarket(address: string, info: Partial<TokenInfo>): void {
    const t = this.tokens.get(address);
    if (!t) return;
    for (const k of DATA_KEYS) if (info[k] !== undefined) (t as any)[k] = info[k];
    if (t.marketCap !== undefined) t.athMarketCap = Math.max(t.athMarketCap ?? 0, t.marketCap);
    this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    this.changed();
  }

  // ---------- ingest ----------

  push(msg: FeedMessage, meta?: ExtractedMeta): void {
    msg.contracts = detectContracts(msg.text);
    this.register(msg, meta, true);
    this.buffer.push(msg);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    this.emit('event', { type: 'message', msg } satisfies ServerEvent);
    this.changed();
  }

  isBlacklisted(author: string): boolean {
    const name = normName(author);
    return this.blacklist().some((b) => normName(b) === name);
  }

  /**
   * Update token state for one message. Bots and blacklisted callers are
   * hidden (flagged isBot) and never create or count a call; their links
   * still enrich tokens humans already called.
   */
  private register(msg: FeedMessage, meta: ExtractedMeta | undefined, live: boolean): void {
    const blocked = msg.isBot || this.isBlacklisted(msg.author);
    if (blocked) msg.isBot = true;
    let anyNew = false;
    for (const c of msg.contracts) {
      let t = this.tokens.get(c.address);
      if (!t) {
        if (blocked) continue;
        t = {
          chain: c.chain,
          address: c.address,
          seen: 0,
          calledIn: [],
          firstSeenTs: msg.ts,
          lastCallTs: msg.ts,
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
        if (live) {
          this.enrich(t);
          if (this.isFavorite(msg.author)) this.emit('event', { type: 'ping', token: { ...t }, msg } satisfies ServerEvent);
        }
      }
      const chats = this.tokenChats.get(c.address)!;
      if (!blocked && !chats.has(msg.chatId)) {
        chats.add(msg.chatId);
        t.seen = chats.size;
        t.calledIn.push(msg.chatName);
        t.lastCallTs = Math.max(t.lastCallTs ?? 0, msg.ts);
        anyNew = true;
      }
      if (meta) applyMeta(t, meta, msg.isBot);
      if (live) this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    }
    msg.repeat = msg.contracts.length > 0 && !anyNew;
  }

  /**
   * Re-derive every token from the message buffer (after the blacklist
   * changes). Enrichment and link metadata survive; call counts, first
   * callers and repeat flags are recomputed.
   */
  rebuild(): void {
    const old = this.tokens;
    this.tokens = new Map();
    this.tokenChats = new Map();
    for (const m of this.buffer) this.register(m, undefined, false);
    for (const [addr, t] of this.tokens) {
      const o = old.get(addr);
      if (!o) continue;
      for (const k of DATA_KEYS) if (o[k] !== undefined) (t as any)[k] = o[k];
      for (const k of META_KEYS) if (o[k]) t[k] = o[k];
      this.applyBuy(t);
    }
    this.emit('event', { type: 'tokens', tokens: this.hello().tokens } satisfies ServerEvent);
    this.changed();
  }

  /** Merge late-arriving fields (link previews) into a buffered message. */
  patch(msgId: string, patch: Partial<FeedMessage>): void {
    const m = this.buffer.find((x) => x.id === msgId);
    if (!m) return;
    Object.assign(m, patch);
    this.emit('event', { type: 'msg', msgId, patch } satisfies ServerEvent);
    this.changed();
  }

  // ---------- reactions ----------

  /** Replace a buffered message's reactions (Telegram sends full counts). */
  setReactions(msgId: string, reactions: Reaction[]): void {
    const m = this.buffer.find((x) => x.id === msgId);
    if (!m) return;
    m.reactions = reactions.filter((r) => r.count > 0);
    this.emit('event', { type: 'reactions', msgId, reactions: m.reactions } satisfies ServerEvent);
    this.changed();
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
    this.changed();
  }

  // ---------- status ----------

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
    return { ...structuredClone(this.status), favorites: [...this.favorites()] };
  }

  hello(): Extract<ServerEvent, { type: 'hello' }> {
    return {
      type: 'hello',
      status: this.getStatus(),
      messages: [...this.buffer],
      tokens: [...this.tokens.values()].map((t) => ({ ...t })),
    };
  }

  // ---------- buy links ----------

  /** Rebuild every token's buy links (after the Cove settings change). */
  recomputeBuyLinks(): void {
    for (const t of this.tokens.values()) {
      this.applyBuy(t);
      this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    }
    this.changed();
  }

  private applyBuy(t: TokenInfo): void {
    const network = t.network ?? (t.chain === 'sol' ? 'solana' : undefined);
    t.buy = buildCoveLinks(network, t.address, this.cove());
  }

  // ---------- persistence ----------

  snapshot(): Snapshot {
    return {
      version: 1,
      messages: this.buffer,
      tokens: [...this.tokens.values()],
      tokenChats: Object.fromEntries([...this.tokenChats].map(([a, s]) => [a, [...s]])),
    };
  }

  load(snap: Snapshot | undefined, now = Date.now()): void {
    if (!snap || snap.version !== 1) return;
    this.buffer = (snap.messages ?? []).slice(-this.cap);
    this.tokens = new Map((snap.tokens ?? []).map((t) => [t.address, t]));
    this.tokenChats = new Map(Object.entries(snap.tokenChats ?? {}).map(([a, ids]) => [a, new Set(ids)]));
    for (const t of this.tokens.values()) {
      if (!this.tokenChats.has(t.address)) this.tokenChats.set(t.address, new Set());
      if (t.lastCallTs === undefined) t.lastCallTs = t.firstSeenTs;
      this.applyBuy(t);
      if (t.priceUsd === undefined && now - t.firstSeenTs < REENRICH_MAX_AGE_MS) this.enrich(t);
    }
  }

  private changed(): void {
    this.emit('changed');
  }

  // ---------- enrichment ----------

  private enrich(t: TokenInfo, attempt = 0): void {
    if (!this.fetcher) return;
    this.fetcher(t.address, t.chain)
      .then((info) => {
        const live = this.tokens.get(t.address);
        if (!live) return;
        if (info) {
          for (const k of DATA_KEYS) if (info[k] !== undefined) (live as any)[k] = info[k];
          for (const k of META_KEYS) if (info[k] && !live[k]) live[k] = info[k];
          if (live.marketCap !== undefined) live.athMarketCap = Math.max(live.athMarketCap ?? 0, live.marketCap);
          this.applyBuy(live);
          this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
          this.changed();
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
