import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordBridge, type DiscordChannel, type DiscordSelf } from './discord/bridge.js';
import { DiscordGateway } from './discord/gateway.js';
import { fetchChannelHistory } from './discord/rest.js';
import { discordReaction, normalizeDiscord } from './discord/normalize.js';
import { buildOptions, type SlashCommand } from './discord/slash.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';
import { isWatched } from './telegram/ids.js';
import { extractLinks, type ExtractedMeta } from './links.js';
import { createPreviewer, type Previewer } from './previews.js';
import { J7Client } from './j7.js';
import { MintGoClient } from './mintgo.js';
import os from 'node:os';
import { RankingsPoller, keyFor } from './opensea/rankings.js';
import { TOGETHER_PORT, TogetherDiscovery, TogetherGuest, TogetherHost, encodePairing, lanAddresses, newCode, newToken, pollPairing, requestPairing } from './together.js';
import { RoomsManager } from './rooms/manager.js';
import { Minter } from './opensea/minter.js';
import { createLaunchWatcher } from './deploys.js';
import { detectContracts } from './contracts.js';
import type { FeedMessage, Reaction, Source } from './types.js';
import type { PluginRegistry } from './plugins/registry.js';

/** the sharing port: fixed, except a second instance on one machine (a test bench) may pick another */
const togetherPort = (): number => Number(process.env.TRENCHFEED_TOGETHER_PORT) || TOGETHER_PORT;

