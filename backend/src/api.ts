import { Router, json, type Request, type Response } from 'express';
import type { HoverFetchers } from './hover.js';
import { fetchOhlcv, gtSlugFor } from './geckoterminal.js';

const ohlcvCache = new Map<string, { at: number; v: unknown }>();
const lastSend = new Map<string, number>();
let tickers: { at: number; v: { sym: string; usd: number; change24h: number }[] } | undefined;
import { sanitizeColumns } from './config.js';
import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import type { Services } from './services.js';
import { IpfsCache } from './ipfs.js';
import { createDeployFinder } from './deploys.js';

export function createApi(cfg: ConfigStore, hub: MessageHub, svc: Services, hover?: HoverFetchers): Router {
  const r = Router();
  r.use(json({ limit: '64kb' }));
  const ipfs = new IpfsCache();

  const serveIpfs = async (req: Request, res: Response) => {
    const cid = String(req.params.cid ?? '');
    const rest = (req.params as any)[0];
    const path = rest ? '/' + String(rest) : '';
    if (!/^[A-Za-z0-9]{10,}$/.test(cid)) return res.status(404).end();
    const blob = await ipfs.get(cid, path);
    if (!blob) return res.status(404).end();
    res.setHeader('content-type', blob.mime);
    res.setHeader('cache-control', 'public, max-age=604800, immutable');
    res.send(blob.buf);
  };
  r.get('/ipfs/:cid', serveIpfs);
  r.get('/ipfs/:cid/*', serveIpfs);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (e: any) {
        console.error('[api]', req.method, req.path, e?.message ?? e);
        res.status(500).json({ error: e?.message ?? String(e) });
      }
    };

  r.get('/status', wrap(() => hub.getStatus()));
  r.put(
    '/cove',
    wrap((req) => {
      const amounts = (Array.isArray(req.body?.amounts) ? req.body.amounts : [])
        .map(Number)
        .filter((n: number) => Number.isFinite(n) && n > 0 && n <= 9999)
        .slice(0, 5);
      cfg.update((c) => {
        c.cove.amounts = amounts.length ? amounts : [25, 50, 100];
      });
      hub.recomputeBuyLinks();
    }),
  );
  r.get('/config', wrap(() => cfg.masked()));
  // Header tickers: CoinGecko simple price, cached a minute (free tier is ~30 req/min).
  r.get(
    '/tickers',
    wrap(async () => {
      if (tickers && Date.now() - tickers.at < 60_000) return tickers.v;
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,hyperliquid&vs_currencies=usd&include_24hr_change=true',
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const j: any = await res.json();
      const v = [
        ['BTC', 'bitcoin'],
        ['ETH', 'ethereum'],
        ['SOL', 'solana'],
        ['HYPE', 'hyperliquid'],
      ]
        .filter(([, id]) => j?.[id]?.usd !== undefined)
        .map(([sym, id]) => ({ sym, usd: Number(j[id].usd), change24h: Number(j[id].usd_24h_change ?? 0) }));
      tickers = { at: Date.now(), v };
      return v;
    }),
  );
  // Drill-down chart: candles for the token's main pool, cached briefly (GeckoTerminal is 30 req/min).
  r.get(
    '/token/:address/ohlcv',
    wrap(async (req) => {
      const t = hub.getToken(String(req.params.address));
      if (!t) throw new Error('unknown token');
      if (!t.network || !t.pairAddress) return { candles: [], reason: 'no pool known yet' };
      const interval = /^\d+[mhd]$/.test(String(req.query.interval)) ? String(req.query.interval) : '5m';
      const key = `${t.address}:${interval}`;
      const c = ohlcvCache.get(key);
      if (c && Date.now() - c.at < 30_000) return c.v;
      const candles = await fetchOhlcv(gtSlugFor(t.network), t.pairAddress, interval, 300);
      const v = {
        candles,
        // scale price → market cap with the supply implied by the latest numbers
        mcPerPrice: t.marketCap && t.priceUsd ? t.marketCap / t.priceUsd : undefined,
      };
      if (ohlcvCache.size > 200) ohlcvCache.delete(ohlcvCache.keys().next().value!);
      ohlcvCache.set(key, { at: Date.now(), v });
      return v;
    }),
  );
  // Hover cards: fetched on demand, cached in memory, never stored.
  r.get(
    '/site-preview',
    wrap(async (req) => {
      const url = String(req.query.url ?? '');
      if (!/^https?:\/\//i.test(url) || url.length > 2048) throw new Error('url required');
      return (hover ? await hover.site(url) : undefined) ?? null;
    }),
  );
  r.get(
    '/x-profile/:handle',
    wrap(async (req) => {
      const handle = String(req.params.handle ?? '').replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,20}$/.test(handle)) throw new Error('handle required');
      return (hover ? await hover.xProfile(handle) : undefined) ?? null;
    }),
  );
  r.get('/watched', wrap(() => svc.watchedChats()));
  r.get(
    '/preview/:source/:id',
    wrap((req) => {
      const source = req.params.source === 'telegram' ? 'telegram' : 'discord';
      return svc.preview(source, String(req.params.id), 50);
    }),
  );
  r.put(
    '/blacklist',
    wrap((req) => {
      const raw: unknown[] = Array.isArray(req.body?.names) ? req.body.names : [];
      const names: string[] = raw.map((n) => String(n).trim()).filter(Boolean).slice(0, 500);
      cfg.update((c) => {
        c.blacklist = [...new Set(names)];
      });
      hub.rebuild();
    }),
  );
  r.post(
    '/favorites/toggle',
    wrap((req) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new Error('name required');
      let on = false;
      cfg.update((c) => {
        const i = c.favorites.findIndex((f) => f.toLowerCase() === name.toLowerCase());
        if (i >= 0) c.favorites.splice(i, 1);
        else {
          c.favorites.push(name);
          on = true;
        }
      });
      hub.favoritesChanged();
      return { favorite: on };
    }),
  );
  r.put(
    '/favorites',
    wrap((req) => {
      const raw: unknown[] = Array.isArray(req.body?.names) ? req.body.names : [];
      cfg.update((c) => {
        c.favorites = [...new Set(raw.map((n) => String(n).trim()).filter(Boolean))].slice(0, 500);
      });
      hub.favoritesChanged();
    }),
  );
  // Inbox-style "seen" marks on call cards: add/remove addresses, capped to the newest 3000.
  r.post(
    '/seen',
    wrap((req) => {
      const add: string[] = Array.isArray(req.body?.add) ? req.body.add.map(String).slice(0, 3000) : [];
      const remove = new Set<string>(Array.isArray(req.body?.remove) ? req.body.remove.map(String) : []);
      cfg.update((c) => {
        const next = c.seenTokens.filter((a) => !remove.has(a) && !add.includes(a));
        next.push(...add);
        c.seenTokens = next.slice(-3000);
      });
      return { count: cfg.get().seenTokens.length };
    }),
  );
  r.put(
    '/columns',
    wrap((req) => {
      const cols = sanitizeColumns(req.body?.columns);
      cfg.update((c) => {
        c.columns = cols;
      });
      return cols;
    }),
  );
  r.put(
    '/rail-order',
    wrap((req) => {
      const raw: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      cfg.update((c) => {
        c.railOrder = [...new Set(raw.map(String).filter((x) => /^[gt]:.+/.test(x)))].slice(0, 500);
      });
    }),
  );
  r.put(
    '/o1',
    wrap((req) => {
      const key = String(req.body?.apiKey ?? '').trim();
      cfg.update((c) => {
        c.o1ApiKey = key || undefined;
      });
    }),
  );
  r.put(
    '/pings',
    wrap((req) => {
      cfg.update((c) => {
        c.pingTelegram = !!req.body?.telegram;
      });
    }),
  );
  r.get('/bots', wrap(() => hub.bots()));
  r.put(
    '/bots',
    wrap((req) => {
      const raw: unknown[] = Array.isArray(req.body?.allow) ? req.body.allow : [];
      cfg.update((c) => {
        if (req.body?.default === 'show' || req.body?.default === 'hide') c.bots.default = req.body.default;
        if (req.body?.calls === 'all' || req.body?.calls === 'allow') c.bots.calls = req.body.calls;
        c.bots.allow = [...new Set(raw.map((n) => String(n).trim()).filter(Boolean))].slice(0, 500);
      });
      hub.rebuild();
    }),
  );
  // Show or hide one bot, whatever the default is: showing = allow-list it and drop it from the
  // blacklist; hiding = drop it from the allow list and, when bots show by default, blacklist it.
  r.post(
    '/bots/show',
    wrap((req) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new Error('name required');
      const show = !!req.body?.show;
      const same = (a: string, b: string) => a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();
      cfg.update((c) => {
        c.bots.allow = c.bots.allow.filter((b) => !same(b, name));
        c.blacklist = c.blacklist.filter((b) => !same(b, name));
        if (show && c.bots.default === 'hide') c.bots.allow.push(name);
        if (!show && c.bots.default === 'show') c.blacklist.push(name);
      });
      hub.rebuild();
    }),
  );
  r.post(
    '/blacklist/add',
    wrap((req) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new Error('name required');
      cfg.update((c) => {
        if (!c.blacklist.some((b) => b.toLowerCase() === name.toLowerCase())) c.blacklist.push(name);
      });
      hub.rebuild();
    }),
  );

  // Sending is opt-in per platform. Discord requires the typed acknowledgement of the ToS risk.
  r.put(
    '/discord/send',
    wrap((req) => {
      const enabled = !!req.body?.enabled;
      if (enabled && String(req.body?.confirm ?? '').trim().toLowerCase() !== 'i understand') throw new Error('type "I understand" to enable sending on Discord');
      cfg.update((c) => {
        c.discord.send = enabled;
      });
      return { canSend: enabled };
    }),
  );
  r.put(
    '/telegram/send',
    wrap((req) => {
      const enabled = !!req.body?.enabled;
      cfg.update((c) => {
        c.telegram.send = enabled;
      });
      return { canSend: enabled };
    }),
  );
  r.post(
    '/send',
    wrap(async (req) => {
      const source = req.body?.source === 'telegram' ? 'telegram' : 'discord';
      const chatId = String(req.body?.chatId ?? '').trim();
      const text = String(req.body?.text ?? '').replace(/\r\n/g, '\n').trim();
      const replyTo = req.body?.replyTo ? String(req.body.replyTo) : undefined;
      if (!chatId || !text) throw new Error('chat and text required');
      const c = cfg.get();
      if (source === 'discord' && !c.discord.send) throw new Error('sending on Discord is off (Settings → Accounts)');
      if (source === 'telegram' && !c.telegram.send) throw new Error('sending on Telegram is off (Settings → Accounts)');
      const max = source === 'discord' ? 2000 : 4096;
      if (text.length > max) throw new Error(`too long: ${text.length} / ${max} characters`);
      const watched = source === 'discord' ? c.discord.watch : c.telegram.watch;
      if (!watched.includes(chatId)) throw new Error('you can only send to chats in your feed');
      // one message per second per chat, typed by a human: the app itself never looks like a bot
      const key = `${source}:${chatId}`;
      const last = lastSend.get(key) ?? 0;
      if (Date.now() - last < 1000) throw new Error('slow down — one message per second per chat');
      lastSend.set(key, Date.now());
      await svc.send(source, chatId, text, replyTo);
      return { ok: true };
    }),
  );
  // J7Tracker: session id in, live tweets out.
  r.put(
    '/j7/token',
    wrap((req) => {
      const token = String(req.body?.token ?? '').trim();
      cfg.update((c) => {
        c.j7.token = token || undefined;
      });
      svc.startJ7();
      return { hasToken: !!token };
    }),
  );
  // Pings: who mentioned you, with context
  r.get('/mentions', wrap(() => hub.mentions()));
  r.post(
    '/mentions/read',
    wrap((req) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
      return { marked: hub.markMentionsRead(ids) };
    }),
  );
  r.get('/j7/recent', wrap(() => svc.j7Recent()));
  r.post(
    '/j7/favorites/toggle',
    wrap((req) => {
      const handle = String(req.body?.handle ?? '').replace(/^@/, '').trim().toLowerCase();
      if (!handle) throw new Error('handle required');
      let on = false;
      cfg.update((c) => {
        c.j7.favorites ??= [];
        const i = c.j7.favorites.indexOf(handle);
        if (i >= 0) c.j7.favorites.splice(i, 1);
        else {
          c.j7.favorites.push(handle);
          on = true;
        }
      });
      return { favorite: on, favorites: cfg.get().j7.favorites };
    }),
  );
  // Tokens launched off a tweet: pump.fun and letsbonk metadata that links the tweet or its author.
  const deploys = createDeployFinder();
  r.get(
    '/j7/deploys',
    wrap((req) => {
      const tweetId = String(req.query.id ?? '').trim();
      const handle = String(req.query.handle ?? '').trim();
      const since = Number(req.query.ts);
      if (!/^\d{5,}$/.test(tweetId) || !Number.isFinite(since)) throw new Error('id and ts required');
      return deploys.find({ tweetId, handle, since });
    }),
  );
  // Bot conversations (Cove): the user's own session talks to the bot; the UI renders the panels.
  const BOT_RE = /^[A-Za-z0-9_]{3,32}$/;
  r.get(
    '/bot/:bot/history',
    wrap(async (req) => {
      const bot = String(req.params.bot);
      if (!BOT_RE.test(bot)) throw new Error('bad bot');
      return svc.botHistory(bot, 40);
    }),
  );
  r.post(
    '/bot/:bot/start',
    wrap(async (req) => {
      const bot = String(req.params.bot);
      const payload = String(req.body?.payload ?? '');
      if (!BOT_RE.test(bot) || !/^[A-Za-z0-9_-]{1,64}$/.test(payload)) throw new Error('bad start payload');
      await svc.botStart(bot, payload);
      return { ok: true };
    }),
  );
  r.post(
    '/bot/:bot/send',
    wrap(async (req) => {
      const bot = String(req.params.bot);
      const text = String(req.body?.text ?? '').trim();
      if (!BOT_RE.test(bot) || !text || text.length > 4096) throw new Error('bad message');
      await svc.botSend(bot, text);
      return { ok: true };
    }),
  );
  r.post(
    '/bot/:bot/press',
    wrap(async (req) => {
      const bot = String(req.params.bot);
      const msgId = Number(req.body?.msgId);
      const data = String(req.body?.data ?? '');
      if (!BOT_RE.test(bot) || !Number.isFinite(msgId) || !data) throw new Error('bad press');
      return svc.botPress(bot, msgId, data);
    }),
  );
  r.post(
    '/react',
    wrap(async (req) => {
      const source = req.body?.source === 'telegram' ? 'telegram' : 'discord';
      const chatId = String(req.body?.chatId ?? '').trim();
      const msgId = String(req.body?.msgId ?? '').trim();
      const key = String(req.body?.key ?? '').trim();
      const name = String(req.body?.name ?? '').trim();
      const on = req.body?.on !== false;
      if (!chatId || !msgId || !key) throw new Error('chat, message and emoji required');
      const c = cfg.get();
      if (source === 'discord' && !c.discord.send) throw new Error('sending on Discord is off (Settings → Accounts)');
      if (source === 'telegram' && !c.telegram.send) throw new Error('sending on Telegram is off (Settings → Accounts)');
      const watched = source === 'discord' ? c.discord.watch : c.telegram.watch;
      if (!watched.includes(chatId)) throw new Error('you can only react in chats in your feed');
      const rk = `react:${source}:${chatId}`;
      const last = lastSend.get(rk) ?? 0;
      if (Date.now() - last < 400) throw new Error('slow down');
      lastSend.set(rk, Date.now());
      await svc.react(source, chatId, msgId, key, name, on);
      return { ok: true };
    }),
  );
  r.put(
    '/discord/token',
    wrap((req) => {
      const token = String(req.body?.token ?? '').trim();
      if (!token) throw new Error('token required');
      cfg.update((c) => {
        c.discord.token = token;
      });
      svc.startDiscord();
    }),
  );
  r.get('/discord/channels', wrap(() => svc.listDiscordChannels()));
  r.put(
    '/discord/watch',
    wrap((req) => {
      const ids = (req.body?.ids ?? []).map(String);
      cfg.update((c) => {
        c.discord.watch = ids;
      });
    }),
  );

  r.put(
    '/telegram/credentials',
    wrap(async (req) => {
      const apiId = Number(req.body?.apiId);
      const apiHash = String(req.body?.apiHash ?? '').trim();
      if (!apiId || !apiHash) throw new Error('apiId and apiHash required');
      cfg.update((c) => {
        c.telegram.apiId = apiId;
        c.telegram.apiHash = apiHash;
        c.telegram.session = undefined;
      });
      await svc.startTelegram();
    }),
  );
  r.post(
    '/telegram/login/start',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('set Telegram credentials first');
      const phone = String(req.body?.phone ?? '').trim();
      if (!phone) throw new Error('phone required');
      return { step: await svc.telegram.loginStart(phone) };
    }),
  );
  r.post(
    '/telegram/login/code',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('not started');
      return { step: await svc.telegram.loginCode(String(req.body?.code ?? '').trim()) };
    }),
  );
  r.post(
    '/telegram/login/password',
    wrap(async (req) => {
      if (!svc.telegram) throw new Error('not started');
      return { step: await svc.telegram.loginPassword(String(req.body?.password ?? '')) };
    }),
  );
  r.post(
    '/telegram/logout',
    wrap(async () => {
      await svc.telegram?.logout();
    }),
  );
  r.get('/telegram/dialogs', wrap(() => svc.listTelegramDialogs()));
  r.get('/telegram/media/:chatId/:msgId', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const msgId = Number(req.params.msgId);
    if (!/^-?\d+$/.test(chatId) || !Number.isInteger(msgId) || !svc.telegram) return res.status(404).end();
    const got = await svc.telegram.getMedia(chatId, msgId, req.query.thumb !== undefined);
    if (!got) return res.status(404).end();
    res.setHeader('content-type', got.mime);
    res.setHeader('cache-control', 'private, max-age=86400');
    res.send(got.buf);
  });
  r.get('/telegram/avatar/:id', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!/^-?\d+$/.test(id) || !svc.telegram) return res.status(404).end();
    const buf = await svc.telegram.getAvatar(id);
    if (!buf) return res.status(404).end();
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(buf);
  });
  r.put(
    '/telegram/watch',
    wrap((req) => {
      const ids = (req.body?.ids ?? []).map(String);
      cfg.update((c) => {
        c.telegram.watch = ids;
      });
    }),
  );

  return r;
}
