import { describe, expect, it } from 'vitest';
import { alertBots } from './botalerts.js';
import { MessageHub } from './hub.js';
import type { ColumnDef } from './config.js';
import type { BotMessage, ServerEvent } from './types.js';

const bell = { on: true, sound: 'ping' };

describe('bots whose column has its bell on', () => {
  it('names each belled bot column, stacked ones too, and skips the rest', () => {
    const cols: ColumnDef[] = [
      { id: 'a', type: 'tgbot', title: 'Cielo', chats: [], bot: 'EvmTrackerBot', alert: bell },
      { id: 'b', type: 'tgbot', title: 'Quiet', chats: [], bot: 'quiet_bot', alert: { on: false, sound: 'ping' } },
      { id: 'c', type: 'calls', title: 'Calls', chats: [], alert: bell, split: { bottom: { id: 'd', type: 'salpha', title: 'Salpha', chats: [], alert: bell } } },
    ];
    expect([...alertBots(cols, 'cove')]).toEqual(['evmtrackerbot', 'salpha_research_bot']);
  });

  it('follows the buy bot picked for the buy column', () => {
    const cols: ColumnDef[] = [{ id: 'cove', type: 'cove', title: 'Cove', chats: [], alert: bell }];
    expect([...alertBots(cols, 'cove')]).toEqual(['cove_trading_bot']);
    expect([...alertBots(cols, 'basedbot')]).toEqual(['based_eth_bot']);
  });
});

describe('a bot ping', () => {
  const msg: BotMessage = { id: 42, ts: Date.now(), out: false, text: '**Buy** 1.2 SOL of `$WAT`', buttons: [], contracts: ['2yyQGySj9G17M8G8maRTmahcnf6MxkdJYe5SdyRapump'] };

  it('lands in Pings once per message, tagged with its bot', () => {
    const hub = new MessageHub(10);
    const events: ServerEvent[] = [];
    hub.on('event', (e: ServerEvent) => events.push(e));
    const p = hub.addBotPing('EvmTrackerBot', msg)!;
    expect(p.bot).toBe('evmtrackerbot');
    expect(p.msg.author).toBe('@evmtrackerbot');
    expect(p.msg.contracts).toEqual([{ chain: 'sol', address: msg.contracts![0] }]);
    expect(hub.addBotPing('evmtrackerbot', msg)).toBeUndefined();
    expect(hub.mentions()).toHaveLength(1);
    expect(events.filter((e) => e.type === 'mention')).toHaveLength(1);
  });
});