/** Break a long message at line ends (then spaces) so every piece fits Discord's limit. */
export function splitForDiscord(text: string, max = 2000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** one row of the composer's "/" menu */
export interface SlashMenuItem {
  name: string;
  description: string;
  /** the bot or application it belongs to */
  app?: string;
  icon?: string;
  /** what goes into the box when picked */
  fill: string;
  /** Discord: the command id; its options give the signature */
  id?: string;
  options?: import('./discord/slash.js').SlashOption[];
}

export class Services {
  /** the Vencord plugin inside the user's Discord client: reads and writes */
  readonly discord = new DiscordBridge();
  /** legacy read-only session with a user token; runs only while the plugin is not connected */
  private gateway?: DiscordGateway;
  private gatewayTimer?: NodeJS.Timeout;
  telegram?: TelegramWrapper;
  j7?: J7Client;
  mintgo?: MintGoClient;
  readonly rankings = new RankingsPoller();
  /** the plugin folder registry; index.ts hands it over once it is built */
  plugins?: PluginRegistry;
  // ---------- TrenchTogether ----------
  readonly togetherHost: TogetherHost; // built in the constructor: field initializers run before `hub` is assigned
  readonly discovery: TogetherDiscovery;
  /** relay rooms: one client per room in config, fed from the hub; the routes call it directly */
  readonly rooms: RoomsManager;
  private guests = new Map<string, TogetherGuest>();
  /** this machine's own pairing asks, by request id */
  private outgoing = new Map<string, { id: string; name: string; host: string; port: number; code: string; state: 'pending' | 'approved' | 'denied' | 'failed'; error?: string; timer?: NodeJS.Timeout }>();
  /** Ask a machine heard on the network to follow it; Allow on their side adds the peer here. */
  async followNearby(id: string): Promise<void> {
    const n = this.discovery.list().find((x) => x.id === id);
    if (!n) throw new Error('that machine is not on the network any more');
    if (this.cfg.get().together.peers.some((p) => p.host === n.host && p.port === n.port)) throw new Error(`you already follow ${n.name}`);
    for (const o of this.outgoing.values()) if (o.host === n.host && o.port === n.port && o.state === 'pending') throw new Error(`already asked ${n.name}; waiting for them`);
    const code = newCode();
    const r = await requestPairing(n.host, n.port, this.togetherName(), code);
    const o = { id: r.id, name: r.name || n.name, host: n.host, port: n.port, code, state: 'pending' as const };
    this.outgoing.set(r.id, o);
    this.togetherStatus();
    const started = Date.now();
    const poll = async () => {
      const cur = this.outgoing.get(r.id);
      if (!cur || cur.state !== 'pending') return;
      try {
        const p = await pollPairing(n.host, n.port, r.id);
        if (p.state === 'approved' && p.token) {
          this.cfg.update((c) => {
            c.together.peers = c.together.peers.filter((x) => !(x.host === n.host && x.port === n.port));
            c.together.peers.push({ host: n.host, port: n.port, token: p.token!, name: p.name || cur.name });
          });
          cur.state = 'approved';
          this.togetherStatus();
          await this.syncTogether();
          return;
        }
        if (p.state === 'denied' || p.state === 'gone') {
          cur.state = p.state === 'denied' ? 'denied' : 'failed';
          cur.error = p.state === 'gone' ? 'their machine forgot the request (sharing turned off?)' : undefined;
          this.togetherStatus();
          return;
        }
      } catch (e: any) {
        cur.error = e?.message ?? String(e);
      }
      if (Date.now() - started > 10 * 60_000) {
        cur.state = 'failed';
        cur.error = 'no answer in ten minutes';
        this.togetherStatus();
        return;
      }
      cur.timer = setTimeout(() => void poll(), 2000);
      cur.timer.unref();
    };
    void poll();
  }
  togetherStatusNow(): void {
    this.togetherStatus();
  }
  /** drop one of this machine's asks from the list */
  forgetOutgoing(id: string): void {
    const o = this.outgoing.get(id);
    if (o?.timer) clearTimeout(o.timer);
    this.outgoing.delete(id);
    this.togetherStatus();
  }
  togetherName(): string {
    return this.cfg.get().together.name || os.userInfo().username || os.hostname();
  }
  /** Pairing strings for every address a friend on the LAN could reach this machine on. */
  togetherPairings(): string[] {
    const t = this.cfg.get().together;
    if (!t.share || !t.token) return [];
    return lanAddresses().map((host) => encodePairing({ host, port: togetherPort(), token: t.token, name: this.togetherName() }));
  }
  private togetherStatus(): void {
    this.hub.setTogether({
      nearby: this.discovery.list().map(({ id, name, host, port, version }) => ({ id, name, host, port, version })),
      requests: this.togetherHost.pending().map(({ id, name, from, code, ts }) => ({ id, name, from, code, ts })),
      outgoing: [...this.outgoing.values()].map(({ id, name, host, port, code, state, error }) => ({ id, name, host, port, code, state, error })),
      sharing: this.togetherHost.listening,
      port: togetherPort(),
      clients: this.togetherHost.clients,
      peers: [...this.guests.values()].map((g) => ({ name: g.name, url: g.url, state: g.state, error: g.lastError })),
      rooms: this.rooms.status(),
    });
  }
  /** Dial every friend again now. */
  reconnectPeers(): void {
    for (const g of this.guests.values()) if (g.state !== 'connected') g.reconnect();
    this.togetherStatus();
  }
  /** Start/stop the LAN listener and the friends we follow, from the config. Safe to call repeatedly. */
  async syncTogether(): Promise<void> {
    const t = this.cfg.get().together;
    if (t.share && !t.token) this.cfg.update((c) => (c.together.token = newToken()));
    if (t.share && !this.togetherHost.listening) {
      try {
        await this.togetherHost.start(togetherPort());
        console.log(`[together] sharing calls on port ${togetherPort()}`);
      } catch (e: any) {
        console.warn('[together] cannot listen:', e?.message ?? e);
      }
    } else if (!t.share && this.togetherHost.listening) this.togetherHost.stop();
    const want = new Map(this.cfg.get().together.peers.map((p) => [`${p.host}:${p.port}`, p]));
    for (const [key, g] of this.guests) {
      if (!want.has(key)) {
        g.stop();
        this.guests.delete(key);
      }
    }
    for (const [key, p] of want) {
      const have = this.guests.get(key);
      if (have) {
        // re-pasting a pairing (maybe with a new secret) dials again right away
        if (have.pairing.token !== p.token) {
          have.stop();
          this.guests.delete(key);
        } else {
          if (have.state !== 'connected') have.reconnect();
          continue;
        }
      }
      const g = new TogetherGuest({ host: p.host, port: p.port, token: p.token, name: p.name }, (peer, token) => this.hub.applyRemoteToken(peer, token));
      g.on('state', () => this.togetherStatus());
      this.guests.set(key, g);
      g.start();
    }
    this.hub.remoteLive = () => {
      const s = new Set<string>();
      for (const g of this.guests.values()) if (g.state === 'connected') for (const a of g.live) s.add(a);
      return s;
    };
    // rooms are priced locally, so they add nothing to remoteLive
    this.rooms.sync();
    this.togetherStatus();
  }
  /** RPC per chain for minting: index.ts swaps in the resolver that also knows the Alchemy key (custom > Alchemy > public). */
  rpcOverrides: () => Record<string, string> = () => this.cfg.get().rpc;
  readonly minter = new Minter(() => this.cfg.get().opensea.walletKey, () => this.rpcOverrides());
  private discordSelf?: DiscordSelf;
  private guildRoles = new Map<string, Map<string, string>>();
  /** names for mention markup in one guild */
  private namesIn(guildId: string) {
    return { roles: this.guildRoles.get(guildId), channels: new Map([...this.discordChannels.values()].filter((c) => c.guildId === guildId).map((c) => [c.id, c.name])) };
  }
  /** me, for mention detection in one guild */
  private meIn(guildId: string) {
    return this.discordSelf ? { id: this.discordSelf.id, roles: new Set(this.discordSelf.roles.get(guildId) ?? []) } : undefined;
  }
  private launchWatcher?: ReturnType<typeof createLaunchWatcher>;
  private discordChannels = new Map<string, DiscordChannel>();
  private previewer: Previewer;

  constructor(
    private cfg: ConfigStore,
    private hub: MessageHub,
    previewer?: Previewer,
  ) {
    this.previewer = previewer ?? createPreviewer();
    this.wireDiscord();
    this.rankings.on('rankings', (key, rows, at) => this.hub.emit('event', { type: 'nftRankings', key, rows, at }));
    this.hub.nftState.rankings = () => this.rankings.latest;
    this.minter.on('job', (job) => this.hub.emit('event', { type: 'mintJob', job }));
    this.minter.on('gone', (id: string) => this.hub.emit('event', { type: 'mintJobGone', id }));
    this.hub.nftState.mintJobs = () => this.minter.jobs;
    this.togetherHost = new TogetherHost(hub, { name: () => this.togetherName(), token: () => this.cfg.get().together.token, version: process.env.TRENCHFEED_APP_VERSION ?? 'dev' });
    this.togetherHost.on('clients', () => this.togetherStatus());
    this.togetherHost.on('requests', () => this.togetherStatus());
    this.discovery = new TogetherDiscovery({ name: () => this.togetherName(), port: () => togetherPort(), announce: () => this.togetherHost.listening, version: process.env.TRENCHFEED_APP_VERSION ?? 'dev' });
    this.discovery.on('nearby', () => this.togetherStatus());
    this.rooms = new RoomsManager({
      cfg,
      hub,
      version: process.env.TRENCHFEED_APP_VERSION ?? 'dev',
      name: () => this.togetherName(),
      log: (m) => console.log(`[together] ${m}`),
      onStatus: () => this.togetherStatus(),
    });
    this.discovery.start();
    hub.on('event', (e) => {
      if (e.type === 'ping') void this.ping(e.token, e.msg);
    });
  }

  /** Favorite caller posted a new contract: DM yourself on Telegram (if enabled + connected). */
  private async ping(t: import('./types.js').TokenInfo, m: FeedMessage): Promise<void> {
    if (!this.cfg.get().pingTelegram || !this.telegram) return;
    const label = t.symbol ? `$${t.symbol}` : t.address.slice(0, 6) + '…';
    const lines = [
      `🔔 ${m.author} called ${label} in ${m.chatName}`,
      t.address,
      ...(m.link ? [m.link] : []),
      ...(t.buy?.panel ? [`${t.buy.provider === 'basedbot' ? 'BasedBot' : 'Cove'}: ${t.buy.panel}`] : []),
    ];
    try {
      await this.telegram.sendSelf(lines.join('\n'));
    } catch (e: any) {
      console.warn('[ping] telegram failed', e?.message ?? e);
    }
  }

  /** Fetch tweet previews the platform didn't unfurl, then patch the message. */
  private addPreviews(m: FeedMessage): void {
    const have = (m.previews ?? []).map((p) => p.url);
    this.previewer(m.text, have)
      .then((extra) => {
        if (extra.length) this.hub.patch(m.id, { previews: [...(m.previews ?? []), ...extra] });
      })
      .catch(() => {});
  }

  // ---- Discord ----
  // Two ways in. The Vencord bridge (plugin inside the user's own client) reads and writes.
  // A legacy user token can still READ through our own gateway session for people who have
  // not switched yet; it never sends. When the plugin connects, the token session is closed.

  private onDiscordMessage(d: any): void {
    const id = String(d.channel_id);
    if (!this.cfg.get().discord.watch.includes(id)) return;
    const ch = this.discordChannels.get(id) ?? { id, name: id, guildId: '?', guildName: '?', position: 0 };
    try {
      const msg = normalizeDiscord(d, ch, this.meIn(ch.guildId), this.namesIn(ch.guildId));
      this.hub.push(msg, extractLinks(msg.text, []));
      this.addPreviews(msg);
    } catch (e) {
      console.warn('[discord] dropped message', e);
    }
  }

  private onDiscordReaction(d: any, delta: number): void {
    if (!this.cfg.get().discord.watch.includes(String(d.channel_id))) return;
    const me = this.discord.self?.id;
    this.hub.applyReactionDelta(`discord:${d.message_id}`, discordReaction(d.emoji), delta, !!me && String(d.user_id ?? '') === me);
  }

  /** Wire the bridge once; called from the constructor. */
  private wireDiscord(): void {
    const b = this.discord;
    b.watch(this.cfg.get().discord.watch); // so the very first hello already gets the list
    b.on('state', (s) => {
      if (s === 'connected') {
        this.stopGateway();
        this.hub.setDiscordMode('bridge');
        this.hub.setStatus('discord', 'connected');
        this.hub.setDiscordUser(b.self?.username);
      } else if (s === 'disconnected') {
        this.hub.setDiscordUser(undefined);
        // the plugin went away: fall back to the read-only token session if there is one
        this.startDiscord();
      }
    });
    b.on('self', (me?: DiscordSelf) => {
      this.discordSelf = me;
    });
    b.on('channels', (chs: DiscordChannel[]) => {
      this.discordChannels.clear();
      for (const c of chs) this.discordChannels.set(c.id, c);
    });
    b.on('roles', (guildId: string, roles: Map<string, string>) => {
      this.guildRoles.set(guildId, roles);
    });
    b.on('message', (d) => this.onDiscordMessage(d));
    b.on('reaction', (d, delta: number) => this.onDiscordReaction(d, delta));
  }

  /** Push the watch list to the plugin; without the plugin, run the read-only token session if a token exists. */
  startDiscord(): void {
    this.discord.watch(this.cfg.get().discord.watch);
    if (this.discord.state === 'connected') return;
    const token = this.cfg.get().discord.token;
    if (!token) {
      this.stopGateway();
      this.hub.setDiscordMode('none');
      this.hub.setStatus('discord', 'disconnected', 'open Discord with the opentrench plugin enabled');
      return;
    }
    this.startGateway(token);
  }

  private startGateway(token: string): void {
    if (this.gateway) return; // already running
    if (this.gatewayTimer) clearTimeout(this.gatewayTimer);
    const gw = new DiscordGateway(token);
    gw.on('state', (s, err) => {
      if (this.gateway !== gw) return;
      this.hub.setDiscordMode('token');
      this.hub.setStatus('discord', s, err);
    });
    gw.on('self', (me: DiscordSelf) => {
      this.discordSelf = me;
    });
    gw.on('channels', (chs: DiscordChannel[]) => {
      for (const c of chs) this.discordChannels.set(c.id, c);
    });
    gw.on('roles', (guildId: string, roles: Map<string, string>) => {
      this.guildRoles.set(guildId, roles);
    });
    gw.on('message', (d) => this.onDiscordMessage(d));
    gw.on('reaction', (d, delta: number) => this.onDiscordReaction(d, delta));
    this.gateway = gw;
    gw.connect();
  }

  private stopGateway(): void {
    if (this.gatewayTimer) clearTimeout(this.gatewayTimer);
    this.gatewayTimer = undefined;
    this.gateway?.stop();
    this.gateway = undefined;
  }

  /** Is Discord writable right now? Only through the bridge. */
  private requireBridge(): void {
    if (this.discord.state !== 'connected') throw new Error('Sending on Discord needs the opentrench plugin (Settings → Accounts → Discord). The token is read-only.');
  }

  /** Recent messages of any chat (newest first) without adding it to the feed. Not persisted. */
  /** J7Tracker tweet stream with the account's session id. */
  startJ7(): void {
    this.j7?.stop();
    this.j7 = undefined;
    this.launchWatcher?.stop();
    this.launchWatcher = undefined;
    const token = this.cfg.get().j7.token;
    if (!token) {
      this.hub.setJ7('disconnected');
      return;
    }
    const c = new J7Client(token);
    c.on('state', (s: any, err?: string) => this.hub.setJ7(s, err));
    c.on('tweet', (t: import('./types.js').J7Tweet) => {
      t.contracts = detectContracts(t.text);
      this.hub.emit('event', { type: 'j7', tweet: t });
      if (!t.launches) this.launchWatcher?.matchTweet(t);
    });
    this.j7 = c;
    // pair new pump.fun / Pons launches with the tweets they link, as they happen
    this.launchWatcher = createLaunchWatcher({ tweets: () => c.recent, onMatch: (id, d) => c.attachLaunch(id.replace(/^deleted:/, ''), d) });
    c.start();
    this.launchWatcher.start();
  }
  j7Recent() {
    return (this.j7?.recent ?? []).map((t) => ({ ...t, contracts: detectContracts(t.text) }));
  }

  /** MintGo live mints (no account needed). Started when a MintGo or mint-window column exists, stopped when none does. */
  startMintGo(): void {
    const wanted = this.cfg.get().columns.flatMap((c) => (c.split ? [c, c.split.bottom] : [c])).some((c) => c.type === 'mints' || c.type === 'osmint');
    if (!wanted) {
      this.mintgo?.stop();
      this.mintgo = undefined;
      this.hub.nftState.mints = () => [];
      this.hub.setMintGo('disconnected');
      return;
    }
    if (this.mintgo) return;
    const c = new MintGoClient();
    c.on('state', (s: any, err?: string) => this.hub.setMintGo(s, err));
    c.on('mint', (mint: import('./types.js').MintEvent) => this.hub.emit('event', { type: 'mint', mint }));
    this.mintgo = c;
    this.hub.nftState.mints = () => c.recent;
    c.start();
  }
  mintsRecent() {
    return this.mintgo?.recent ?? [];
  }

  /** OpenSea mint window settings, masked for the UI: wallet presence/address (RPCs live in Settings → Feed → Market data). */
  openseaMasked() {
    const o = this.cfg.get().opensea;
    let walletAddress: string | undefined;
    try {
      walletAddress = this.minter.address();
    } catch {
      walletAddress = undefined;
    }
    return {
      hasWallet: !!o.walletKey,
      walletAddress,
    };
  }

  /** Columns changed: start/stop the feeds that depend on which column types exist. */
  syncColumnFeeds(): void {
    this.startMintGo();
    const cols = this.cfg.get().columns.flatMap((c) => (c.split ? [c, c.split.bottom] : [c]));
    this.rankings.want([...new Set(cols.filter((c) => c.type === 'nftvol').map(keyFor))]);
  }

  /** Conversation with a Telegram bot (Cove) through the user's own session. */
  botHistory(bot: string, limit?: number) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botHistory(bot, limit);
  }
  botStart(bot: string, payload: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botStart(bot, payload);
  }
  botSend(bot: string, text: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botSend(bot, text);
  }
  botCommands(bot: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botCommands(bot);
  }
  botPress(bot: string, msgId: number, data: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botPress(bot, msgId, data);
  }

  private discordCommandCache = new Map<string, { at: number; list: SlashCommand[] }>();
  /**
   * The "/" menu for a chat. Discord: the slash commands usable in that channel, found through the
   * client's own search (cached five minutes per channel and prefix). Telegram: the commands every
   * bot in the chat publishes. One shape for the composer: `fill` is what goes into the box.
   */
  async commands(source: 'discord' | 'telegram', chatId: string, q = ''): Promise<SlashMenuItem[]> {
    const prefix = q.toLowerCase();
    if (source === 'telegram') {
      if (!this.telegram) throw new Error('telegram not connected');
      const list = await this.telegram.chatCommands(chatId);
      return list
        .filter((c) => c.command.toLowerCase().startsWith(prefix))
        .map((c) => ({ name: c.command, description: c.description, app: c.botName, fill: c.dm || !c.bot ? `/${c.command}` : `/${c.command}@${c.bot}` }));
    }
    const list = await this.discordCommands(chatId, prefix);
    return list.map((c) => ({ name: c.name, description: c.description, app: c.app, icon: c.icon, fill: `/${c.name}`, id: c.id, options: c.options }));
  }
  private async discordCommands(chatId: string, prefix: string): Promise<SlashCommand[]> {
    const key = `${chatId}\u0000${prefix}`;
    const hit = this.discordCommandCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
    this.requireBridge();
    const raw: any = await this.discord.request('commands', { channelId: chatId, query: prefix });
    const list: SlashCommand[] = (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
      .map((c) => ({ id: String(c.id), applicationId: String(c.applicationId ?? ''), version: String(c.version ?? ''), name: String(c.name), description: String(c.description ?? ''), options: Array.isArray(c.options) ? c.options : undefined, app: c.app ? String(c.app) : undefined, icon: c.icon ? String(c.icon) : undefined }));
    if (this.discordCommandCache.size > 500) this.discordCommandCache.clear();
    this.discordCommandCache.set(key, { at: Date.now(), list });
    return list;
  }
  /**
   * Run a Discord slash command typed as text: `/name` plus positional arguments. The command is
   * looked up by name in that channel, the arguments mapped onto its options, and the client
   * sends the interaction the way its own composer would.
   */
  async runCommand(chatId: string, name: string, args: string): Promise<void> {
    const lower = name.toLowerCase();
    const found = (await this.discordCommands(chatId, lower)).find((c) => c.name.toLowerCase() === lower);
    if (!found) throw new Error(`no /${name} command here`);
    const options = buildOptions(found.options, args);
    await this.discord.request('command', { channelId: chatId, commandId: found.id, applicationId: found.applicationId, version: found.version, name: found.name, options });
  }

  /**
   * Forward a Telegram message (a chat's, or a bot column's report) into a chat in the feed. To
   * Telegram it is a real forward, formatting and media intact, with the note as a message before
   * it. To Discord it becomes a copy in Discord's own markdown, a small "forwarded from" line on
   * top, the photo attached when there is one, split when it runs past Discord's limit.
   */
  async forward(fromChat: string, msgId: number, to: { source: 'discord' | 'telegram'; chatId: string }, note = ''): Promise<void> {
    if (!this.telegram) throw new Error('telegram not connected');
    if (to.source === 'telegram') {
      if (note) await this.telegram.send(to.chatId, note);
      await this.telegram.forward(fromChat, msgId, to.chatId);
      return;
    }
    this.requireBridge();
    const copy = await this.telegram.copyOf(fromChat, msgId);
    const from = copy.author || (/^-?\d+$/.test(fromChat) ? 'Telegram' : `@${fromChat.replace(/^@/, '')}`);
    const head = `-# forwarded from ${from} on Telegram`;
    const body = [note, head, copy.text].filter(Boolean).join('\n');
    const parts = splitForDiscord(body, 2000);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      const last = i === parts.length - 1;
      if (last && copy.photo) await this.sendFile('discord', to.chatId, copy.photo, parts[i]);
      else await this.send('discord', to.chatId, parts[i]);
    }
    if (parts.length === 0 && copy.photo) await this.sendFile('discord', to.chatId, copy.photo, '');
  }

  /** Compose a message as the user. Sending must be enabled per platform in config; the API checks that. */
  async send(source: 'discord' | 'telegram', chatId: string, text: string, replyTo?: string): Promise<void> {
    if (source === 'discord') {
      this.requireBridge();
      const d: any = await this.discord.request('send', { channelId: chatId, content: text, replyTo });
      // echo into the feed now; the client's own copy is deduplicated by id
      if (d?.id && this.cfg.get().discord.watch.includes(chatId)) {
        const ch = this.discordChannels.get(chatId) ?? { id: chatId, name: chatId, guildId: '?', guildName: '?', position: 0 };
        try {
          const msg = normalizeDiscord(d, ch, undefined, this.namesIn(ch.guildId));
          this.hub.push(msg, extractLinks(msg.text, []));
        } catch (e: any) {
          console.warn('[discord] could not echo sent message', e?.message ?? e);
        }
      }
      return;
    }
    if (!this.telegram) throw new Error('telegram not connected');
    await this.telegram.send(chatId, text, replyTo ? Number(replyTo) : undefined);
  }

  /** Send an image with an optional caption. Discord goes through the plugin (the client uploads it), Telegram through the session. */
  async sendFile(source: 'discord' | 'telegram', chatId: string, file: { name: string; mime: string; data: Buffer }, caption: string, replyTo?: string): Promise<void> {
    if (source === 'discord') {
      this.requireBridge();
      const d: any = await this.discord.request('sendFile', { channelId: chatId, name: file.name, mime: file.mime, data: file.data.toString('base64'), content: caption, replyTo }, 60_000);
      if (d?.id && this.cfg.get().discord.watch.includes(chatId)) {
        const ch = this.discordChannels.get(chatId) ?? { id: chatId, name: chatId, guildId: '?', guildName: '?', position: 0 };
        try {
          const msg = normalizeDiscord(d, ch, undefined, this.namesIn(ch.guildId));
          this.hub.push(msg, extractLinks(msg.text, []));
        } catch (e: any) {
          console.warn('[discord] could not echo sent file', e?.message ?? e);
        }
      }
      return;
    }
    if (!this.telegram) throw new Error('telegram not connected');
    await this.telegram.sendFile(chatId, file, caption, replyTo ? Number(replyTo) : undefined);
  }

  /** React as the user. Discord custom emoji arrive as `custom:<id>` with a name; unicode as-is. */
  async react(source: 'discord' | 'telegram', chatId: string, msgId: string, key: string, name: string, on: boolean): Promise<void> {
    if (source === 'discord') {
      this.requireBridge();
      const emoji = key.startsWith('custom:') ? { id: key.slice(7), name, animated: false } : { id: null, name: key, animated: false };
      await this.discord.request('react', { channelId: chatId, messageId: msgId, emoji, on });
      return;
    }
    if (!this.telegram) throw new Error('telegram not connected');
    if (key.startsWith('custom:')) throw new Error('custom emoji reactions need Telegram Premium');
    await this.telegram.react(chatId, Number(msgId), key, on);
  }

  async preview(source: 'discord' | 'telegram', id: string, limit = 50): Promise<FeedMessage[]> {
    let msgs: FeedMessage[] = [];
    if (source === 'discord') {
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildId: '?', guildName: '?', position: 0 };
      const token = this.cfg.get().discord.token;
      let raw: any[] = [];
      if (this.discord.state === 'connected') raw = await this.discord.request<any[]>('history', { channelId: id, limit });
      else if (token) raw = await fetchChannelHistory(token, id, limit);
      else return [];
      msgs = (Array.isArray(raw) ? raw : []).map((d) => normalizeDiscord(d, ch, this.meIn(ch.guildId), this.namesIn(ch.guildId)));
    } else {
      msgs = (await this.telegram?.history(id, limit)) ?? [];
    }
    for (const m of msgs) {
      m.contracts = detectContracts(m.text);
      m.isBot = m.isBot || this.hub.isBlacklisted(m.author);
    }
    return msgs;
  }

  listDiscordChannels(): DiscordChannel[] {
    return [...this.discordChannels.values()].sort(
      (a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name),
    );
  }

  /** Cove affiliate = the logged-in Telegram account, same id used in the user's other bots. */

  // ---- Telegram ----

  async startTelegram(): Promise<void> {
    await this.telegram?.stop();
    this.telegram = undefined;
    const { apiId, apiHash, session } = this.cfg.get().telegram;
    if (!apiId || !apiHash) {
      this.hub.setStatus('telegram', 'disconnected');
      return;
    }
    const tg = new TelegramWrapper(apiId, apiHash, session);
    tg.watchList = () => this.cfg.get().telegram.watch;
    tg.on('state', (s, err) => this.hub.setStatus('telegram', s, err));
    tg.on('step', (step) => this.hub.setLoginStep(step));
    tg.on('session', (sess?: string) =>
      this.cfg.update((c) => {
        c.telegram.session = sess;
      }),
    );
    tg.on('message', (m: FeedMessage, meta: ExtractedMeta) => {
      // channels/supergroups can arrive as -100<id>, bare <id> or -<id>: match every shape
      if (!isWatched(this.cfg.get().telegram.watch, m.chatId)) return;
      this.hub.push(m, meta);
      this.addPreviews(m);
    });
    tg.on('reactions', (msgId: string, reactions: Reaction[]) => this.hub.setReactions(msgId, reactions));
    tg.on('self', () => {
      this.hub.setTelegramUser(tg.selfUsername);
      this.hub.recomputeBuyLinks();
    });
    tg.on('bot', (bot: string, msg: import('./types.js').BotMessage) => this.hub.emit('event', { type: 'bot', bot, msg }));
    tg.on('botDelete', (ids: number[]) => this.hub.emit('event', { type: 'botDelete', ids }));
    this.telegram = tg;
    await tg.connect();
  }

  resolveTelegram(username: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.resolveChat(username);
  }

  async listTelegramDialogs(): Promise<TelegramDialog[]> {
    return this.telegram?.listDialogs() ?? [];
  }

  /** Every watched chat by display name, for the tab row (even before it has messages). */
  /**
   * People matching `q` who have not necessarily posted: Discord members the client has cached
   * (needs a current opentrench plugin; older ones just return nothing) and Telegram participants
   * of the watched chats. Names match what the feed would show, so favorites line up.
   */
  async searchMembers(q: string, limit = 12): Promise<{ name: string; avatar?: string; source: 'discord' | 'telegram'; chat: string }[]> {
    const query = q.trim();
    if (!query) return [];
    const out: { name: string; avatar?: string; source: 'discord' | 'telegram'; chat: string }[] = [];
    if (this.discord.state === 'connected') {
      const rows = await this.discord.request<any[]>('members', { q: query, limit }, 8000).catch(() => []);
      if (Array.isArray(rows)) for (const r of rows) if (r?.name) out.push({ name: String(r.name), avatar: r.avatar ? String(r.avatar) : undefined, source: 'discord', chat: String(r.guild ?? 'Discord') });
    }
    if (this.telegram) {
      const rows = await this.telegram.searchParticipants(query, this.cfg.get().telegram.watch, limit).catch(() => []);
      for (const r of rows) out.push({ name: r.name, source: 'telegram', chat: r.chat });
    }
    return out.slice(0, limit * 2);
  }

  /**
   * Everyone in one watched chat, for browsing. Telegram lists participants directly; Discord
   * returns the members its client has cached for that channel's server (it loads them lazily,
   * so a server you rarely open returns fewer).
   */
  async listMembers(source: 'discord' | 'telegram', chatId: string, limit = 300): Promise<{ name: string; avatar?: string; source: 'discord' | 'telegram' }[]> {
    if (source === 'telegram') {
      const rows = await this.telegram?.listParticipants(chatId, limit).catch(() => []);
      return (rows ?? []).map((r) => ({ name: r.name, source: 'telegram' as const }));
    }
    if (this.discord.state !== 'connected') return [];
    const guildId = this.discordChannels.get(chatId)?.guildId;
    if (!guildId) return [];
    const rows = await this.discord.request<any[]>('members', { guildId, limit }, 10_000).catch(() => []);
    return (Array.isArray(rows) ? rows : []).filter((r) => r?.name).map((r) => ({ name: String(r.name), avatar: r.avatar ? String(r.avatar) : undefined, source: 'discord' as const }));
  }

  async watchedChats(): Promise<{ id: string; name: string; source: Source; avatar?: string }[]> {
    const out: { id: string; name: string; source: Source; avatar?: string }[] = [];
    const cfg = this.cfg.get();
    for (const id of cfg.discord.watch) {
      const ch = this.discordChannels.get(id);
      if (ch) out.push({ id, name: ch.dm ? `${ch.name} (DM)` : `#${ch.name} (${ch.guildName})`, source: 'discord', avatar: ch.dm ? ch.avatar : ch.guildIcon });
    }
    if (cfg.telegram.watch.length) {
      const dialogs = await this.listTelegramDialogs().catch(() => [] as TelegramDialog[]);
      for (const d of dialogs)
        if (isWatched(cfg.telegram.watch, d.id))
          out.push({ id: d.id, name: d.title, source: 'telegram', avatar: `/api/telegram/avatar/${d.id}` });
    }
    // Chats of a disabled plugin stay on the list on purpose: its old messages are still in the buffer,
    // so the columns and pickers that filter by chat need a name for them until the user removes the plugin.
    const pluginChats = new Map<string, string>();
    for (const p of this.plugins?.list() ?? []) for (const [chatId, name] of Object.entries(p.chats)) pluginChats.set(chatId, name);
    for (const chatId of cfg.pluginWatch) {
      const name = pluginChats.get(chatId);
      // a watch key with no plugin behind it any more (uninstalled, or the state file lost it) has no name
      // to show, so it is skipped rather than listed as a blank row; iterating pluginWatch keeps its order
      if (name !== undefined) out.push({ id: chatId, name, source: 'plugin' });
    }
    return out;
  }
}
