export type Source = 'discord' | 'telegram';

export interface Contract {
  chain: 'sol' | 'evm';
  address: string;
}

export interface FeedMessage {
  id: string;
  source: Source;
  chatId: string;
  chatName: string;
  author: string;
  text: string;
  ts: number;
  contracts: Contract[];
  link?: string;
  hasAttachment: boolean;
}

export type DiscordState = 'disconnected' | 'connecting' | 'connected' | 'auth_error';
export type TelegramState = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'auth_error';
export type LoginStep = 'idle' | 'code' | 'password' | 'done';

export interface Status {
  discord: DiscordState;
  telegram: TelegramState;
  loginStep: LoginStep;
  error: { discord?: string; telegram?: string };
}

export type ServerEvent =
  | { type: 'hello'; status: Status; messages: FeedMessage[] }
  | { type: 'message'; msg: FeedMessage }
  | { type: 'status'; status: Status };
