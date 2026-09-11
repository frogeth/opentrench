/**
 * Built-in alert tones, synthesized with Web Audio so nothing is downloaded.
 * Each is short (< 0.6s) and distinct enough to tell columns apart by ear.
 */
export const SOUNDS = ['chirp', 'ping', 'coin', 'bell', 'blip', 'thud', 'alarm', 'laser'] as const;
export type SoundName = (typeof SOUNDS)[number];

type Osc = OscillatorType;

function tone(ctx: AudioContext, at: number, freq: number, dur: number, type: Osc = 'sine', gain = 0.25, glideTo?: number) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

const RECIPES: Record<SoundName, (ctx: AudioContext, t: number) => number> = {
  // the original favourites ping: two rising sines
  chirp: (ctx, t) => {
    tone(ctx, t, 880, 0.14);
    tone(ctx, t + 0.12, 1175, 0.25);
    return 0.4;
  },
  ping: (ctx, t) => {
    tone(ctx, t, 1568, 0.35, 'sine', 0.22);
    return 0.4;
  },
  coin: (ctx, t) => {
    tone(ctx, t, 988, 0.08, 'square', 0.12);
    tone(ctx, t + 0.08, 1319, 0.3, 'square', 0.12);
    return 0.4;
  },
  bell: (ctx, t) => {
    tone(ctx, t, 1047, 0.6, 'triangle', 0.25);
    tone(ctx, t, 2093, 0.4, 'sine', 0.08);
    return 0.65;
  },
  blip: (ctx, t) => {
    tone(ctx, t, 440, 0.06, 'square', 0.15);
    tone(ctx, t + 0.07, 660, 0.06, 'square', 0.15);
    return 0.15;
  },
  thud: (ctx, t) => {
    tone(ctx, t, 160, 0.3, 'sine', 0.5, 50);
    return 0.35;
  },
  alarm: (ctx, t) => {
    tone(ctx, t, 740, 0.12, 'sawtooth', 0.12);
    tone(ctx, t + 0.15, 740, 0.12, 'sawtooth', 0.12);
    tone(ctx, t + 0.3, 740, 0.12, 'sawtooth', 0.12);
    return 0.45;
  },
  laser: (ctx, t) => {
    tone(ctx, t, 1800, 0.25, 'sawtooth', 0.12, 200);
    return 0.3;
  },
};

let ctx: AudioContext | undefined;

/**
 * Master mute, owned by the 🔔/🔕 in the top bar. It lives here, inside the engine, so every
 * automatic sound (column alerts, J7 pings, mentions, favorite callers) obeys it without each
 * call site having to remember. Explicit "preview this tone" clicks pass `force`.
 */
let muted = (() => {
  try {
    return localStorage.getItem('trenchfeed.sound') === 'off';
  } catch {
    return false;
  }
})();
export function setMuted(m: boolean): void {
  muted = m;
}
export function isMuted(): boolean {
  return muted;
}

export function playSound(name: string, opts: { force?: boolean } = {}): void {
  if (muted && !opts.force) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const recipe = RECIPES[(name as SoundName) in RECIPES ? (name as SoundName) : 'ping'];
    recipe(ctx, ctx.currentTime);
  } catch {
    /* no audio */
  }
}
