import { describe, it, expect, vi } from 'vitest';
import { TelegramWrapper } from './client.js';

/**
 * The channel poll: Telegram does not push a big supergroup's messages, so watched supergroups
 * are synced with updates.getChannelDifference. Driven with a fake gramjs client answering
 * getInputEntity, invoke (GetFullChannel, GetChannelDifference) and getMessages({ ids }).
 */
const msg = (id: number, who = 'someone') => ({ className: 'Message', id, message: `m${id}`, who });

function wrapper(answers: { pts: number; diffs: any[] }) {
  const invoked: any[] = [];
  const fetched: any[] = [];
  const w = new TelegramWrapper(1, 'hash', undefined);
  (w as any).state = 'connected';
  // toFeed needs a gramjs message with getChat/getSender; stub the conversion itself
  (w as any).toFeed = async (m: any, chatId: string) => ({ msg: { id: `telegram:${chatId}:${m.id}`, text: m.message, ts: 1, author: m.who, chatId }, meta: {} });
  (w as any).botFor = () => undefined;
  (w as any).client = {
    getInputEntity: async () => ({ className: 'InputPeerChannel', channelId: 1, accessHash: 2 }),
    invoke: async (req: any) => {
      invoked.push(req);
      if (req.className === 'channels.GetFullChannel') return { fullChat: { pts: answers.pts } };
      const d = answers.diffs.shift();
      if (d instanceof Error) throw d;
      return d ?? { className: 'updates.ChannelDifferenceEmpty', pts: answers.pts };
    },
    getMessages: async (_id: unknown, opts: any) => {
      fetched.push(opts);
      return opts.ids.map((id: number) => msg(id));
    },
  };
  const out: string[] = [];
  w.on('message', (m: any) => out.push(m.id));
  return { w, invoked, fetched, out };
}
const TNC = '-1002886512914';

describe('TelegramWrapper.syncChannel', () => {
  it('seeds pts from the full channel, feeds the difference oldest first, and advances pts', async () => {
    const { w, invoked, fetched, out } = wrapper({
      pts: 10,
      diffs: [
        { className: 'updates.ChannelDifference', pts: 12, newMessages: [{ className: 'Message', id: 102 }, { className: 'Message', id: 101 }, { className: 'MessageService', id: 103 }] },
        { className: 'updates.ChannelDifferenceEmpty', pts: 12 },
      ],
    });
    await w.syncChannel(TNC);
    expect(invoked.map((r) => r.className)).toEqual(['channels.GetFullChannel', 'updates.GetChannelDifference']);
    expect(invoked[1].pts).toBe(10);
    expect(fetched).toEqual([{ ids: [101, 102] }]);
    expect(out).toEqual([`telegram:${TNC}:101`, `telegram:${TNC}:102`]);
    await w.syncChannel(TNC);
    expect(invoked[2].className).toBe('updates.GetChannelDifference');
    expect(invoked[2].pts).toBe(12);
    expect(fetched).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it('skips ids the live stream already delivered and never polls a chat that is not a channel', async () => {
    const { w, fetched, invoked } = wrapper({
      pts: 10,
      diffs: [{ className: 'updates.ChannelDifference', pts: 11, newMessages: [{ className: 'Message', id: 5 }, { className: 'Message', id: 6 }] }],
    });
    (w as any).noteSeen(TNC, 5, 'push');
    await w.syncChannel(TNC);
    expect(fetched).toEqual([{ ids: [6] }]);
    (w as any).client.getInputEntity = async () => ({ className: 'InputPeerChat', chatId: 9 });
    w.watchList = () => [TNC, '-1001111111111'];
    const before = invoked.length;
    await w.syncChannel('-1001111111111');
    await w.pollTick(Date.now() + 60_000);
    expect(invoked.length).toBe(before + 1); // the tick synced TNC again; the basic group was never asked
  });
});

describe('TelegramWrapper.pollTick', () => {
  it('polls a chat every 30s until a poll finds a message the live stream never pushed, then every 2s', async () => {
    const { w, invoked } = wrapper({ pts: 10, diffs: [] });
    w.watchList = () => [TNC];
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    await w.pollTick(t0);
    const diffs = () => invoked.filter((r) => r.className === 'updates.GetChannelDifference').length;
    expect(diffs()).toBe(1);
    await w.pollTick(t0 + 5_000);
    expect(diffs()).toBe(1); // not due yet: nothing has shown this chat needs a tight poll
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 31_000);
    (w as any).client.invoke = async (req: any) => {
      invoked.push(req);
      return { className: 'updates.ChannelDifference', pts: 11, newMessages: [{ className: 'Message', id: 50 }] };
    };
    await w.pollTick(t0 + 31_000);
    expect(diffs()).toBe(2);
    expect(w.pollInterval(TNC, t0 + 31_000)).toBe(2_000);
    await w.pollTick(t0 + 32_000);
    expect(diffs()).toBe(2);
    await w.pollTick(t0 + 33_500);
    expect(diffs()).toBe(3);
    // a live push later on says the chat is delivered after all: back to the slow safety net
    (w as any).noteSeen(TNC, 60, 'push');
    expect(w.pollInterval(TNC, t0 + 35_000)).toBe(30_000);
    vi.restoreAllMocks();
  });

  it('pauses every poll for the time Telegram asks in a FLOOD_WAIT', async () => {
    const { w, invoked } = wrapper({ pts: 10, diffs: [Object.assign(new Error('FLOOD_WAIT_7'), { seconds: 7 })] });
    w.watchList = () => [TNC, '-1002222222222'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = Date.now();
    await w.pollTick(t0);
    expect(invoked.filter((r) => r.className === 'updates.GetChannelDifference')).toHaveLength(1);
    await w.pollTick(t0 + 3_000);
    expect(invoked.filter((r) => r.className === 'updates.GetChannelDifference')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[telegram] channel sync: Telegram asks for a 7s pause');
    warn.mockRestore();
  });
});
