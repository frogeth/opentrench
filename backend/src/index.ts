import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStore } from './config.js';
import { SecretBox, readSecretKey } from './secrets.js';
import { keychainKey } from './keychain.js';
import { MessageHub } from './hub.js';
import { createSecurityBatchFetcher, createSecurityFetcher } from './security.js';
import { createHoverFetchers } from './hover.js';
import { createDefaultEnricher } from './enrich.js';
import { createMarketRefresher } from './refresh.js';
import { createBackfiller } from './backfill.js';
import { fetchOhlcv, gtSlugFor } from './geckoterminal.js';
import { fetchDexscreenerChain } from './dexscreener.js';
import type { TokenInfo } from './types.js';
import { DEFAULT_COVE_AFFILIATE, type CoveOptions } from './cove.js';
import { Services } from './services.js';
import { createApi } from './api.js';
import { allowLocalOrigin, createFeedWss, isLoopbackHost, routeUpgrades } from './ws.js';
import { DiscordBridge } from './discord/bridge.js';
import { StateStore } from './store.js';
import { PluginRegistry } from './plugins/registry.js';
import { PluginState } from './plugins/state.js';
import { ShellLink } from './plugins/shell.js';
import { createPluginsApi } from './plugins/api.js';
import { jsonErrors } from './http.js';
import { createEndpoints } from './onchain/endpoints.js';
import { CHAINS } from './onchain/chains.js';
import { createLivePricer } from './onchain/live.js';
import { createMarketApi } from './onchain/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // backend/ (parent of src/ or dist/)
const PORT = Number(process.env.PORT ?? 3210);
const HOST = '127.0.0.1';

// Tokens, sessions and wallet keys in config.json are sealed at rest. The desktop app hands over
// the key it keeps in the OS keychain; a backend started bare (`npm start`, a checkout the app
// attaches to) keeps one of its own in the OS keychain instead. Only with neither is the file plain.
const configFile = process.env.TRENCHFEED_CONFIG ?? path.join(root, 'config.json');
const fromApp = readSecretKey();
const secretKey = fromApp ?? keychainKey({ blobFile: `${configFile}.key` });
if (!secretKey) console.warn('[backend] no secret key and no OS keychain: tokens and wallet keys in config.json are stored in plain text');
else console.log(`[backend] secrets in config.json sealed with the key from ${fromApp ? 'the desktop app' : 'the OS keychain'}`);
const cfg = new ConfigStore(configFile, new SecretBox(secretKey));
const hub: MessageHub = new MessageHub(150, createDefaultEnricher({ o1ApiKey: () => cfg.get().o1ApiKey }), {
  security: createSecurityFetcher(),
  securityBatch: createSecurityBatchFetcher(),
  // the affiliate is opentrench's own, always
  cove: (): CoveOptions => ({ amounts: cfg.get().cove.amounts, affiliateId: DEFAULT_COVE_AFFILIATE }),
  buy: () => ({ provider: cfg.get().buy.provider }),
  blacklist: () => cfg.get().blacklist,
  bots: () => cfg.get().bots,
  favorites: () => cfg.get().favorites,
});

