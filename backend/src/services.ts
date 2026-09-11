import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordBridge, type DiscordChannel, type DiscordSelf } from './discord/bridge.js';
import { discordReaction, normalizeDiscord } from './discord/normalize.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';
import { extractLinks, type ExtractedMeta } from './links.js';
import { createPreviewer, type Previewer } from './previews.js';
import { J7Client } from './j7.js';
import { createLaunchWatcher } from './deploys.js';
import { detectContracts } from './contracts.js';
import type { FeedMessage, Reaction } from './types.js';

export class Services {
  /** the Vencord plugin inside the user's Discord client */
  readonly discord = new DiscordBridge();
  telegram?: TelegramWrapper;
  j7?: J7Client;
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
      ...(t.buy?.panel ? [`Cove: ${t.buy.panel}`] : []),
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

  // ---- Discord (through the opentrench plugin in the user's own client) ----

  /** Wire the bridge once; called from the constructor. */
  private wireDiscord(): void {
    const b = this.discord;
    b.watch(this.cfg.get().discord.watch); // so the very first hello already gets the list
    b.on('state', (s) => {
      this.hub.setStatus('discord', s, s === 'disconnected' ? 'open Discord with the opentrench plugin enabled' : undefined);
      if (s === 'connected') this.hub.setDiscordUser(b.self?.username);
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
    b.on('message', (d) => {
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
    });
    b.on('reaction', (d, delta: number) => {
      if (!this.cfg.get().discord.watch.includes(String(d.channel_id))) return;
      this.hub.applyReactionDelta(`discord:${d.message_id}`, discordReaction(d.emoji), delta);
    });
  }

  /** Push the watch list to the client (call after the config changes). */
  startDiscord(): void {
    this.discord.watch(this.cfg.get().discord.watch);
    if (this.discord.state === 'disconnected') this.hub.setStatus('discord', 'disconnected', 'open Discord with the opentrench plugin enabled');
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
  botPress(bot: string, msgId: number, data: string) {
    if (!this.telegram) throw new Error('telegram not connected');
    return this.telegram.botPress(bot, msgId, data);
  }

  /** Compose a message as the user. Sending must be enabled per platform in config; the API checks that. */
  async send(source: 'discord' | 'telegram', chatId: string, text: string, replyTo?: string): Promise<void> {
    if (source === 'discord') {
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

  /** React as the user. Discord custom emoji arrive as `custom:<id>` with a name; unicode as-is. */
  async react(source: 'discord' | 'telegram', chatId: string, msgId: string, key: string, name: string, on: boolean): Promise<void> {
    if (source === 'discord') {
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
      if (this.discord.state !== 'connected') return [];
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildId: '?', guildName: '?', position: 0 };
      const raw = await this.discord.request<any[]>('history', { channelId: id, limit });
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
  affiliateId(): string | undefined {
    return this.telegram?.selfId;
  }

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
    tg.on('state', (s, err) => this.hub.setStatus('telegram', s, err));
    tg.on('step', (step) => this.hub.setLoginStep(step));
    tg.on('session', (sess?: string) =>
      this.cfg.update((c) => {
        c.telegram.session = sess;
      }),
    );
    tg.on('message', (m: FeedMessage, meta: ExtractedMeta) => {
      if (!this.cfg.get().telegram.watch.includes(m.chatId)) return;
      this.hub.push(m, meta);
      this.addPreviews(m);
    });
    tg.on('reactions', (msgId: string, reactions: Reaction[]) => this.hub.setReactions(msgId, reactions));
    tg.on('self', () => this.hub.recomputeBuyLinks());
    tg.on('bot', (bot: string, msg: import('./types.js').BotMessage) => this.hub.emit('event', { type: 'bot', bot, msg }));
    tg.on('botDelete', (ids: number[]) => this.hub.emit('event', { type: 'botDelete', ids }));
    this.telegram = tg;
    await tg.connect();
  }

  async listTelegramDialogs(): Promise<TelegramDialog[]> {
    return this.telegram?.listDialogs() ?? [];
  }

  /** Every watched chat by display name, for the tab row (even before it has messages). */
  async watchedChats(): Promise<{ id: string; name: string; source: 'discord' | 'telegram'; avatar?: string }[]> {
    const out: { id: string; name: string; source: 'discord' | 'telegram'; avatar?: string }[] = [];
    const cfg = this.cfg.get();
    for (const id of cfg.discord.watch) {
      const ch = this.discordChannels.get(id);
      if (ch) out.push({ id, name: `#${ch.name} (${ch.guildName})`, source: 'discord', avatar: ch.guildIcon });
    }
    if (cfg.telegram.watch.length) {
      const dialogs = await this.listTelegramDialogs().catch(() => [] as TelegramDialog[]);
      for (const d of dialogs)
        if (cfg.telegram.watch.includes(d.id))
          out.push({ id: d.id, name: d.title, source: 'telegram', avatar: `/api/telegram/avatar/${d.id}` });
    }
    return out;
  }
}
