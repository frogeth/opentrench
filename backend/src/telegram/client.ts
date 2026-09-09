import { EventEmitter } from 'node:events';
import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js';
import { Api } from 'telegram/tl/index.js';
import { getPeerId } from 'telegram/Utils.js';
import type { FeedMessage, LoginStep, TelegramState } from '../types.js';
import { mapTelegramReactions, normalizeTelegram, type TelegramPlain } from './normalize.js';
import { extractLinks, type ExtractedMeta, type LinkIn } from '../links.js';

export interface TelegramDialog {
  id: string;
  title: string;
  type: 'group' | 'channel';
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
const STEP_WAIT_MS = 20_000;
const AVATAR_CACHE_MAX = 500;

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
  state: TelegramState = 'disconnected';
  step: LoginStep = 'idle';

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

  async listDialogs(): Promise<TelegramDialog[]> {
    if (!this.client || this.state !== 'connected') return [];
    const dialogs = await this.client.getDialogs({ limit: 500 });
    return dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        id: String(d.id),
        title: d.title ?? '(untitled)',
        type: d.isChannel && !d.isGroup ? ('channel' as const) : ('group' as const),
      }));
  }

  /** Profile photo bytes (JPEG) for a user/chat id, cached. null when none. */
  async getAvatar(id: string): Promise<Buffer | null> {
    if (this.avatars.has(id)) return this.avatars.get(id)!;
    if (!this.client || this.state !== 'connected') return null;
    let buf: Buffer | null = null;
    try {
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
    client.addEventHandler((ev: NewMessageEvent) => {
      void this.onNewMessage(ev);
    }, new NewMessage({}));
    client.addEventHandler((u: Api.UpdateMessageReactions) => {
      try {
        const peer = getPeerId(u.peer);
        this.emit('reactions', `telegram:${peer}:${u.msgId}`, mapTelegramReactions((u.reactions as any)?.results));
      } catch (e) {
        console.warn('[telegram] reaction update dropped', e);
      }
    }, new Raw({ types: [Api.UpdateMessageReactions] }));
    this.healthTimer = setInterval(() => void this.healthCheck(), HEALTH_INTERVAL_MS);
    this.setState('connected');
  }

  private async onNewMessage(ev: NewMessageEvent): Promise<void> {
    try {
      const m = ev.message;
      const chatId = String(m.chatId ?? ev.chatId ?? '');
      if (!chatId) return;
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
          replyTo = { author: rName, text: String(r.message ?? '').trim() || (r.media ? '📎 media' : '') };
        }
      }
      const plain: TelegramPlain = {
        id: m.id,
        chatId,
        chatTitle: chat?.title ?? chatId,
        chatUsername: chat?.username ?? undefined,
        senderId,
        senderName,
        isBot: sender?.bot === true,
        text,
        date: m.date,
        hasMedia: !!m.media,
        replyTo,
        reactions: mapTelegramReactions((m.reactions as any)?.results),
      };
      const meta: ExtractedMeta = extractLinks(text, entityLinks(text, m.entities as any[] | undefined));
      this.emit('message', normalizeTelegram(plain) satisfies FeedMessage, meta);
    } catch (e) {
      console.warn('[telegram] dropped message', e);
    }
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
    for (const d of Object.values(this.pending)) d?.reject(new Error('AUTH_USER_CANCEL'));
    this.pending = {};
    const c = this.client;
    this.client = undefined;
    if (c) {
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}
