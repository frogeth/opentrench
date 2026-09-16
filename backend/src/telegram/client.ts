import { EventEmitter } from 'node:events';
import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js';
import { Api } from 'telegram/tl/index.js';
import { getPeerId } from 'telegram/Utils.js';
import { CustomFile } from 'telegram/client/uploads.js';
import type { BotMessage, FeedMessage, LoginStep, TelegramState } from '../types.js';
import { classifyMedia, mapTelegramReactions, normalizeTelegram, webpagePreview, type TelegramPlain, entitiesToMarkdown, entitiesToDiscord } from './normalize.js';
import { extractLinks, type ExtractedMeta, type LinkIn } from '../links.js';
import { canonicalChatId } from './ids.js';

export interface TelegramDialog {
  id: string;
  title: string;
  /** `bot`: a conversation with a bot (a custom alert bot, say), watched like any chat */
  type: 'group' | 'channel' | 'dm' | 'bot';
}

/** What the feed calls a chat: a group's title, or a person's name / @username for a DM. */
function chatDisplayName(chat: any, fallback: string): string {
  if (!chat) return fallback;
  if (chat.title) return String(chat.title);
  const name = [chat.firstName, chat.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return fallback;
}

const FATAL_AUTH = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'AUTH_KEY_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
];
const HEALTH_INTERVAL_MS = 30_000;
/**
 * Telegram does not push a big supergroup's messages to a session (thousands of members: only
 * mentions, replies to you and your own messages arrive); its own apps poll such a chat's
 * difference while it is open, and the server's answer even says how often (30s). So watched
 * supergroups are polled with updates.getChannelDifference: every POLL_FAST_MS once a poll has
 * found a message the live stream never delivered, every POLL_SLOW_MS otherwise (a safety net
 * for chats that do push). A live message within PUSH_MEMORY_MS marks a chat as pushed.
 */
const POLL_TICK_MS = 1_000;
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 30_000;
/** a chat nothing is known about yet (fresh process): between the two, so a restart costs at most this */
const POLL_UNKNOWN_MS = 10_000;
const PUSH_MEMORY_MS = 30 * 60 * 1000;
const STEP_WAIT_MS = 20_000;
const AVATAR_CACHE_MAX = 500;
const MEDIA_MSG_MAX = 300;
const MEDIA_BYTES_MAX = 120 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Telegram entity links: the visible label (often an emoji) plus the hidden URL. */
function entityLinks(text: string, entities: any[] | undefined): LinkIn[] {
  const out: LinkIn[] = [];
  for (const e of entities ?? []) {
    const label = text.substr(e.offset ?? 0, e.length ?? 0);
    if (e.className === 'MessageEntityTextUrl' && e.url) out.push({ label, url: String(e.url) });
    else if (e.className === 'MessageEntityUrl') out.push({ label, url: label });
  }
  return out;
}

/**
 * Events: 'state' (TelegramState, error?), 'step' (LoginStep), 'session' (string|undefined),
 * 'message' (FeedMessage, ExtractedMeta), 'reactions' (msgId, Reaction[]).
 */
export class TelegramWrapper extends EventEmitter {
  private client?: TelegramClient;
  private pending: { code?: Deferred<string>; password?: Deferred<string> } = {};
  private stepWaiters: ((s: LoginStep) => void)[] = [];
  private healthTimer?: ReturnType<typeof setInterval>;
  private avatars = new Map<string, Buffer | null>();
  /** `${chatId}:${msgId}` -> gramjs message, for later media download */
  private mediaMsgs = new Map<string, any>();
  private mediaBytes = new Map<string, { buf: Buffer; mime: string }>();
  private mediaBytesTotal = 0;
  state: TelegramState = 'disconnected';
  step: LoginStep = 'idle';
  /** Logged-in account's Telegram user id (set once connected). */
  selfId?: string;
  selfUsername?: string;

  constructor(
    private apiId: number,
    private apiHash: string,
    private session: string | undefined,
  ) {
    super();
  }

  /** Connect with the saved session, or report needs_login. */
  async connect(): Promise<void> {
    await this.teardown();
    if (!this.session) {
      this.setState('needs_login');
      return;
    }
    this.setState('connecting');
    try {
      const client = this.makeClient(this.session);
      await client.connect();
      if (!(await client.isUserAuthorized())) {
        await client.disconnect();
        this.setState('needs_login');
        return;
      }
      this.onAuthorized(client);
    } catch (e: any) {
      this.setState(this.isFatal(e) ? 'needs_login' : 'auth_error', e?.message ?? String(e));
    }
  }

  async loginStart(phone: string): Promise<LoginStep> {
    await this.teardown();
    this.setState('connecting');
    const client = this.makeClient('');
    this.client = client;
    this.pending = {};
    const stepChange = this.nextStep();
    client
      .start({
        phoneNumber: async () => phone,
        phoneCode: async () => this.waitFor('code'),
        password: async () => this.waitFor('password'),
        onError: async (err) => {
          console.warn('[telegram] login error', err.message);
          this.setState('needs_login', err.message);
          this.setStep('idle');
          return true;
        },
      })
      .then(() => {
        this.session = String(client.session.save());
        this.emit('session', this.session);
        this.setStep('done');
        this.onAuthorized(client);
      })
      .catch((e) => {
        this.setState('needs_login', e?.message ?? String(e));
        this.setStep('idle');
      });
    return stepChange;
  }

