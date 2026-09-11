import { EventEmitter } from 'node:events';
import { detectContracts } from './contracts.js';
import type { TokenFetcher } from './enrich.js';
import type { SecurityBatchFetcher, SecurityFetcher } from './security.js';
import { buildCoveLinks, type CoveOptions } from './cove.js';
import type { ExtractedMeta } from './links.js';
import type {
  BotPolicy,
  BotSeen,
  DiscordState,
  FeedMessage,
  TokenSecurity,
  LoginStep,
  Reaction,
  ServerEvent,
  Source,
  Status,
  TelegramState,
  TokenInfo,
  Mention,
} from './types.js';

/** Identifies this server process; the UI reloads when it changes so a restart with a new build never leaves stale assets. */
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const MENTION_CTX = 4;
const MENTION_MAX = 100;
const MENTION_AFTER_MS = 30 * 60_000;
const MAX_CALLS = 50;
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
  /** holder security lookups (GoPlus / RugCheck); optional */
  security?: SecurityFetcher;
  /** batched refresh of holder security for many tokens of one network */
  securityBatch?: SecurityBatchFetcher;
  /** bot policy: hide all bots except `allow`, or show all bots except the blacklist */
  bots?: () => BotPolicy;
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
  private security?: SecurityFetcher;
  private securityBatch?: SecurityBatchFetcher;
  private botPolicy: () => BotPolicy;
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
    this.security = opts.security;
    this.securityBatch = opts.securityBatch;
    this.botPolicy = opts.bots ?? (() => ({ default: 'hide', allow: [] }));
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

  getToken(address: string): TokenInfo | undefined {
    return this.tokens.get(address) ?? this.tokens.get(address.toLowerCase());
  }

  /** Live market numbers from the refresh loop; tracks ATH since first call. */
  updateMarket(address: string, info: Partial<TokenInfo>): void {
    const t = this.tokens.get(address);
    if (!t) return;
    for (const k of DATA_KEYS) if (info[k] !== undefined) (t as any)[k] = info[k];
    if (t.marketCap !== undefined) t.athMarketCap = Math.max(t.athMarketCap ?? 0, t.marketCap);
    this.noteFirstCallMc(t);
    this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    this.changed();
  }

  // ---------- ingest ----------

  push(msg: FeedMessage, meta?: ExtractedMeta): void {
    if (this.buffer.some((m) => m.id === msg.id)) return; // already have it (e.g. our own send echoed twice)
    msg.contracts = detectContracts(msg.text);
    this.register(msg, meta, true);
    this.buffer.push(msg);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    this.emit('event', { type: 'message', msg } satisfies ServerEvent);
    this.trackMention(msg);
    this.changed();
  }

  // ---------- pings ----------
  private mentionList: Mention[] = [];

  /** A ping gets the 4 messages before it from the same chat; later messages there fill in `after`. */
  private trackMention(msg: FeedMessage, emit = true): void {
    if (msg.mention && !this.isPingMuted(msg)) {
      if (this.mentionList.some((m) => m.id === msg.id)) return;
      const same = this.buffer.filter((m) => m.chatId === msg.chatId && m.source === msg.source && m.id !== msg.id).sort((a, b) => a.ts - b.ts);
      const mention: Mention = {
        id: msg.id,
        msg,
        before: same.filter((m) => m.ts <= msg.ts).slice(-MENTION_CTX),
        after: same.filter((m) => m.ts > msg.ts).slice(0, MENTION_CTX),
        read: false,
      };
      this.mentionList.push(mention);
      if (this.mentionList.length > MENTION_MAX) this.mentionList.splice(0, this.mentionList.length - MENTION_MAX);
      if (emit) this.emit('event', { type: 'mention', mention } satisfies ServerEvent);
      return;
    }
    for (const mention of this.mentionList) {
      const p = mention.msg;
      if (p.chatId !== msg.chatId || p.source !== msg.source || mention.after.length >= MENTION_CTX) continue;
      if (msg.ts <= p.ts || msg.ts - p.ts > MENTION_AFTER_MS || mention.after.some((m) => m.id === msg.id)) continue;
      mention.after.push(msg);
      mention.after.sort((a, b) => a.ts - b.ts);
      if (emit) this.emit('event', { type: 'mention', mention } satisfies ServerEvent);
    }
  }

  mentions(): Mention[] {
    return [...this.mentionList];
  }

  /** Mark pings read; no ids = all of them. */
  markMentionsRead(ids?: string[]): number {
    let n = 0;
    for (const m of this.mentionList) {
      if (m.read || (ids && !ids.includes(m.id))) continue;
      m.read = true;
      n++;
    }
    return n;
  }

  isBlacklisted(author: string): boolean {
    const name = normName(author);
    return this.blacklist().some((b) => normName(b) === name);
  }

  isAllowedBot(author: string): boolean {
    const name = normName(author);
    return this.botPolicy().allow.some((b) => normName(b) === name);
  }

  /** Blacklisted callers, and bots the policy does not allow, are hidden and never count. */
  isHidden(msg: Pick<FeedMessage, 'author' | 'isBot'>): boolean {
    if (this.isBlacklisted(msg.author)) return true;
    if (!msg.isBot) return false;
    return !(this.botPolicy().default === 'show' || this.isAllowedBot(msg.author));
  }

  /** A shown bot whose contract posts should not become calls (policy `calls: 'allow'`, bot not allow-listed). */
  isCallMuted(msg: Pick<FeedMessage, 'author' | 'isBot'>): boolean {
    if (!msg.isBot) return false;
    const p = this.botPolicy();
    return p.default === 'show' && p.calls === 'allow' && !this.isAllowedBot(msg.author);
  }

  /** Bots don't ping you unless the policy says so: every bot, or only the ones on the ping allow list. */
  isPingMuted(msg: Pick<FeedMessage, 'author' | 'isBot'>): boolean {
    if (!msg.isBot) return false;
    const p = this.botPolicy();
    if (p.pings === 'all') return false;
    if (p.pings === 'allow') return !(p.pingAllow ?? []).some((b) => normName(b) === normName(msg.author));
    return true;
  }

  /** Every bot seen in the buffer, newest first, with its current visibility. */
  bots(): BotSeen[] {
    const byName = new Map<string, BotSeen>();
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const m = this.buffer[i];
      if (!m.isBot) continue;
      const key = normName(m.author);
      let b = byName.get(key);
      if (!b) {
        b = { name: m.author, avatar: m.avatar, source: m.source, count: 0, lastTs: m.ts, chats: [], hidden: this.isHidden(m), calls: !this.isHidden(m) && !this.isCallMuted(m), pings: !this.isPingMuted(m) };
        byName.set(key, b);
      }
      b.count++;
      if (!b.chats.includes(m.chatName)) b.chats.push(m.chatName);
    }
    return [...byName.values()];
  }

  /**
   * Update token state for one message. Bots and blacklisted callers are
   * hidden (flagged isBot) and never create or count a call; their links
   * still enrich tokens humans already called.
   */
  private register(msg: FeedMessage, meta: ExtractedMeta | undefined, live: boolean): void {
    msg.hidden = this.isHidden(msg);
    const blocked = msg.hidden || this.isCallMuted(msg);
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
          calls: [],
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
        t.calls.push({
          author: msg.author,
          avatar: msg.avatar,
          chatName: msg.chatName,
          source: msg.source,
          msgId: msg.id,
          link: msg.link,
          ts: msg.ts,
          marketCap: t.marketCap,
        });
        if (t.calls.length > MAX_CALLS) t.calls.splice(0, t.calls.length - MAX_CALLS);
        anyNew = true;
      }
      if (meta) applyMeta(t, meta, blocked);
      if (live) this.emit('event', { type: 'token', token: { ...t } } satisfies ServerEvent);
    }
    msg.repeat = msg.contracts.length > 0 && !anyNew;
  }

  /**
   * Re-derive every token from the message buffer (after the blacklist or
   * bot policy changes). Enrichment and link metadata survive; call counts,
   * first callers, repeat and hidden flags are recomputed, and clients get a
   * fresh hello so hidden rows appear/disappear live.
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
      if (o.security) t.security = o.security;
      if (o.firstCallMarketCap !== undefined) t.firstCallMarketCap = o.firstCallMarketCap;
      for (const c of t.calls) {
        const oc = o.calls?.find((x) => x.msgId === c.msgId);
        if (oc?.marketCap !== undefined) c.marketCap = oc.marketCap;
      }
      this.applyBuy(t);
    }
    this.emit('event', this.hello());
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

  setJ7(state: NonNullable<Status['j7']>, error?: string): void {
    this.status.j7 = state;
    if (error) this.status.error.j7 = error;
    else delete this.status.error.j7;
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
      mentions: this.mentions(),
      boot: BOOT_ID,
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
    for (const m of this.buffer) m.hidden = this.isHidden(m); // policy may have changed since the snapshot
    this.mentionList = [];
    for (const m of [...this.buffer].sort((a, b) => a.ts - b.ts)) if (m.mention) this.trackMention(m, false);
    this.tokens = new Map((snap.tokens ?? []).map((t) => [t.address, t]));
    this.tokenChats = new Map(Object.entries(snap.tokenChats ?? {}).map(([a, ids]) => [a, new Set(ids)]));
    for (const t of this.tokens.values()) {
      if (!this.tokenChats.has(t.address)) this.tokenChats.set(t.address, new Set());
      if (t.lastCallTs === undefined) t.lastCallTs = t.firstSeenTs;
      if (!Array.isArray(t.calls)) t.calls = t.firstCaller ? [{ ...t.firstCaller }] : [];
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
          this.noteFirstCallMc(live);
          this.applyBuy(live);
          this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
          this.changed();
          if (live.network && !live.security) this.fetchSecurity(live);
        }
        if (live.priceUsd === undefined && attempt < this.retryDelays.length) {
          setTimeout(() => this.enrich(t, attempt + 1), this.retryDelays[attempt]);
        }
      })
      .catch((e) => console.warn('[tokens] enrich failed', t.address, e?.message ?? e));
  }

  private lookups = new Map<string, { at: number; p: Promise<TokenInfo | undefined> }>();

  /**
   * Token data for an address nobody has called yet (right-click → Open token): the same
   * enrichment and holder security a call gets, returned once and not tracked. Known tokens
   * come back as-is.
   */
  lookup(raw: string): Promise<TokenInfo | undefined> {
    const c = detectContracts(String(raw ?? ''))[0];
    if (!c) return Promise.resolve(undefined);
    const known = this.tokens.get(c.address);
    if (known) return Promise.resolve({ ...known });
    const hit = this.lookups.get(c.address);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;
    const p = (async () => {
      const now = Date.now();
      const t: TokenInfo = { chain: c.chain, address: c.address, seen: 0, calledIn: [], calls: [], firstSeenTs: now, lastCallTs: 0 };
      const info = this.fetcher ? await this.fetcher(c.address, c.chain).catch(() => undefined) : undefined;
      if (info) {
        for (const k of DATA_KEYS) if (info[k] !== undefined) (t as any)[k] = info[k];
        for (const k of META_KEYS) if (info[k] && !t[k]) t[k] = info[k];
        if (t.marketCap !== undefined) t.athMarketCap = t.marketCap;
        this.applyBuy(t);
      }
      if (this.security && t.network) t.security = await this.security(t.network, t.address).catch(() => undefined);
      return t;
    })();
    this.lookups.set(c.address, { at: Date.now(), p });
    if (this.lookups.size > 200) this.lookups.delete(this.lookups.keys().next().value!);
    return p;
  }

  /** The first call's market cap is whatever the first enrichment after it says. */
  private noteFirstCallMc(t: TokenInfo): void {
    if (t.marketCap === undefined) return;
    const first = t.calls[0];
    if (first && first.marketCap === undefined) first.marketCap = t.marketCap;
    if (t.firstCallMarketCap === undefined) t.firstCallMarketCap = first?.marketCap ?? t.marketCap;
  }

  /** Holder security (top 10, dev, insiders…). Safe to call repeatedly; one in flight per token. */
  fetchSecurity(t: TokenInfo): void {
    if (!this.security || !t.network || this.securityInFlight.has(t.address)) return;
    this.securityInFlight.add(t.address);
    this.security(t.network, t.address)
      .then((sec: TokenSecurity | undefined) => {
        const live = this.tokens.get(t.address);
        if (!live || !sec) return;
        live.security = sec;
        this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
        this.changed();
      })
      .catch((e) => console.warn('[tokens] security failed', t.address, e?.message ?? e))
      .finally(() => this.securityInFlight.delete(t.address));
  }

  private securityInFlight = new Set<string>();

  /** Refresh holder security for many tokens, grouped by network, one batched request per EVM chain. */
  async refreshSecurity(addresses: string[]): Promise<number> {
    if (!this.securityBatch) {
      for (const a of addresses) this.refetchSecurity(a);
      return 0;
    }
    const byNet = new Map<string, string[]>();
    for (const a of addresses) {
      const t = this.tokens.get(a);
      if (!t?.network || this.securityInFlight.has(a)) continue;
      this.securityInFlight.add(a);
      byNet.set(t.network, [...(byNet.get(t.network) ?? []), a]);
    }
    let n = 0;
    for (const [network, list] of byNet) {
      try {
        const got = await this.securityBatch(network, list);
        for (const [a, sec] of got) {
          const live = this.tokens.get(a);
          if (!live) continue;
          live.security = sec;
          n++;
          this.emit('event', { type: 'token', token: { ...live } } satisfies ServerEvent);
        }
        if (got.size) this.changed();
      } catch (e: any) {
        console.warn('[tokens] security batch failed', network, e?.message ?? e);
      } finally {
        for (const a of list) this.securityInFlight.delete(a);
      }
    }
    return n;
  }

  /** Refresh (or first-fetch) holder security for one token, e.g. from the periodic loop. */
  refetchSecurity(address: string): void {
    const t = this.tokens.get(address);
    if (t) this.fetchSecurity(t);
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
