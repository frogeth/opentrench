import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordGateway, type DiscordChannel } from './discord/gateway.js';
import { discordReaction, normalizeDiscord } from './discord/normalize.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';
import { extractLinks, type ExtractedMeta } from './links.js';
import { createPreviewer, type Previewer } from './previews.js';
import { fetchChannelHistory, reactMessage, sendChannelMessage } from './discord/rest.js';
import { detectContracts } from './contracts.js';
import type { FeedMessage, Reaction } from './types.js';

export class Services {
  discord?: DiscordGateway;
  telegram?: TelegramWrapper;
  private discordChannels = new Map<string, DiscordChannel>();
  private previewer: Previewer;

  constructor(
    private cfg: ConfigStore,
    private hub: MessageHub,
    previewer?: Previewer,
  ) {
    this.previewer = previewer ?? createPreviewer();
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

  // ---- Discord ----

  startDiscord(): void {
    this.discord?.stop();
    this.discord = undefined;
    this.discordChannels.clear();
    const token = this.cfg.get().discord.token;
    if (!token) {
      this.hub.setStatus('discord', 'disconnected');
      return;
    }
    const gw = new DiscordGateway(token);
    gw.on('state', (s, err) => this.hub.setStatus('discord', s, err));
    gw.on('channels', (chs: DiscordChannel[]) => {
      for (const c of chs) this.discordChannels.set(c.id, c);
    });
    gw.on('message', (d) => {
      const id = String(d.channel_id);
      if (!this.cfg.get().discord.watch.includes(id)) return;
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildId: '?', guildName: '?', position: 0 };
      try {
        const msg = normalizeDiscord(d, ch);
        this.hub.push(msg, extractLinks(msg.text, []));
        this.addPreviews(msg);
      } catch (e) {
        console.warn('[discord] dropped message', e);
      }
    });
    gw.on('reaction', (d, delta: number) => {
      if (!this.cfg.get().discord.watch.includes(String(d.channel_id))) return;
      this.hub.applyReactionDelta(`discord:${d.message_id}`, discordReaction(d.emoji), delta);
    });
    gw.connect();
    this.discord = gw;
  }

  /** Recent messages of any chat (newest first) without adding it to the feed. Not persisted. */
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
      const token = this.cfg.get().discord.token;
      if (!token) throw new Error('discord not connected');
      const d = await sendChannelMessage(token, chatId, text, replyTo);
      // echo into the feed now; the gateway's own copy is deduplicated by id
      if (d?.id && this.cfg.get().discord.watch.includes(chatId)) {
        const ch = this.discordChannels.get(chatId) ?? { id: chatId, name: chatId, guildId: '?', guildName: '?', position: 0 };
        try {
          const msg = normalizeDiscord(d, ch);
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
      const token = this.cfg.get().discord.token;
      if (!token) throw new Error('discord not connected');
      const emoji = key.startsWith('custom:') ? `${name}:${key.slice(7)}` : key;
      await reactMessage(token, chatId, msgId, emoji, on);
      return;
    }
    if (!this.telegram) throw new Error('telegram not connected');
    if (key.startsWith('custom:')) throw new Error('custom emoji reactions need Telegram Premium');
    await this.telegram.react(chatId, Number(msgId), key, on);
  }

  async preview(source: 'discord' | 'telegram', id: string, limit = 50): Promise<FeedMessage[]> {
    let msgs: FeedMessage[] = [];
    if (source === 'discord') {
      const token = this.cfg.get().discord.token;
      if (!token) return [];
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildId: '?', guildName: '?', position: 0 };
      const raw = await fetchChannelHistory(token, id, limit);
      msgs = raw.map((d) => normalizeDiscord(d, ch));
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