// Live market numbers, two loops. Fast: every 10s, tokens called in the last hour, Dexscreener
// only (30 per request, its token endpoint allows 300 requests a minute). Full: every minute,
// everything called in the last 24h, with GeckoTerminal as the fallback for pairs Dexscreener
// has not indexed yet (30/min there, so only on the slow loop) and the chain-less lookup for
// tokens whose network is still unknown.
const HOT_REFRESH_MS = 10_000;
const HOT_WINDOW_MS = 60 * 60 * 1000;
const REFRESH_MS = 60_000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Live prices from the pools themselves (Uniswap v2/v3/v4, Pons curves, every Solana AMM and
// curve in the feed): one batched RPC per chain every 3s, for exactly the tokens some screen is
// showing (the app reports them; see onchain/live.ts). Custom RPC > Alchemy key > public endpoint.
const LIVE_TICK_MS = 3_000;
const endpoints = createEndpoints(() => ({ alchemyKey: cfg.get().marketData.alchemyKey, rpc: cfg.get().rpc }), fetch as any, (m) => console.warn('[market]', m));
const pricer = createLivePricer({
  endpoints,
  apply: (addr, info) => hub.updateMarket(addr, info),
  // a quote asset's main pool: Dexscreener as a directory only; the price is then read on-chain
  discover: async (network, address) => (await fetchDexscreenerChain(network, [address])).get(address) ?? (await fetchDexscreenerChain(network, [address])).get(address.toLowerCase()),
  log: (m) => console.warn('[market]', m),
});
void endpoints.probeAlchemy(cfg.get().marketData.alchemyKey).then((st) => {
  if (st.hasKey) console.log(`[market] alchemy serves ${st.chains.length ? st.chains.join(', ') : 'nothing'}${st.error ? ` (${st.error})` : ''}`);
});
setInterval(() => {
  const want = pricer.visible();
  if (!want.size) return;
  const list: TokenInfo[] = [];
  for (const a of want) {
    const t = hub.getToken(a);
    if (t && t.network && t.pairAddress) list.push(t);
  }
  void pricer.refresh(list);
}, LIVE_TICK_MS).unref();
// An API answer with a price marks the price as the API's, so the live pricer knows the market cap
// it sees next is theirs (it keeps its own caps on that source's supply).
const applyMarket = (addr: string, info: Partial<TokenInfo>) => {
  // a token the pools are answering for keeps the on-chain price; the API still fills in the rest
  if (pricer.isLive(addr)) {
    const { priceUsd: _p, marketCap: _m, ...rest } = info;
    hub.updateMarket(addr, rest);
    return;
  }
  hub.updateMarket(addr, info.priceUsd !== undefined ? { ...info, priceSource: 'api', priceAt: Date.now() } : info);
};
const refreshHot = createMarketRefresher(applyMarket, (m) => console.warn('[refresh]', m), { gt: false });
const refreshMarket = createMarketRefresher(applyMarket, (m) => console.warn('[refresh]', m));
// newest calls first so a burst of new tokens never starves the ones people are watching
const byNewest = (list: TokenInfo[]) => list.sort((a, b) => b.lastCallTs - a.lastCallTs);
// TrenchTogether: a friend's machine that is connected keeps its tokens fresh for us, so those skip the loops
const mine = (list: TokenInfo[]) => {
  const live = hub.remoteLive();
  return live.size ? list.filter((t) => !live.has(t.address)) : list;
};
setInterval(() => void refreshHot(byNewest(mine(hub.activeTokens(HOT_WINDOW_MS).filter((t) => t.network)))), HOT_REFRESH_MS).unref();
setInterval(() => void refreshMarket(byNewest(mine(hub.activeTokens(ACTIVE_WINDOW_MS)))), REFRESH_MS).unref();
// Exact market caps at call time: a call lands with the cached number; once its minute candle has
// closed, the real value is read from the pool's 1-minute candles (a few tokens per pass, see backfill.ts).
const backfill = createBackfiller({
  tokens: () => mine(hub.activeTokens(ACTIVE_WINDOW_MS)),
  candles: (token, network, pool, beforeTs, limit) => fetchOhlcv(gtSlugFor(network), pool, '1m', limit, fetch, beforeTs, token),
  apply: (address, updates) => hub.applyCallMarketCaps(address, updates),
  log: (m) => console.warn('[backfill]', m),
});
setInterval(() => void backfill(), 15_000).unref();
// Holder security, near-live: every minute, refresh what is due. Fresh calls (< 1h) refresh
// every minute, < 6h every 5 minutes, < 24h every 30 minutes. EVM chains go out as one
// GoPlus request per chain; Solana is one RugCheck request per token, newest first, 15 per cycle.
const SEC_TIERS: [number, number][] = [
  [60 * 60 * 1000, 55 * 1000],
  [6 * 60 * 60 * 1000, 5 * 60 * 1000 - 5000],
  [24 * 60 * 60 * 1000, 30 * 60 * 1000 - 5000],
];
setInterval(() => {
  const now = Date.now();
  const due: string[] = [];
  let sol = 0;
  for (const t of hub.activeTokens(24 * 60 * 60 * 1000).sort((a, b) => b.lastCallTs - a.lastCallTs)) {
    if (!t.network) continue;
    const age = now - t.lastCallTs;
    const every = SEC_TIERS.find(([maxAge]) => age < maxAge)?.[1];
    if (every === undefined) continue;
    if (t.security && now - t.security.fetchedAt < every) continue;
    if (t.network === 'solana' && ++sol > 15) continue;
    due.push(t.address);
  }
  if (due.length) void hub.refreshSecurity(due);
}, 60 * 1000).unref();
const svc: Services = new Services(cfg, hub);
// the minter signs against the same RPCs the live pricer reads from (custom > Alchemy > public)
svc.rpcOverrides = () => Object.fromEntries(Object.keys(CHAINS).map((n) => [n, endpoints.urlFor(n)?.url]).filter((e): e is [string, string] => !!e[1]));
svc.startJ7();
svc.syncColumnFeeds();
void svc.syncTogether();
// Plugins: one-file, sandboxed feeds the user drops in the plugins folder next to config.json.
const pluginsDir = process.env.TRENCHFEED_PLUGINS ?? path.join(path.dirname(configFile), 'plugins');
const pluginState = new PluginState(path.join(path.dirname(configFile), 'plugins-state.json'));
const plugins = new PluginRegistry(pluginsDir, pluginState, cfg);
plugins.load();
svc.plugins = plugins;
// The desktop app registers itself here (`/api/shell/hello`); a bare backend runs without one.
const shell = new ShellLink();
const hover = createHoverFetchers();
const store = new StateStore(process.env.TRENCHFEED_STATE ?? path.join(root, 'state.json'));
hub.load(store.load());
// A mint that was in flight when the process died is still in flight on the chain: take those jobs
// back so their receipts are still watched and the one-mint-per-wallet guard still holds.
void svc.minter.restore(hub.restoredMintJobs);
hub.on('changed', () => store.schedule(() => hub.snapshot()));
// Desktop app: die with the parent. On Windows a killed/crashed Electron leaves the
// backend (this same exe running as node) orphaned, which then blocks the installer
// ("opentrench cannot be closed") and gets silently re-attached by every later launch.
const parentPid = Number(process.env.TRENCHFEED_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log('[backend] parent gone, exiting');
      store.flush();
      pluginState.flush();
      process.exit(0);
    }
  }, 2000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.flush();
    pluginState.flush();
    process.exit(0);
  });
}