  async loginCode(code: string): Promise<LoginStep> {
    const next = this.nextStep();
    this.pending.code?.resolve(code);
    return next;
  }

  async loginPassword(password: string): Promise<LoginStep> {
    const next = this.nextStep();
    this.pending.password?.resolve(password);
    return next;
  }

  async logout(): Promise<void> {
    await this.teardown();
    this.session = undefined;
    this.emit('session', undefined);
    this.setStep('idle');
    this.setState('needs_login');
  }

  /** A public username (chat, channel or bot) → its id as the feed knows it, its name, and whether it is a bot. */
  async resolveChat(username: string): Promise<{ id: string; name: string; bot: boolean }> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const e: any = await this.client.getEntity(username);
    const name = String(e?.title ?? [e?.firstName, e?.lastName].filter(Boolean).join(' ') ?? e?.username ?? username).trim() || username;
    return { id: String(getPeerId(e)), name, bot: !!e?.bot };
  }

  /**
   * messages.GetDialogs is flood-limited hard (30s+ sleeps after a handful of calls), and gramJS
   * also falls back to it whenever it must resolve an entity it has not seen — which is what
   * turned a Send into a four-minute wait once a few page loads had exhausted the allowance. So
   * the list is fetched at most once a minute, concurrent callers share the one request, and
   * every fetch warms gramJS's entity cache for the sends and avatars that follow.
   */
  private dialogsCache?: { at: number; list: TelegramDialog[] };
  private dialogsInFlight?: Promise<TelegramDialog[]>;
  async listDialogs(): Promise<TelegramDialog[]> {
    if (!this.client || this.state !== 'connected') return [];
    if (this.dialogsCache && Date.now() - this.dialogsCache.at < 60_000) return this.dialogsCache.list;
    if (this.dialogsInFlight) return this.dialogsInFlight;
    this.dialogsInFlight = this.fetchDialogs().finally(() => (this.dialogsInFlight = undefined));
    return this.dialogsInFlight;
  }
  private async fetchDialogs(): Promise<TelegramDialog[]> {
    const dialogs = await this.client!.getDialogs({ limit: 500 });
    const list = dialogs
      .filter((d) => d.isGroup || d.isChannel || d.isUser)
      .map((d) => ({
        id: String(d.id),
        title: d.isUser ? chatDisplayName(d.entity, d.title ?? String(d.id)) : (d.title ?? '(untitled)'),
        type: d.isUser ? ((d.entity as any)?.bot ? ('bot' as const) : ('dm' as const)) : d.isChannel && !d.isGroup ? ('channel' as const) : ('group' as const),
      }));
    this.dialogsCache = { at: Date.now(), list };
    return list;
  }

  /** Profile photo bytes (JPEG) for a user/chat id, cached. null when none. */
  async getAvatar(id: string): Promise<Buffer | null> {
    if (this.avatars.has(id)) return this.avatars.get(id)!;
    if (!this.client || this.state !== 'connected') return null;
    let buf: Buffer | null = null;
    try {
      // gramJS resolves an id from its entity cache, then users.GetUsers / messages.GetChats; it never
      // asks messages.GetDialogs here (that flood came from the dialog list, now cached above)
      const entity = await this.client.getInputEntity(bigInt(id));
      const res = await this.client.downloadProfilePhoto(entity, { isBig: false });
      if (Buffer.isBuffer(res) && res.length > 0) buf = res;
    } catch (e: any) {
      console.warn('[telegram] avatar failed', id, e?.message ?? e);
    }
    if (this.avatars.size >= AVATAR_CACHE_MAX) this.avatars.delete(this.avatars.keys().next().value!);
    this.avatars.set(id, buf);
    return buf;
  }

  /** Media bytes for a message (photo/gif/video/sticker, or the link-preview photo), cached. */
  async getMedia(chatId: string, msgId: number, thumb: boolean): Promise<{ buf: Buffer; mime: string } | null> {
    const key = `${chatId}:${msgId}${thumb ? ':t' : ''}`;
    const hit = this.mediaBytes.get(key);
    if (hit) return hit;
    const client = this.client;
    if (!client || this.state !== 'connected') return null;
    try {
      let msg: any = this.mediaMsgs.get(`${chatId}:${msgId}`);
      if (!msg) {
        const got = await client.getMessages(bigInt(chatId), { ids: [msgId] });
        msg = got?.[0];
      }
      if (!msg?.media) return null;
      const media = msg.media;
      let target: any = msg;
      let mime = 'application/octet-stream';
      if (media.className === 'MessageMediaWebPage') {
        if (!media.webpage?.photo) return null;
        target = media.webpage.photo;
        mime = 'image/jpeg';
      } else if (media.className === 'MessageMediaPhoto') mime = 'image/jpeg';
      else if (media.className === 'MessageMediaDocument') mime = String(media.document?.mimeType ?? mime);
      const opts: any = thumb && media.className === 'MessageMediaDocument' ? { thumb: 0 } : {};
      if (thumb) mime = 'image/jpeg';
      const res = await client.downloadMedia(target, opts);
      if (!Buffer.isBuffer(res) || res.length === 0) return null;
      const entry = { buf: res, mime };
      this.mediaBytes.set(key, entry);
      this.mediaBytesTotal += res.length;
      while (this.mediaBytesTotal > MEDIA_BYTES_MAX && this.mediaBytes.size > 1) {
        const oldest = this.mediaBytes.keys().next().value!;
        this.mediaBytesTotal -= this.mediaBytes.get(oldest)!.buf.length;
        this.mediaBytes.delete(oldest);
      }
      return entry;
    } catch (e: any) {
      console.warn('[telegram] media failed', key, e?.message ?? e);
      return null;
    }
  }

  /** Send a message to a chat you are in, optionally as a reply. */
  async send(chatId: string, text: string, replyTo?: number): Promise<void> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const sent: any = await this.client.sendMessage(bigInt(chatId), { message: text, replyTo, linkPreview: true });
    // Show it in the feed immediately; the update stream may or may not echo our own sends.
    if (sent?.className === 'Message') {
      try {
        const { msg, meta } = await this.toFeed(sent, chatId);
        this.emit('message', msg, meta);
      } catch (e: any) {
        console.warn('[telegram] could not echo sent message', e?.message ?? e);
      }
    }
  }

  /** A chat id, or a bot's username for the bot columns' conversations. */
  private async peerFor(chat: string): Promise<any> {
    if (/^-?\d+$/.test(chat)) return this.client!.getInputEntity(bigInt(chat));
    return this.botPeer(chat.replace(/^@/, ''));
  }

  /** Forward a message as Telegram does it: formatting, media and the "forwarded from" header intact. */
  async forward(fromChat: string, msgId: number, toChat: string): Promise<void> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const fromPeer = await this.peerFor(fromChat);
    const sent: any = await this.client.forwardMessages(bigInt(toChat), { messages: [msgId], fromPeer });
    const first = Array.isArray(sent) ? sent[0] : sent;
    if (first?.className === 'Message') {
      try {
        const { msg, meta } = await this.toFeed(first, toChat);
        this.emit('message', msg, meta);
      } catch (e: any) {
        console.warn('[telegram] could not echo forwarded message', e?.message ?? e);
      }
    }
  }

  /**
   * A message as a copy for another platform: its text in Discord markdown, who wrote it, and
   * its photo when it has one.
   */
  async copyOf(chat: string, msgId: number): Promise<{ text: string; author: string; photo?: { name: string; mime: string; data: Buffer } }> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const peer = await this.peerFor(chat);
    const got: any[] = await this.client.getMessages(peer, { ids: [msgId] });
    const m: any = got?.[0];
    if (!m || m.className !== 'Message') throw new Error('that message is gone');
    let author = '';
    let fromBot = false;
    try {
      const sender: any = await m.getSender?.();
      fromBot = !!sender?.bot;
      author = sender ? String(sender.title ?? [sender.firstName, sender.lastName].filter(Boolean).join(' ') ?? sender.username ?? '') : '';
    } catch {
      /* the chat's name will do */
    }
    // a bot's report is laid out as one (headings, sections); a person's message stays as typed
    const text = entitiesToDiscord(String(m.message ?? ''), m.entities, { report: fromBot });
    let photo: { name: string; mime: string; data: Buffer } | undefined;
    if (m.media?.className === 'MessageMediaPhoto' || (m.media?.className === 'MessageMediaDocument' && /^image\//.test(String(m.media.document?.mimeType ?? '')))) {
      const data: any = await this.client.downloadMedia(m, {});
      if (Buffer.isBuffer(data) && data.length > 0 && data.length <= 8 * 1024 * 1024) {
        const mime = m.media.className === 'MessageMediaPhoto' ? 'image/jpeg' : String(m.media.document.mimeType);
        photo = { name: `forward.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'}`, mime, data };
      }
    }
    return { text, author, photo };
  }

  /** Send an image (or any file) with an optional caption, as a photo when it is one. */
  async sendFile(chatId: string, file: { name: string; mime: string; data: Buffer }, caption: string, replyTo?: number): Promise<void> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const sent: any = await this.client.sendFile(bigInt(chatId), {
      file: new CustomFile(file.name, file.data.length, '', file.data),
      caption,
      replyTo,
      forceDocument: !/^image\/(png|jpe?g|gif|webp)$/i.test(file.mime),
    });
    if (sent?.className === 'Message') {
      try {
        const { msg, meta } = await this.toFeed(sent, chatId);
        this.emit('message', msg, meta);
      } catch (e: any) {
        console.warn('[telegram] could not echo sent file', e?.message ?? e);
      }
    }
  }

  /** Set (or clear) your reaction on a message. Telegram keeps one reaction per user by default. */
  async react(chatId: string, msgId: number, emoticon: string, on: boolean): Promise<void> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer: await this.client.getInputEntity(bigInt(chatId)),
        msgId,
        reaction: on ? [new Api.ReactionEmoji({ emoticon })] : [],
      }),
    );
  }

  // --- bot conversations (Cove) ---

  /** user ids of bots whose DMs we relay, keyed by lowercase username */
  private bots = new Map<string, string>();

  private async botPeer(username: string): Promise<any> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const entity: any = await this.client.getEntity(username);
    if (!entity?.bot) throw new Error(`${username} is not a bot`);
    this.bots.set(username.toLowerCase(), String(entity.id));
    return entity;
  }

  private toBotMessage(m: any): BotMessage {
    const rows = m.replyMarkup?.className === 'ReplyInlineMarkup' ? m.replyMarkup.rows : [];
    const buttons = rows.map((r: any) =>
      (r.buttons ?? []).map((b: any) => ({
        text: String(b.text ?? ''),
        ...(b.data ? { data: Buffer.from(b.data).toString('base64') } : {}),
        ...(b.url ? { url: String(b.url) } : {}),
      })),
    );
    return { id: Number(m.id), ts: Number(m.date) * 1000, out: !!m.out, text: entitiesToMarkdown(String(m.message ?? ''), m.entities), buttons, hasMedia: !!m.media };
  }

  /** Is this update about a bot conversation we relay? Returns the bot username. */
  private botFor(m: any): string | undefined {
    const uid = m?.peerId?.className === 'PeerUser' ? String(m.peerId.userId) : undefined;
    if (!uid) return undefined;
    for (const [name, id] of this.bots) if (id === uid) return name;
    return undefined;
  }

  /** Recent messages in the DM with a bot (oldest first). Registers the bot for live relay. */
  async botHistory(username: string, limit = 40): Promise<BotMessage[]> {
    const peer = await this.botPeer(username);
    const msgs: any[] = await this.client!.getMessages(peer, { limit });
    return msgs
      .filter((m) => m && m.className === 'Message')
      .map((m) => this.toBotMessage(m))
      .sort((a, b) => a.id - b.id);
  }

  /** The deep-link equivalent: /start <payload> delivered the way Telegram does it. */
  async botStart(username: string, payload: string): Promise<void> {
    const peer = await this.botPeer(username);
    await this.client!.invoke(
      new Api.messages.StartBot({ bot: peer, peer, randomId: bigInt(Math.floor(Math.random() * 2 ** 52)), startParam: payload }),
    );
  }

  private chatCommandsCache = new Map<string, { at: number; list: { command: string; description: string; bot: string; botName: string; dm: boolean }[] }>();
  /**
   * The slash commands of every bot in a chat (a Telegram client's "/" menu): the chat's full info
   * lists each bot's BotInfo with its commands. Cached ten minutes. `dm` says the chat is the bot
   * itself, where a bare `/cmd` is enough; in a group `/cmd@bot` is unambiguous.
   */
  async chatCommands(chatId: string): Promise<{ command: string; description: string; bot: string; botName: string; dm: boolean }[]> {
    if (!this.client || this.state !== 'connected') throw new Error('telegram not connected');
    const hit = this.chatCommandsCache.get(chatId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const peer: any = await this.client.getInputEntity(bigInt(chatId));
    let infos: any[] = [];
    let users: any[] = [];
    let dm = false;
    if (peer instanceof Api.InputPeerChannel) {
      const r: any = await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
      infos = r?.fullChat?.botInfo ?? [];
      users = r?.users ?? [];
    } else if (peer instanceof Api.InputPeerChat) {
      const r: any = await this.client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }));
      infos = r?.fullChat?.botInfo ?? [];
      users = r?.users ?? [];
    } else if (peer instanceof Api.InputPeerUser) {
      const r: any = await this.client.invoke(new Api.users.GetFullUser({ id: peer }));
      infos = r?.fullUser?.botInfo ? [r.fullUser.botInfo] : [];
      users = r?.users ?? [];
      dm = true;
    }
    const list: { command: string; description: string; bot: string; botName: string; dm: boolean }[] = [];
    for (const info of infos) {
      const uid = info?.userId?.toString?.() ?? (dm ? peer.userId?.toString?.() : undefined);
      const u = users.find((x: any) => x?.id?.toString?.() === uid);
      // a collectible username lives in `usernames` with `username` empty
      const bot = String(u?.username ?? u?.usernames?.find((n: any) => n?.active)?.username ?? u?.usernames?.[0]?.username ?? '');
      const botName = String(u?.firstName ?? u?.username ?? 'bot');
      for (const c of info?.commands ?? []) {
        if (!c || typeof c.command !== 'string') continue;
        list.push({ command: String(c.command).replace(/^\//, '').slice(0, 64), description: String(c.description ?? '').slice(0, 200), bot, botName, dm });
      }
    }
    this.chatCommandsCache.set(chatId, { at: Date.now(), list: list.slice(0, 300) });
    return list;
  }

  /** chat → its admins (user id → owner / admin / custom title), ten minutes at a time */
  private adminsCache = new Map<string, { at: number; ranks: Map<string, string>; loading?: Promise<Map<string, string>> }>();
  private async adminRank(chatId: string, userId: string): Promise<string | undefined> {
    if (!this.client || this.state !== 'connected') return undefined;
    let entry = this.adminsCache.get(chatId);
    if (!entry || Date.now() - entry.at > 10 * 60_000) {
      if (entry?.loading) return (await entry.loading).get(userId);
      const loading = this.loadAdmins(chatId);
      entry = { at: Date.now(), ranks: entry?.ranks ?? new Map(), loading };
      this.adminsCache.set(chatId, entry);
      try {
        entry.ranks = await loading;
      } finally {
        entry.loading = undefined;
      }
      if (this.adminsCache.size > 300) this.adminsCache.delete(this.adminsCache.keys().next().value!);
    }
    return entry.ranks.get(userId);
  }
  private async loadAdmins(chatId: string): Promise<Map<string, string>> {
    const ranks = new Map<string, string>();
    const peer: any = await this.client!.getInputEntity(bigInt(chatId));
    const put = (p: any) => {
      const uid = p?.userId?.toString?.();
      if (!uid) return;
      const custom = typeof p.rank === 'string' && p.rank.trim() ? p.rank.trim().slice(0, 24) : undefined;
      if (p.className === 'ChannelParticipantCreator' || p.className === 'ChatParticipantCreator') ranks.set(uid, custom ?? 'owner');
      else if (p.className === 'ChannelParticipantAdmin' || p.className === 'ChatParticipantAdmin') ranks.set(uid, custom ?? 'admin');
    };
    if (peer instanceof Api.InputPeerChannel) {
      const r: any = await this.client!.invoke(new Api.channels.GetParticipants({ channel: peer, filter: new Api.ChannelParticipantsAdmins(), offset: 0, limit: 200, hash: bigInt(0) }));
      for (const p of r?.participants ?? []) put(p);
    } else if (peer instanceof Api.InputPeerChat) {
      const r: any = await this.client!.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }));
      for (const p of r?.fullChat?.participants?.participants ?? []) put(p);
    }
    return ranks;
  }

  private botCommandsCache = new Map<string, { at: number; list: { command: string; description: string }[] }>();
  /** The slash commands a bot publishes (what Telegram shows when you type "/"), cached ten minutes. */
  async botCommands(username: string): Promise<{ command: string; description: string }[]> {
    const key = username.toLowerCase();
    const hit = this.botCommandsCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const peer = await this.botPeer(username);
    const full: any = await this.client!.invoke(new Api.users.GetFullUser({ id: peer }));
    const raw: any[] = full?.fullUser?.botInfo?.commands ?? [];
    const list = raw
      .filter((c) => c && typeof c.command === 'string')
      .map((c) => ({ command: String(c.command).replace(/^\//, '').slice(0, 64), description: String(c.description ?? '').slice(0, 200) }))
      .slice(0, 100);
    this.botCommandsCache.set(key, { at: Date.now(), list });
    return list;
  }

  async botSend(username: string, text: string): Promise<void> {
    const peer = await this.botPeer(username);
    await this.client!.sendMessage(peer, { message: text, linkPreview: false });
  }

  /** Press an inline button. Returns whatever the bot answers (toast text, alert, or a url to open). */
  async botPress(username: string, msgId: number, dataB64: string): Promise<{ message?: string; alert?: boolean; url?: string; gone?: boolean }> {
    const peer = await this.botPeer(username);
    try {
      const res: any = await this.client!.invoke(
        new Api.messages.GetBotCallbackAnswer({ peer, msgId, data: Buffer.from(dataB64, 'base64') }),
      );
      return { message: res?.message ? String(res.message) : undefined, alert: !!res?.alert, url: res?.url ? String(res.url) : undefined };
    } catch (e: any) {
      // the bot already removed that message (Close, or an expired alert)
      if (/MESSAGE_ID_INVALID/.test(String(e?.errorMessage ?? e?.message ?? ''))) {
        this.emit('botDelete', [msgId]);
        return { gone: true };
      }
      throw e;
    }
  }

  /** Message your own "Saved Messages" (phone ping without any bot). */
  async sendSelf(text: string): Promise<void> {
    if (!this.client || this.state !== 'connected') return;
    await this.client.sendMessage('me', { message: text, linkPreview: false });
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.setState('disconnected');
  }

  // --- internals ---

  private makeClient(session: string): TelegramClient {
    return new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
      connectionRetries: 5,
      useWSS: false,
    });
  }

  private onAuthorized(client: TelegramClient): void {
    this.client = client;
    client
      .getMe()
      .then((me: any) => {
        if (me?.id) {
          this.selfId = String(me.id);
          this.selfUsername = me.username ? String(me.username).toLowerCase() : undefined;
          this.emit('self', this.selfId);
        }
      })
      .catch((e: any) => console.warn('[telegram] getMe failed', e?.message ?? e));
    client.addEventHandler((ev: NewMessageEvent) => {
      const bot = this.botFor(ev.message);
      // a bot column gets its panel; the same conversation can also be a watched chat in the feed
      if (bot) this.emit('bot', bot, this.toBotMessage(ev.message));
      void this.onNewMessage(ev);
    }, new NewMessage({}));
    // Bots edit their panel messages in place after a button press: relay edits too.
    client.addEventHandler((u: any) => {
      try {
        const m = u?.message;
        if (!m || m.className !== 'Message') return;
        const bot = this.botFor(m);
        if (bot) this.emit('bot', bot, { ...this.toBotMessage(m), edited: true });
      } catch (e: any) {
        console.warn('[telegram] bot edit failed', e?.message ?? e);
      }
    }, new Raw({ types: [Api.UpdateEditMessage] }));
    // Bots delete their alerts (Close, or on their own): drop them from the view too.
    client.addEventHandler((u: any) => {
      const ids: number[] = Array.isArray(u?.messages) ? u.messages.map(Number) : [];
      if (ids.length && this.bots.size) this.emit('botDelete', ids);
    }, new Raw({ types: [Api.UpdateDeleteMessages] }));
    client.addEventHandler((u: Api.UpdateMessageReactions) => {
      try {
        const peer = getPeerId(u.peer);
        this.emit('reactions', `telegram:${peer}:${u.msgId}`, mapTelegramReactions((u.reactions as any)?.results));
      } catch (e) {
        console.warn('[telegram] reaction update dropped', e);
      }
    }, new Raw({ types: [Api.UpdateMessageReactions] }));
    // Telegram's nudge that a channel moved on without its messages being pushed: sync it now.
    client.addEventHandler((u: any) => {
      const raw = `-100${String(u?.channelId ?? '')}`;
      if (this.watchList().some((w) => canonicalChatId(w) === canonicalChatId(raw))) void this.syncChannel(raw);
    }, new Raw({ types: [Api.UpdateChannelTooLong] }));
    this.healthTimer = setInterval(() => void this.healthCheck(), HEALTH_INTERVAL_MS);
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_TICK_MS);
    this.pollTimer.unref();
    this.setState('connected');
  }

  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  /** per watched chat (canonical id): the channel to ask, the pts synced to, when to ask again; no input = not a channel */
  private channels = new Map<string, { input?: Api.InputChannel; pts: number; nextAt: number; syncing?: Promise<void> }>();
  private syncWarned = new Set<string>();
  /** Telegram asked for a pause (FLOOD_WAIT): no difference requests until then */
  private floodUntil = 0;
  /** the chats to keep in sync (set by Services from the config's watch list) */
  watchList: () => string[] = () => [];
  /** per chat (canonical id): highest message id seen, when the live stream last pushed one, when a poll last found one it had not */
  private seen = new Map<string, { id: number; liveAt: number; polledAt: number }>();

  private noteSeen(chatId: string, id: number, via: 'push' | 'poll'): void {
    const k = canonicalChatId(chatId);
    const cur = this.seen.get(k) ?? { id: 0, liveAt: 0, polledAt: 0 };
    this.seen.set(k, { id: Math.max(cur.id, id), liveAt: via === 'push' ? Date.now() : cur.liveAt, polledAt: via === 'poll' ? Date.now() : cur.polledAt });
  }

  /** how soon a chat is asked again: tight once Telegram has shown it does not push this chat, the server's own 30s once it has pushed, 10s while nothing is known */
  pollInterval(chatId: string, now = Date.now()): number {
    const s = this.seen.get(canonicalChatId(chatId));
    if (s?.liveAt && now - s.liveAt < PUSH_MEMORY_MS) return POLL_SLOW_MS;
    return s?.polledAt ? POLL_FAST_MS : POLL_UNKNOWN_MS;
  }

  /** the poll tick: every watched chat whose turn has come is synced, one after the other. Exposed for tests. */
  async pollTick(now = Date.now()): Promise<void> {
    if (!this.client || this.state !== 'connected' || this.polling || now < this.floodUntil) return;
    this.polling = true;
    try {
      for (const raw of this.watchList()) {
        const ch = this.channels.get(canonicalChatId(raw));
        if (ch && now < ch.nextAt) continue;
        await this.syncChannel(raw);
        if (Date.now() < this.floodUntil) return;
      }
    } finally {
      this.polling = false;
    }
  }

  /** one getChannelDifference round for a watched chat; a no-op for chats that are not channels */
  syncChannel(raw: string): Promise<void> {
    const k = canonicalChatId(raw);
    const client = this.client;
    if (!k || !client || this.state !== 'connected') return Promise.resolve();
    const inFlight = this.channels.get(k)?.syncing;
    if (inFlight) return inFlight;
    const run = (async () => {
      let ch = this.channels.get(k);
      try {
        if (!ch?.input) {
          const peer: any = await client.getInputEntity(bigInt(raw));
          if (peer?.className !== 'InputPeerChannel') {
            // a basic group or DM: delivered normally, never polled
            this.channels.set(k, { pts: 0, nextAt: Number.POSITIVE_INFINITY });
            return;
          }
          const input = new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
          const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: input }));
          const pts = Number(full?.fullChat?.pts ?? 0);
          if (!pts) throw new Error('no pts for channel');
          ch = { input, pts, nextAt: 0 };
          this.channels.set(k, ch);
        }
        const diff: any = await client.invoke(
          new Api.updates.GetChannelDifference({ channel: ch.input, filter: new Api.ChannelMessagesFilterEmpty(), pts: ch.pts, limit: 100 }),
        );
        if (diff?.className === 'updates.ChannelDifferenceTooLong') {
          ch.pts = Number(diff.dialog?.pts ?? ch.pts);
        } else if (diff?.className === 'updates.ChannelDifference' || diff?.className === 'updates.ChannelDifferenceEmpty') {
          ch.pts = Number(diff.pts ?? ch.pts);
          const last = this.seen.get(k)?.id ?? 0;
          const ids: number[] = (diff.newMessages ?? [])
            .filter((m: any) => m?.className === 'Message' && Number(m.id) > last)
            .map((m: any) => Number(m.id))
            .sort((a: number, b: number) => a - b);
          if (ids.length) {
            // the difference carries bare messages; the full objects know their chat and sender
            const full: any[] = await client.getMessages(bigInt(raw), { ids });
            for (const m of full) {
              if (!m || m.className !== 'Message' || this.botFor(m)) continue;
              this.noteSeen(raw, Number(m.id), 'poll');
              const { msg, meta } = await this.toFeed(m, raw);
              this.emit('message', msg, meta);
            }
          }
        }
        this.syncWarned.delete(k);
      } catch (e: any) {
        const wait = Number(e?.seconds ?? /FLOOD_WAIT_(\d+)/.exec(String(e?.message ?? e))?.[1] ?? 0);
        if (wait > 0) {
          this.floodUntil = Date.now() + wait * 1000;
          console.warn(`[telegram] channel sync: Telegram asks for a ${wait}s pause`);
        } else if (!this.syncWarned.has(k)) {
          console.warn('[telegram] channel sync failed for', raw, e?.message ?? e);
        }
        this.syncWarned.add(k);
        ch = { pts: 0, nextAt: 0 }; // re-resolve next time
        this.channels.set(k, ch);
      } finally {
        if (ch) {
          ch.syncing = undefined;
          if (ch.nextAt !== Number.POSITIVE_INFINITY) ch.nextAt = Date.now() + this.pollInterval(k);
        }
      }
    })();
    const ch = this.channels.get(k);
    if (ch) ch.syncing = run;
    return run;
  }

  private async onNewMessage(ev: NewMessageEvent): Promise<void> {
    try {
      const m = ev.message;
      const chatId = String(m.chatId ?? ev.chatId ?? '');
      if (!chatId) return;
      this.noteSeen(chatId, Number(m.id), 'push');
      const { msg, meta } = await this.toFeed(m, chatId);
      this.emit('message', msg, meta);
    } catch (e) {
      console.warn('[telegram] dropped message', e);
    }
  }

  /** One chat's members, named the way the feed names them. Large channels may refuse. */
  async listParticipants(chatId: string, limit = 200): Promise<{ name: string }[]> {
    if (!this.client || this.state !== 'connected') return [];
    const parts: any[] = await this.client.getParticipants(bigInt(chatId), { limit }).catch(() => []);
    const out: { name: string }[] = [];
    for (const u of parts) {
      if (u?.bot) continue;
      const name = u?.username ? `@${u.username}` : [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
      if (name) out.push({ name });
    }
    return out;
  }

  /**
   * Members of the given chats matching `query`, named the way the feed names them
   * (@username, else first+last) so a favorite added here matches their messages.
   */
  async searchParticipants(query: string, chatIds: string[], limit = 8): Promise<{ name: string; chat: string }[]> {
    if (!this.client || this.state !== 'connected' || !query.trim()) return [];
    const out: { name: string; chat: string }[] = [];
    for (const id of chatIds.slice(0, 8)) {
      try {
        const chat: any = await this.client.getEntity(bigInt(id)).catch(() => null);
        const parts: any[] = await this.client.getParticipants(bigInt(id), { search: query, limit });
        for (const u of parts) {
          const name = u?.username ? `@${u.username}` : [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
          if (name) out.push({ name, chat: String(chat?.title ?? id) });
        }
      } catch {
        /* a chat that doesn't support participant search */
      }
      if (out.length >= limit * 2) break;
    }
    return out;
  }

  /** Recent messages of a chat (newest first), for previewing a chat that isn't in the feed. */
  async history(chatId: string, limit = 50): Promise<FeedMessage[]> {
    if (!this.client || this.state !== 'connected') return [];
    const msgs: any[] = await this.client.getMessages(bigInt(chatId), { limit });
    const out: FeedMessage[] = [];
    for (const m of msgs) {
      if (!m || m.className !== 'Message') continue;
      try {
        out.push((await this.toFeed(m, chatId)).msg);
      } catch {
        /* skip one */
      }
    }
    return out;
  }

  /** gramjs message → our FeedMessage (+ extracted link metadata). */
  private async toFeed(m: any, chatId: string): Promise<{ msg: FeedMessage; meta: ExtractedMeta }> {
    const chat: any = await m.getChat().catch(() => null);
    const sender: any = await m.getSender().catch(() => null);
    const senderName = sender?.username
      ? `@${sender.username}`
      : [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || sender?.title || chat?.title || 'unknown';
    const text = m.message ?? '';
    const senderId = m.senderId ? String(m.senderId) : undefined;
    let replyTo: TelegramPlain['replyTo'];
    if (m.replyTo) {
      const r: any = await m.getReplyMessage().catch(() => undefined);
      if (r) {
        const rs: any = await r.getSender?.().catch(() => null);
        const rName = rs?.username
          ? `@${rs.username}`
          : [rs?.firstName, rs?.lastName].filter(Boolean).join(' ') || rs?.title || 'unknown';
        replyTo = { author: rName, text: String(r.message ?? '').trim() || (r.media ? '📎 media' : ''), id: `telegram:${chatId}:${r.id}` };
      }
    }
    // a group's admins carry a tag (owner, admin, or the title the group gave them); channels post as the channel and get none
    const authorTag = senderId && sender?.bot !== true && sender?.className === 'User' ? await this.adminRank(chatId, senderId).catch(() => undefined) : undefined;
    const mediaUrl = `/api/telegram/media/${chatId}/${m.id}`;
    const media = classifyMedia(m.media, mediaUrl);
    const preview = webpagePreview(m.media, `${mediaUrl}?thumb=1`);
    if (m.media && (media.length || preview?.image)) {
      this.mediaMsgs.set(`${chatId}:${m.id}`, m);
      if (this.mediaMsgs.size > MEDIA_MSG_MAX) this.mediaMsgs.delete(this.mediaMsgs.keys().next().value!);
    }
    const plain: TelegramPlain = {
      id: m.id,
      chatId,
      chatTitle: chatDisplayName(chat, chatId),
      chatUsername: chat?.username ?? undefined,
      senderId,
      senderName,
      isBot: sender?.bot === true,
      authorTag,
      text,
      date: m.date,
      hasMedia: !!m.media && m.media.className !== 'MessageMediaWebPage',
      replyTo,
      // Telegram flags incoming mentions/replies for us; for our own messages, only an explicit @me counts
      mentioned: m.out ? !!this.selfUsername && new RegExp(`(^|[^\\w])@${this.selfUsername}(?![\\w])`, 'i').test(text) : !!m.mentioned,
      reactions: mapTelegramReactions((m.reactions as any)?.results),
      media,
      previews: preview ? [preview] : [],
    };
    const meta: ExtractedMeta = extractLinks(text, entityLinks(text, m.entities as any[] | undefined));
    return { msg: normalizeTelegram(plain), meta };
  }

  private async healthCheck(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await Promise.race([
        client.getMe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('health probe timeout')), 15_000)),
      ]);
      if (this.state !== 'connected') this.setState('connected');
    } catch (e: any) {
      console.warn('[telegram] health check failed', e?.message);
      if (this.isFatal(e)) {
        await this.teardown();
        this.setState('needs_login', e.message);
        return;
      }
      this.setState('connecting');
      try {
        await client.connect();
      } catch {
        /* next tick retries */
      }
    }
  }

  private isFatal(e: any): boolean {
    const msg = String(e?.errorMessage ?? e?.message ?? '');
    return FATAL_AUTH.some((k) => msg.includes(k));
  }

  private waitFor(step: 'code' | 'password'): Promise<string> {
    const d = deferred<string>();
    this.pending[step] = d;
    this.setStep(step);
    return d.promise;
  }

  private nextStep(): Promise<LoginStep> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.stepWaiters = this.stepWaiters.filter((w) => w !== fn);
        resolve(this.step);
      }, STEP_WAIT_MS);
      const fn = (s: LoginStep) => {
        clearTimeout(t);
        resolve(s);
      };
      this.stepWaiters.push(fn);
    });
  }

  private setStep(step: LoginStep): void {
    this.step = step;
    this.emit('step', step);
    const ws = this.stepWaiters;
    this.stepWaiters = [];
    for (const w of ws) w(step);
  }

  private setState(state: TelegramState, error?: string): void {
    this.state = state;
    this.emit('state', state, error);
  }

  private async teardown(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const d of Object.values(this.pending)) d?.reject(new Error('AUTH_USER_CANCEL'));
    this.pending = {};
    const c = this.client;
    this.client = undefined;
    if (c) {
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}
