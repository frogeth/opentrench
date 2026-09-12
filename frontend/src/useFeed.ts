import { useEffect, useRef, useState } from 'react';
import type { BotMessage, FeedMessage, J7Tweet, Mention, MintEvent, MintJob, NftRanking, RankingKey, ServerEvent, Status, TokenInfo } from './types';

const MAX = 500;

export function useFeed() {
  /** newest first */
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [tokens, setTokens] = useState<Record<string, TokenInfo>>({});
  const [status, setStatus] = useState<Status>({
    discord: 'disconnected',
    telegram: 'disconnected',
    loginStep: 'idle',
    error: {},
    favorites: [],
  });
  const [wsOpen, setWsOpen] = useState(false);
  const [ping, setPing] = useState<Extract<ServerEvent, { type: 'ping' }> | null>(null);
  /** pings: people who mentioned you, with context that keeps filling in */
  const [mentions, setMentions] = useState<Mention[]>([]);
  const markRead = (ids?: string[]) => setMentions((cur) => cur.map((m) => (m.read || (ids && !ids.includes(m.id)) ? m : { ...m, read: true })));
  /** J7Tracker tweets, newest first; updates replace in place */
  const [j7, setJ7] = useState<J7Tweet[]>([]);
  const mergeJ7 = (incoming: J7Tweet[]) =>
    setJ7((cur) => {
      const byId = new Map(cur.map((t) => [t.id, t]));
      for (const t of incoming) byId.set(t.id, t);
      // a deletion re-surfaces the tweet at the top, the way J7 shows it
      const key = (t: J7Tweet) => t.deleted ?? t.ts;
      return [...byId.values()].sort((a, b) => key(b) - key(a)).slice(0, 300);
    });
  /** live bot conversations (Cove), keyed by bot username; newest last, edits replace in place */
  const [botMsgs, setBotMsgs] = useState<Record<string, BotMessage[]>>({});
  const mergeBot = (bot: string, incoming: BotMessage[]) =>
    setBotMsgs((all) => {
      const cur = all[bot] ?? [];
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
      return { ...all, [bot]: [...byId.values()].sort((a, b) => a.id - b.id).slice(-200) };
    });
  /** MintGo mints, newest first; a confirmed row replaces its preview in place */
  const [mints, setMints] = useState<MintEvent[]>([]);
  const upsertMints = (incoming: MintEvent[]) =>
    setMints((cur) => {
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id)).slice(0, 300);
    });
  const [rankings, setRankings] = useState<Partial<Record<RankingKey, { rows: NftRanking[]; at: number }>>>({});
  const [mintJobs, setMintJobs] = useState<MintJob[]>([]);
  const upsertJob = (job: MintJob) => setMintJobs((cur) => (cur.some((j) => j.id === job.id) ? cur.map((j) => (j.id === job.id ? job : j)) : [...cur, job].slice(-100)));
  const boot = useRef<string | null>(null);
  // a burst of mints arrives as one event per tx; buffer them and flush through upsertMints every
  // 200ms so the list (and its sort/dedupe) re-renders once per burst instead of once per event
  const mintBuffer = useRef<MintEvent[]>([]);
  const mintTimer = useRef<number | undefined>(undefined);
  const flushMints = () => {
    window.clearTimeout(mintTimer.current);
    mintTimer.current = undefined;
    if (mintBuffer.current.length === 0) return;
    const pending = mintBuffer.current;
    mintBuffer.current = [];
    upsertMints(pending);
  };

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
        if (ev.type === 'hello') {
          // A different server process may serve a different build: reload rather than run old assets.
          if (boot.current && ev.boot && ev.boot !== boot.current) {
            location.reload();
            return;
          }
          boot.current = ev.boot ?? boot.current;
          setMessages([...ev.messages].reverse());
          setMentions(ev.mentions ?? []);
          setTokens(Object.fromEntries(ev.tokens.map((t) => [t.address, t])));
          setStatus(ev.status);
          mintBuffer.current = [];
          window.clearTimeout(mintTimer.current);
          mintTimer.current = undefined;
          setMints(ev.mints ?? []);
          setRankings(ev.rankings ?? {});
          setMintJobs(ev.mintJobs ?? []);
        } else if (ev.type === 'message') {
          setMessages((m) => [ev.msg, ...m].slice(0, MAX));
        } else if (ev.type === 'token') {
          setTokens((t) => ({ ...t, [ev.token.address]: ev.token }));
        } else if (ev.type === 'tokens') {
          setTokens(Object.fromEntries(ev.tokens.map((t) => [t.address, t])));
        } else if (ev.type === 'msg') {
          setMessages((m) => m.map((x) => (x.id === ev.msgId ? { ...x, ...ev.patch } : x)));
        } else if (ev.type === 'reactions') {
          setMessages((m) => m.map((x) => (x.id === ev.msgId ? { ...x, reactions: ev.reactions } : x)));
        } else if (ev.type === 'j7') mergeJ7([ev.tweet]);
        else if (ev.type === 'mention')
          setMentions((cur) => {
            const old = cur.find((m) => m.id === ev.mention.id);
            const next = { ...ev.mention, read: ev.mention.read || !!old?.read };
            return old ? cur.map((m) => (m.id === next.id ? next : m)) : [...cur, next].slice(-100);
          });
        else if (ev.type === 'bot') mergeBot(ev.bot, [ev.msg]);
        else if (ev.type === 'botDelete') {
          const gone = new Set(ev.ids);
          setBotMsgs((all) => Object.fromEntries(Object.entries(all).map(([b, list]) => [b, list.filter((m) => !gone.has(m.id))])));
        }
        else if (ev.type === 'ping') setPing(ev);
        else if (ev.type === 'status') setStatus(ev.status);
        else if (ev.type === 'mint') {
          mintBuffer.current.push(ev.mint);
          if (mintBuffer.current.length >= 300) flushMints();
          else if (mintTimer.current === undefined) mintTimer.current = window.setTimeout(flushMints, 200);
        }
        else if (ev.type === 'nftRankings') setRankings((r) => ({ ...r, [ev.key]: { rows: ev.rows, at: ev.at } }));
        else if (ev.type === 'mintJob') upsertJob(ev.job);
      };
      ws.onclose = () => {
        setWsOpen(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearTimeout(mintTimer.current);
      ws?.close();
    };
  }, []);

  return { messages, tokens, status, wsOpen, ping, botMsgs, mergeBot, j7, mergeJ7, mentions, markRead, mints, rankings, mintJobs };
}
