import { describe, it, expect, vi } from 'vitest';
import { MessageHub } from './hub.js';
import type { FeedMessage, ServerEvent, TokenInfo } from './types.js';

const EVM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function msg(i: number, text = 'hi', extra: Partial<FeedMessage> = {}): FeedMessage {
  return {
    id: `discord:${i}`,
    source: 'discord',
    chatId: 'c',
    chatName: '#c',
    author: 'a',
    isBot: false,
    text,
    ts: i,
    contracts: [],
    repeat: false,
    hasAttachment: false,
    ...extra,
  };
}

function tokensOf(events: ServerEvent[]): TokenInfo[] {
  return events.filter((e) => e.type === 'token').map((e) => (e as any).token);
}

describe('MessageHub', () => {
  it('detects contracts on push and broadcasts', () => {
    const hub = new MessageHub(10);
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, EVM));
    const m = events.find((e) => e.type === 'message') as any;
    expect(m.msg.contracts).toEqual([{ chain: 'evm', address: EVM }]);
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
      discord: 'auth_error',
      telegram: 'connected',
      loginStep: 'idle',
      error: { discord: 'bad token' },
      favorites: [],
    });
    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
  });

  it('clears the error when a source recovers', () => {
    const hub = new MessageHub();
    hub.setStatus('discord', 'auth_error', 'bad');
    hub.setStatus('discord', 'connected');
    expect(hub.hello().status.error).toEqual({});
  });

  it('counts one call per chat and flags repeats within a chat', () => {
    const hub = new MessageHub();
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, `ca ${EVM}`, { chatId: 'a', chatName: '#a' }));
    hub.push(msg(2, `again ${EVM}`, { chatId: 'a', chatName: '#a' }));
    hub.push(msg(3, `${EVM} and ${SOL}`, { chatId: 'b', chatName: 'B group' }));
    hub.push(msg(4, `${EVM}`, { chatId: 'b', chatName: 'B group' }));
    const msgs = events.filter((e) => e.type === 'message').map((e) => (e as any).msg as FeedMessage);
    expect(msgs.map((m) => m.repeat)).toEqual([false, true, false, true]);
    const toks = tokensOf(events);
    expect(toks.map((t) => [t.address, t.seen])).toEqual([
      [EVM, 1],
      [EVM, 1],
      [EVM, 2],
      [SOL, 1],
      [EVM, 2],
    ]);
    expect(hub.hello().tokens.map((t) => [t.address, t.seen, t.calledIn, t.firstSeenTs, t.lastCallTs])).toEqual([
      [EVM, 2, ['#a', 'B group'], 1, 3],
      [SOL, 1, ['B group'], 3, 3],
    ]);
  });

  it('merges link metadata; bot posts override, humans only fill gaps', () => {
    const hub = new MessageHub();
    hub.push(msg(1, EVM, { isBot: false }), { website: 'https://human.example', name: 'Human' });
    hub.push(msg(2, EVM, { isBot: false }), { website: 'https://other.example', twitter: 'https://x.com/h' });
    let t = hub.hello().tokens[0];
    expect(t).toMatchObject({ website: 'https://human.example', twitter: 'https://x.com/h', name: 'Human' });
    hub.push(msg(3, EVM, { isBot: true }), { website: 'https://rick.example', symbol: 'RCK' });
    t = hub.hello().tokens[0];
    expect(t).toMatchObject({ website: 'https://rick.example', symbol: 'RCK', name: 'Human' });
  });

  it('enriches new tokens through the fetcher without overriding socials', async () => {
    const calls: string[] = [];
    const hub = new MessageHub(500, async (addr) => {
      calls.push(addr);
      return { priceUsd: 1.5, marketCap: 100, website: 'https://dex.example', symbol: 'DEX' };
    });
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, EVM));
    hub.push(msg(2, EVM, { isBot: true }), { website: 'https://rick.example' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([EVM]);
    const t = hub.hello().tokens[0];
    expect(t).toMatchObject({ priceUsd: 1.5, marketCap: 100, website: 'https://rick.example', symbol: 'DEX' });
    expect(tokensOf(events).at(-1)?.priceUsd).toBe(1.5);
  });

  it('retries enrichment while the price is missing, then stops', async () => {
    vi.useFakeTimers();
    try {
      const results = [undefined, { symbol: 'FRESH', network: 'robinhood' }, { priceUsd: 0.5 }];
      const calls: string[] = [];
      const hub = new MessageHub(
        500,
        async (addr, chain) => {
          calls.push(`${addr}:${chain}`);
          return results[calls.length - 1];
        },
        { retryDelaysMs: [1000, 5000] },
      );
      hub.push(msg(1, EVM));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(2);
      expect(hub.hello().tokens[0]).toMatchObject({ symbol: 'FRESH', network: 'robinhood' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(3);
      expect(hub.hello().tokens[0].priceUsd).toBe(0.5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe(`${EVM}:evm`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the first caller and builds Cove links once the chain is known', async () => {
    const hub = new MessageHub(500, async () => ({ network: 'base', priceUsd: 1 }), {
      cove: () => ({ amounts: [50], affiliateId: '7' }),
    });
    hub.push(msg(1, `${SOL} ${EVM}`, { author: 'caller', chatName: '#alpha', avatar: 'a.png' }));
    let [sol, evm] = hub.hello().tokens;
    expect(sol.firstCaller).toMatchObject({ author: 'caller', chatName: '#alpha', avatar: 'a.png', msgId: 'discord:1' });
    expect(sol.buy?.amounts[0]).toMatchObject({ usd: 50 });
    expect(sol.buy?.amounts[0].url).toMatch(/start=g_50s[0-9A-Za-z]{43}[0-9A-Za-z]{14}$/);
    expect(evm.buy).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    [sol, evm] = hub.hello().tokens;
    expect(evm.buy?.panel).toMatch(/start=b_b[0-9A-Za-z]{27}[0-9A-Za-z]{14}$/);
  });

  it('recomputes buy links when Cove settings change', () => {
    let amounts = [25];
    const hub = new MessageHub(500, undefined, { cove: () => ({ amounts }) });
    hub.push(msg(1, SOL));
    expect(hub.hello().tokens[0].buy?.amounts.map((a) => a.usd)).toEqual([25]);
    amounts = [10, 500];
    hub.recomputeBuyLinks();
    expect(hub.hello().tokens[0].buy?.amounts.map((a) => a.usd)).toEqual([10, 500]);
  });

  it('tracks reactions by delta and by replacement, ignoring unknown messages', () => {
    const hub = new MessageHub();
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1));
    hub.applyReactionDelta('discord:1', { key: '🔥', name: '🔥' }, 1);
    hub.applyReactionDelta('discord:1', { key: '🔥', name: '🔥' }, 1);
    hub.applyReactionDelta('discord:1', { key: 'custom:9', name: 'pepe', imageUrl: 'u' }, 1);
    hub.applyReactionDelta('discord:1', { key: '🔥', name: '🔥' }, -1);
    hub.applyReactionDelta('discord:nope', { key: '🔥', name: '🔥' }, 1);
    expect(hub.hello().messages[0].reactions).toEqual([
      { key: '🔥', name: '🔥', count: 1 },
      { key: 'custom:9', name: 'pepe', imageUrl: 'u', count: 1 },
    ]);
    hub.applyReactionDelta('discord:1', { key: '🔥', name: '🔥' }, -1);
    expect(hub.hello().messages[0].reactions).toEqual([{ key: 'custom:9', name: 'pepe', imageUrl: 'u', count: 1 }]);
    hub.setReactions('discord:1', [{ key: '👍', name: '👍', count: 3 }, { key: '❤', name: '❤', count: 0 }]);
    expect(hub.hello().messages[0].reactions).toEqual([{ key: '👍', name: '👍', count: 3 }]);
    expect(events.filter((e) => e.type === 'reactions')).toHaveLength(6);
  });

  it('bots and blacklisted callers never create or count a call, but still feed metadata', () => {
    const hub = new MessageHub(500, undefined, { blacklist: () => ['Rick', '@lanternbot'] });
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.push(msg(1, EVM, { author: 'Rick', chatId: 'a' }), { website: 'https://rick.example' });
    expect(hub.hello().tokens).toEqual([]);
    expect((events.at(-1) as any).msg.isBot).toBe(true);
    hub.push(msg(2, EVM, { author: 'LanternBot', isBot: true, chatId: 'b' }));
    expect(hub.hello().tokens).toEqual([]);
    hub.push(msg(3, EVM, { author: 'human', chatId: 'c', chatName: '#c' }));
    hub.push(msg(4, EVM, { author: '@LanternBot', chatId: 'd' }), { twitter: 'https://x.com/t' });
    const [t] = hub.hello().tokens;
    expect(t).toMatchObject({ seen: 1, calledIn: ['#c'], firstCaller: { author: 'human' }, twitter: 'https://x.com/t' });
    expect(t.website).toBeUndefined();
  });

  it('rebuilds calls from the buffer when the blacklist changes, keeping enrichment', async () => {
    let list: string[] = [];
    const hub = new MessageHub(500, async () => ({ priceUsd: 2, network: 'base' }), { blacklist: () => list });
    hub.push(msg(1, EVM, { author: 'Rick', chatId: 'a', chatName: '#a' }));
    hub.push(msg(2, EVM, { author: 'human', chatId: 'b', chatName: '#b' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.hello().tokens[0]).toMatchObject({ seen: 2, firstCaller: { author: 'Rick' }, priceUsd: 2 });
    list = ['rick'];
    const events: ServerEvent[] = [];
    hub.on('event', (e) => events.push(e));
    hub.rebuild();
    expect(hub.hello().tokens[0]).toMatchObject({ seen: 1, calledIn: ['#b'], firstCaller: { author: 'human' }, priceUsd: 2 });
    expect(hub.hello().messages[0].isBot).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['tokens']);
  });

  it('round-trips a snapshot', () => {
    const hub = new MessageHub(500);
    hub.push(msg(1, `${EVM} ${SOL}`, { chatId: 'a', chatName: '#a' }));
    hub.push(msg(2, EVM, { chatId: 'b', chatName: '#b' }));
    hub.applyReactionDelta('discord:2', { key: '🔥', name: '🔥' }, 1);
    const snap = JSON.parse(JSON.stringify(hub.snapshot()));
    const hub2 = new MessageHub(500);
    hub2.load(snap);
    expect(hub2.hello().messages).toEqual(hub.hello().messages);
    expect(hub2.hello().tokens).toEqual(hub.hello().tokens);
    hub2.push(msg(3, EVM, { chatId: 'b' }));
    expect(hub2.hello().messages.at(-1)?.repeat).toBe(true);
    hub2.push(msg(4, EVM, { chatId: 'c', chatName: '#c' }));
    expect(hub2.hello().tokens[0].seen).toBe(3);
  });

  it('pings when a favorite caller posts a contract for the first time', () => {
    const hub = new MessageHub(500, undefined, { favorites: () => ['@Alpha_Andy'] });
    const pings: any[] = [];
    hub.on('event', (e) => e.type === 'ping' && pings.push(e));
    hub.push(msg(1, EVM, { author: 'nobody', chatId: 'a' }));
    hub.push(msg(2, EVM, { author: 'alpha_andy', chatId: 'b' })); // already called → no ping
    hub.push(msg(3, SOL, { author: 'Alpha_Andy', chatId: 'b' }));
    expect(pings.map((p) => [p.token.address, p.msg.id])).toEqual([[SOL, 'discord:3']]);
    expect(hub.getStatus().favorites).toEqual(['@Alpha_Andy']);
  });

  it('updates market numbers and tracks ATH', () => {
    const hub = new MessageHub(500);
    hub.push(msg(1, EVM));
    hub.updateMarket(EVM, { marketCap: 100, volume24h: 5, buys24h: 3, sells24h: 1 });
    hub.updateMarket(EVM, { marketCap: 250 });
    hub.updateMarket(EVM, { marketCap: 90 });
    expect(hub.hello().tokens[0]).toMatchObject({ marketCap: 90, athMarketCap: 250, volume24h: 5, buys24h: 3, sells24h: 1 });
    expect(hub.activeTokens(60_000, 1000)).toHaveLength(1);
    expect(hub.activeTokens(60_000, 10_000_000)).toHaveLength(0);
  });

  it('survives a failing fetcher', async () => {
    const hub = new MessageHub(500, async () => {
      throw new Error('boom');
    });
    hub.push(msg(1, EVM));
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.hello().tokens[0].seen).toBe(1);
  });
});
