import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { J7Tweet } from './types.js';

/**
 * J7Tracker's live tweet stream, read the way its own web app reads it: a
 * socket.io connection authenticated with the account's session id. Read-only.
 * Unofficial, so every field access is defensive.
 */
export type J7State = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
export const J7_SERVERS = ['https://nyc.j7tracker.io', 'https://ash.j7tracker.io'];
const MAX = 300;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function normalizeJ7(raw: any): J7Tweet | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw.author ?? raw.user ?? {};
  const prof = a.profile ?? {};
  const handle = str(a.handle) ?? str(a.username) ?? str(a.screen_name) ?? str(raw.username) ?? str(raw.screen_name);
  const id = str(raw.id) ?? str(raw.tweet_id) ?? (raw.url ? String(raw.url).split('/').pop() : undefined);
  if (!id) return undefined;
  const text = str(raw.body?.text) ?? str(raw.text) ?? str(raw.full_text) ?? '';
  const media = raw.media ?? {};
  const images: string[] = Array.isArray(media) ? media.map(String) : [...(media.images ?? []), ...(media.thumbnails ?? [])].map(String);
  const q = raw.quotedTweet ?? raw.quoted_tweet;
  const qa = q?.author ?? {};
  const created = raw.created_at ?? raw.timestamp ?? raw.createdAt ?? raw.time;
  const ts = typeof created === 'number' ? (created < 1e12 ? created * 1000 : created) : created ? Date.parse(String(created)) || Date.now() : Date.now();
  return {
    id,
    url: str(raw.url) ?? str(raw.tweet_url) ?? (handle ? `https://x.com/${handle}/status/${id}` : undefined),
    ts,
    author: {
      handle: handle ?? 'unknown',
      name: str(prof.name) ?? str(a.name) ?? str(a.display_name) ?? handle ?? 'unknown',
      avatar: str(prof.avatar) ?? str(a.avatar) ?? str(a.profile_image_url) ?? str(a.profileImageUrl) ?? str(raw.profileImage),
      followers: Number.isFinite(Number(a.followers ?? a.followers_count)) ? Number(a.followers ?? a.followers_count) : undefined,
    },
    text,
    images: images.slice(0, 4),
    quoted: q ? { handle: str(qa.handle) ?? str(qa.username) ?? '', text: str(q.body?.text) ?? str(q.text) ?? '' } : undefined,
    replyTo: str(raw.in_reply_to?.handle) ?? str(raw.in_reply_to?.username),
    contracts: [],
    tickers: [...new Set((text.match(/\$[A-Za-z][A-Za-z0-9_]{1,15}/g) ?? []).map((t) => t.slice(1).toUpperCase()))],
  };
}

export class J7Client extends EventEmitter {
  private socket?: Socket;
  state: J7State = 'disconnected';
  readonly recent: J7Tweet[] = [];
  private serverIdx = 0;

  constructor(private token: string, private servers: string[] = J7_SERVERS) {
    super();
  }

  start(): void {
    this.stop();
    const server = this.servers[this.serverIdx % this.servers.length];
    this.setState('connecting');
    const s = io(server, {
      transports: ['websocket'],
      upgrade: false,
      auth: { token: this.token },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      timeout: 8000,
    });
    this.socket = s;
    s.on('connect', () => {
      this.setState('connected');
      s.emit('user_connected', this.token);
    });
    s.on('disconnect', () => this.setState('disconnected'));
    s.on('connect_error', (e: any) => {
      const msg = String(e?.message ?? e);
      console.warn('[j7] connect error', msg);
      if (/auth|unauthori|token|401|403/i.test(msg)) this.setState('auth_error', msg);
      else if (this.state !== 'auth_error') {
        // try the other region next time
        this.serverIdx++;
      }
    });
    s.on('auth_error', () => this.setState('auth_error', 'J7 rejected the session id'));
    const upsert = (raw: any) => {
      const t = normalizeJ7(raw);
      if (!t) return;
      const i = this.recent.findIndex((x) => x.id === t.id);
      if (i >= 0) this.recent[i] = t;
      else {
        this.recent.unshift(t);
        if (this.recent.length > MAX) this.recent.length = MAX;
      }
      this.emit('tweet', t);
    };
    s.on('tweet', upsert);
    s.on('tweet_update', upsert);
    s.on('tweet.subtweet.update', upsert);
    s.on('tweet_deleted', (e: any) => {
      const id = str(e?.id) ?? str(e?.tweet_id);
      if (!id) return;
      const i = this.recent.findIndex((x) => x.id === id);
      if (i >= 0) this.recent.splice(i, 1);
      this.emit('delete', id);
    });
  }

  stop(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = undefined;
    if (this.state !== 'auth_error') this.setState('disconnected');
  }

  private setState(state: J7State, error?: string): void {
    this.state = state;
    this.emit('state', state, error);
  }
}
