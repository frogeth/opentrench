import { beforeEach, describe, expect, it } from 'vitest';
import { BRIDGE_SRC } from './bridge';

/** The bridge is a script that runs in the frame: load it once here and speak postMessage to it. */
let sent: any[] = [];
(window as any).postMessage = (d: any) => sent.push(d);
(0, eval)(BRIDGE_SRC);
const ot = (window as any).ot;
const reply = (d: unknown) => window.dispatchEvent(new MessageEvent('message', { data: d }));
const settled = (p: Promise<unknown>) => {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  return () => Promise.resolve().then(() => done);
};

beforeEach(() => {
  sent = [];
});

describe('the ot bridge', () => {
  it('announces its api version and sends one call per method', async () => {
    expect(ot.api).toBe(1);
    const p = ot.feed.token('0xabc');
    expect(sent).toEqual([{ ot: 1, kind: 'call', id: expect.any(Number), method: 'feed.token', args: ['0xabc'] }]);
    reply({ ot: 1, kind: 'result', id: sent[0].id, value: { address: '0xabc' } });
    expect(await p).toEqual({ address: '0xabc' });
  });

  it('gives a fetch result text() and json() helpers over the proxy fields', async () => {
    const p = ot.fetch('https://example.com/x');
    reply({ ot: 1, kind: 'result', id: sent[0].id, value: { status: 200, headers: {}, body: '{"ok":true}', truncated: false } });
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.truncated).toBe(false);
    expect(r.text()).toBe('{"ok":true}');
    expect(r.json()).toEqual({ ok: true });
  });

  it('turns an error result into a rejection', async () => {
    const p = ot.actions.copy('hi');
    reply({ ot: 1, kind: 'result', id: sent[0].id, error: 'this plugin did not ask for the actions permission' });
    await expect(p).rejects.toThrow('actions');
  });

  it('ignores messages that are not ours and results for ids it never sent', async () => {
    const p = ot.feed.tokens();
    const isSettled = settled(p);
    reply({ ot: 2, kind: 'result', id: sent[0].id, value: 'from somewhere else' });
    reply({ kind: 'result', id: sent[0].id, value: 'unmarked' });
    reply({ ot: 1, kind: 'result', id: sent[0].id + 1000, value: 'never asked' });
    expect(await isSettled()).toBe(false);
    reply({ ot: 1, kind: 'result', id: sent[0].id, value: [] });
    expect(await p).toEqual([]);
  });

  it('delivers events to subscribers until they unsubscribe, and shrugs off unknown event names', () => {
    const seen: unknown[] = [];
    const off = ot.feed.onMessage((m: unknown) => seen.push(m));
    const offToken = ot.feed.onToken(() => seen.push('token'));
    reply({ ot: 1, kind: 'event', name: 'message', data: { id: 'm1' } });
    reply({ ot: 1, kind: 'event', name: 'token', data: { address: '0xabc' } });
    reply({ ot: 1, kind: 'event', name: '__proto__', data: null });
    reply({ ot: 1, kind: 'event', name: 'nonsense', data: null });
    off();
    offToken();
    reply({ ot: 1, kind: 'event', name: 'message', data: { id: 'm2' } });
    expect(seen).toEqual([{ id: 'm1' }, 'token']);
  });
});
