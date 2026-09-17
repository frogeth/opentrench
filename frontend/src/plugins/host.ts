import { routeCall, type PluginContext } from './route';

/** One call as the bridge sends it; anything that does not look like this never reaches the router. */
interface CallEnvelope {
  ot: 1;
  kind: 'call';
  id: number;
  method: string;
  args: unknown[];
}

export interface HostLoopOptions {
  ctx: PluginContext;
  /** send one message back into the frame; may throw when the value cannot be structured-cloned */
  post: (msg: unknown) => void;
  /** a plugin's call rate: `perSecond` sustained, `burst` in hand at once */
  budget?: { perSecond: number; burst: number };
  /** the serialized size of one call's arguments, refused above this */
  argsMax?: number;
  /** errors worth showing the user (a refused permission, an unknown method, a plugin talking too fast) */
  onError?: (text: string) => void;
  now?: () => number;
}

export interface HostLoop {
  handle(data: unknown): Promise<void>;
  dispose(): void;
}

const isCall = (d: unknown): d is CallEnvelope => {
  if (!d || typeof d !== 'object') return false;
  const m = d as Record<string, unknown>;
  return m.ot === 1 && m.kind === 'call' && Number.isInteger(m.id) && typeof m.method === 'string' && Array.isArray(m.args);
};

/**
 * The app side of one running plugin: every message from its frame passes through here before the
 * router sees it, and every answer goes back the same way. Held apart from the frame so the rules
 * that keep a plugin from drowning the app — a call budget, an argument cap, a reply that always
 * arrives — are plain functions to test rather than a component to render.
 */
export function createHostLoop({ ctx, post, budget = { perSecond: 60, burst: 120 }, argsMax = 256 * 1024, onError, now = Date.now }: HostLoopOptions): HostLoop {
  let tokens = budget.burst;
  let filled = now();
  let complained = -Infinity;
  let disposed = false;

  /** a token bucket: `perSecond` trickles in, `burst` is the most it ever holds */
  const spend = (): boolean => {
    const t = now();
    tokens = Math.min(budget.burst, tokens + ((t - filled) / 1000) * budget.perSecond);
    filled = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const reply = (id: number, out: { value: unknown } | { error: string }) => {
    if (disposed) return;
    try {
      post({ ot: 1, kind: 'result', id, ...out });
    } catch {
      // a value the structured clone cannot carry: the plugin's promise rejects instead of hanging forever
      try {
        post({ ot: 1, kind: 'result', id, error: 'result is not transferable' });
      } catch {
        /* the frame is gone; nothing left to tell */
      }
    }
  };

  return {
    async handle(data: unknown) {
      if (disposed || !isCall(data)) return;
      const { id, method, args } = data;
      let size = Infinity;
      try {
        size = JSON.stringify(args)?.length ?? 0;
      } catch {
        // cyclic or otherwise unmeasurable: too big to reason about is too big to route
      }
      if (size > argsMax) return reply(id, { error: 'arguments too large' });
      if (!spend()) {
        const t = now();
        // a plugin in a loop would otherwise file one complaint per refused call
        if (t - complained >= 1000) {
          complained = t;
          onError?.('too many calls');
        }
        return reply(id, { error: 'too many calls' });
      }
      try {
        const value = await routeCall(ctx, { method, args });
        reply(id, { value });
      } catch (err) {
        const error = (err as Error)?.message ?? String(err);
        // a bad argument is the plugin's own business; a refused permission or a method that does not
        // exist is the user's, and shows up next to the plugin in Settings
        if (/unknown method|permission/.test(error)) onError?.(error);
        reply(id, { error });
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