// Safety net: log rather than let an unexpected error take the whole backend down.
process.on('uncaughtException', (e) => console.error('[backend] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[backend] unhandled', e));

const app = express();
// This API drives the trading wallet and is reachable on 127.0.0.1, which a page on the open web can
// still address (a browser sends cross-origin requests there happily, and DNS rebinding turns an
// attacker's hostname into a loopback address). So: the Host must name this machine, and an Origin,
// when the client sends one, must be local. Non-browser clients send no Origin and are allowed.
app.use('/api', (req, res, next) => {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (host && !isLoopbackHost(host)) {
    res.status(403).type('text/plain').send('forbidden: opentrench only answers on localhost');
    return;
  }
  if (!allowLocalOrigin(req)) {
    res.status(403).type('text/plain').send('forbidden: cross-origin request');
    return;
  }
  next();
});
// Which build this backend is: the desktop app compares it with its own before attaching to a
// backend it did not start (a stale one from an older checkout rewrites column types it never knew).
const APP_VERSION =
  process.env.TRENCHFEED_APP_VERSION ??
  (() => {
    try {
      return String(JSON.parse(fs.readFileSync(path.resolve(root, '..', 'electron', 'package.json'), 'utf8')).version ?? 'dev');
    } catch {
      return 'dev';
    }
  })();
// `managed`: started by a desktop app (which may replace it on an update); a checkout's own
// `node dist/index.js` is not, and the app asks before touching it
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, managed: Number.isFinite(parentPid) && parentPid > 0 }));
// Ahead of createApi: whichever json parser runs first parses the body, and a plugin's file or a
// proxied request body is bigger than the 64kb createApi allows its own routes. Both halves of that
// are pinned by 'mounted ahead of a router with a smaller parser' in plugins/api.test.ts.
app.use(
  '/api',
  createPluginsApi(plugins, pluginState, hub, shell, cfg, {
    // The names already spoken for in the user's feed. Plugin chats are left out: those are the
    // names this check is protecting, and a plugin must stay free to post to its own chat again.
    takenChatNames: async () => new Set((await svc.watchedChats()).filter((c) => c.source !== 'plugin').map((c) => c.name)),
  }),
);
app.use('/api', createMarketApi(cfg, endpoints, pricer));
app.use('/api', createApi(cfg, hub, svc, hover, (t) => refreshMarket([t])));

const dist = path.resolve(root, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  // Hashed assets can be cached forever; the HTML shell must never be, or a
  // rebuild keeps showing the old UI until a hard refresh.
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));
  app.get('*', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// Last resort: anything a route throws, and any body the parsers refuse, answers as JSON rather than
// Express's HTML page with the stack in it. A response already on the wire goes back to Express.
app.use(jsonErrors('[backend]'));

const server = http.createServer(app);
routeUpgrades(server, {
  '/ws': { wss: createFeedWss(hub), allow: allowLocalOrigin },
  '/bridge': { wss: svc.discord.wss, allow: DiscordBridge.allowOrigin },
});

// A backend that cannot bind its port must not linger as a headless process with live Discord and
// Telegram sessions (the uncaughtException logger below would otherwise keep it alive): exit, loudly.
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(`[backend] cannot listen on ${HOST}:${PORT}: ${e.code ?? e.message} — is another opentrench backend running?`);
  store.flush();
  pluginState.flush();
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`opentrench listening on http://${HOST}:${PORT}`);
  svc.startDiscord();
  void svc.startTelegram();
});
