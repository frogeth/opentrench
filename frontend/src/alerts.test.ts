import { describe, expect, it } from 'vitest';
import { alertSound, type AlertColumn } from './alerts';
import type { FeedMessage, TokenInfo } from './types';

const NOW = 1_700_000_000_000;
const ADDR = '0xabc';

const msg = (over: Partial<FeedMessage> = {}): FeedMessage => ({
  id: 'm1',
  source: 'discord',
  chatId: 'c1',
  chatName: 'Alpha',
  author: 'bob',
  isBot: false,
  text: `look ${ADDR}`,
  ts: NOW - 1000,
  contracts: [{ chain: 'evm', address: ADDR }],
  repeat: false,
  hasAttachment: false,
  ...over,
});
const token = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  chain: 'evm',
  address: ADDR,
  seen: 1,
  calledIn: ['Alpha'],
  calls: [],
  firstSeenTs: NOW - 1000,
  lastCallTs: NOW - 1000,
  ...over,
});
const col = (over: Partial<AlertColumn> = {}): AlertColumn => ({ type: 'calls', alert: { on: true, sound: 'chirp' }, names: null, ...over });
const opts = (over: Partial<Parameters<typeof alertSound>[3]> = {}) => ({ inScope: () => true, hidden: new Set<string>(), now: NOW, ...over });

describe('alertSound', () => {
  it('plays the calls column sound for a fresh call with no filters', () => {
    expect(alertSound(msg(), { [ADDR]: token() }, [col()], opts())).toBe('chirp');
  });
  it('stays quiet when the call does not pass the calls column filters', () => {
    const cols = [col({ filters: { callsMin: 2 } })];
    expect(alertSound(msg(), { [ADDR]: token({ seen: 1 }) }, cols, opts())).toBeNull();
  });
  it('plays once the token passes the calls column filters', () => {
    const cols = [col({ filters: { callsMin: 2 } })];
    expect(alertSound(msg(), { [ADDR]: token({ seen: 2 }) }, cols, opts())).toBe('chirp');
  });
  it('stays quiet for a token the user hid', () => {
    expect(alertSound(msg(), { [ADDR]: token() }, [col()], opts({ hidden: new Set([ADDR]) }))).toBeNull();
  });
  it('stays quiet when the token is not known yet', () => {
    expect(alertSound(msg(), {}, [col()], opts())).toBeNull();
  });
  it('applies chat column filters to the message', () => {
    const cols = [col({ type: 'chat', filters: { showOnly: ['alice'] } })];
    expect(alertSound(msg(), { [ADDR]: token() }, cols, opts())).toBeNull();
    expect(alertSound(msg({ author: 'alice' }), { [ADDR]: token() }, cols, opts())).toBe('chirp');
  });
  it('ignores columns whose bell is off, other column types, and chats out of scope', () => {
    const t = { [ADDR]: token() };
    expect(alertSound(msg(), t, [col({ alert: { on: false, sound: 'chirp' } })], opts())).toBeNull();
    expect(alertSound(msg(), t, [col({ type: 'j7' })], opts())).toBeNull();
    expect(alertSound(msg(), t, [col()], opts({ inScope: () => false }))).toBeNull();
  });
  it('ignores repeats, hidden messages, messages without a contract, and stale ones', () => {
    const t = { [ADDR]: token() };
    expect(alertSound(msg({ repeat: true }), t, [col()], opts())).toBeNull();
    expect(alertSound(msg({ hidden: true }), t, [col()], opts())).toBeNull();
    expect(alertSound(msg({ contracts: [] }), t, [col()], opts())).toBeNull();
    expect(alertSound(msg({ ts: NOW - 61_000 }), t, [col()], opts())).toBeNull();
  });
});
