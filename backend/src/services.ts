import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordGateway, type DiscordChannel } from './discord/gateway.js';
import { discordReaction, normalizeDiscord } from './discord/normalize.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';
import { extractLinks, type ExtractedMeta } from './links.js';
import { createPreviewer, type Previewer } from './previews.js';
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
