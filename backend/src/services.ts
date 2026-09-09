import type { ConfigStore } from './config.js';
import type { MessageHub } from './hub.js';
import { DiscordGateway, type DiscordChannel } from './discord/gateway.js';
import { normalizeDiscord } from './discord/normalize.js';
import { TelegramWrapper, type TelegramDialog } from './telegram/client.js';
import { extractLinks, type ExtractedMeta } from './links.js';
import type { FeedMessage } from './types.js';

export class Services {
  discord?: DiscordGateway;
  telegram?: TelegramWrapper;
  private discordChannels = new Map<string, DiscordChannel>();

  constructor(
    private cfg: ConfigStore,
    private hub: MessageHub,
  ) {}

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
      const ch = this.discordChannels.get(id) ?? { id, name: id, guildName: '?' };
      try {
        const msg = normalizeDiscord(d, ch);
        this.hub.push(msg, extractLinks(msg.text, []));
      } catch (e) {
        console.warn('[discord] dropped message', e);
      }
    });
    gw.connect();
    this.discord = gw;
  }

  listDiscordChannels(): DiscordChannel[] {
    return [...this.discordChannels.values()].sort(
      (a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name),
    );
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
    });
    this.telegram = tg;
    await tg.connect();
  }

  async listTelegramDialogs(): Promise<TelegramDialog[]> {
    return this.telegram?.listDialogs() ?? [];
  }
}
