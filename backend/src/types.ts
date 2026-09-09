export type Source = 'discord' | 'telegram';
export type Chain = 'sol' | 'evm';

export interface Contract {
  chain: Chain;
  address: string;
}

export interface FeedMessage {
  id: string;
  source: Source;
  chatId: string;
  chatName: string;
  author: string;
  avatar?: string;
  isBot: boolean;
  text: string;
  ts: number;
  contracts: Contract[];
  /** true when every contract in this message had already been posted in this chat */
  repeat: boolean;
  link?: string;
  hasAttachment: boolean;
}

export interface TokenInfo {
  chain: Chain;
  address: string;
  /** number of distinct chats that have posted this contract */
  seen: number;
  /** names of those chats, in order of first post */
  calledIn: string[];
  firstSeenTs: number;
  name?: string;
  symbol?: string;
  priceUsd?: number;
  marketCap?: number;
  liquidity?: number;
  change24h?: number;
  imageUrl?: string;
  chartUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
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
  | { type: 'hello'; status: Status; messages: FeedMessage[]; tokens: TokenInfo[] }
  | { type: 'message'; msg: FeedMessage }
  | { type: 'token'; token: TokenInfo }
  | { type: 'status'; status: Status };
