import { EventEmitter } from 'node:events';
import { detectContracts } from './contracts.js';
import type {
  DiscordState,
  FeedMessage,
  LoginStep,
  ServerEvent,
  Source,
  Status,
  TelegramState,
} from './types.js';

export class MessageHub extends EventEmitter {
  private buffer: FeedMessage[] = [];
  private status: Status = { discord: 'disconnected', telegram: 'disconnected', loginStep: 'idle', error: {} };

  constructor(private cap = 500) {
    super();
  }

  push(msg: FeedMessage): void {
    msg.contracts = detectContracts(msg.text);
    this.buffer.push(msg);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    this.emit('event', { type: 'message', msg } satisfies ServerEvent);
  }

  setStatus(source: 'discord', state: DiscordState, error?: string): void;
  setStatus(source: 'telegram', state: TelegramState, error?: string): void;
  setStatus(source: Source, state: DiscordState | TelegramState, error?: string): void {
    (this.status as Record<Source, string>)[source] = state;
    if (error) this.status.error[source] = error;
    else delete this.status.error[source];
    this.emitStatus();
  }

  setLoginStep(step: LoginStep): void {
    this.status.loginStep = step;
    this.emitStatus();
  }

  getStatus(): Status {
    return structuredClone(this.status);
  }

  hello(): ServerEvent {
    return { type: 'hello', status: this.getStatus(), messages: [...this.buffer] };
  }

  private emitStatus(): void {
    this.emit('event', { type: 'status', status: this.getStatus() } satisfies ServerEvent);
  }
}
