/**
 * Effect registry: the single place that maps an effect instance to ffmpeg
 * filter syntax.
 *
 * Every effect declares its filter chain fragment and the order stage it
 * belongs to. The compiler sorts by stage, which keeps a stable, musically
 * sensible processing order no matter what order the UI added effects in:
 *
 *   repair -> denoise -> eq -> dynamics -> space -> gain -> speed
 */

import type { EffectInstance } from './types.ts';

/**
 * Processing stage; lower runs first.
 *
 * Declared as a const object rather than a TypeScript `enum` because Node's
 * type-stripping loader (which runs this project with no build step) rejects
 * enums: they emit runtime code and so are not erasable syntax.
 */
export const Stage = {
  Repair: 10,
  Denoise: 20,
  Eq: 30,
  Dynamics: 40,
  Space: 50,
  Gain: 60,
  Speed: 70,
} as const;

export type Stage = (typeof Stage)[keyof typeof Stage];

export interface EffectSpec {
  type: EffectInstance['type'];
  label: string;
  stage: Stage;
  /** Build the ffmpeg filter chain fragment. May return '' for no-op. */
  build(e: EffectInstance, ctx?: BuildContext): string;
}

/**
 * Out-parameter for build-time diagnostics.
 *
 * `build()` returns a string, so it has no other way to tell the caller that it
 * had to clamp a value the UI let through. Without this the user's slider could
 * silently produce different audio than the number they set.
 */
export interface BuildContext {
  warnings: string[];
}

/**
 * Clamp a value into ffmpeg's accepted range.
 *
 * Out-of-range values are not cosmetic: `adeclick=threshold=0`,
 * `atempo=0.25`, `alimiter=limit=1.5` and `aecho=...:0:0` all make ffmpeg exit
 * non-zero, which fails the entire export with nothing but an exit code. Clamping
 * keeps the export alive and records a warning instead.
 */
function clamp(v: number, lo: number, hi: number, what: string, ctx?: BuildContext): number {
  if (!Number.isFinite(v)) {
    ctx?.warnings.push(`${what} is not a number; using ${lo}`);
    return lo;
  }
  if (v < lo) {
    ctx?.warnings.push(`${what} was clamped from ${v} to the minimum ${lo}`);
    return lo;
  }
  if (v > hi) {
    ctx?.warnings.push(`${what} was clamped from ${v} to the maximum ${hi}`);
    return hi;
  }
  return v;
}

function db(v: number): string {
  return `${v}dB`;
}

function n(v: number): string {
  // Keep ffmpeg filter args compact and free of exponent notation.
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
}

/** Map a denoise strength to afftdn parameters. */
export function denoiseParams(strength: 'gentle' | 'moderate' | 'strong'): string {
  switch (strength) {
    case 'gentle':
      return 'afftdn=nr=6:nf=-40:tn=1';
    case 'moderate':
      return 'afftdn=nr=12:nf=-35:tn=1';
    case 'strong':
      return 'afftdn=nr=24:nf=-30:tn=1';
  }
}

/**
 * Reverb presets, expressed as a multi-tap `aecho`.
 *
 * These are *not* convolution reverbs. This ffmpeg build's `afir` filter takes
 * its impulse response from a second **input stream** (`ir` is an integer index
 * into `nbirs` streams, not a file path), and feeding it a stream produces
 * silence — verified: `afir` output measured -91 dB for every `gtype`. A
 * multi-tap echo is the one reverb primitive that actually works here, and it
 * gives a real, measurable decay tail (0.45 s after a 0.4 s source, the tail
 * still measures about -50 dB instead of digital silence).
 *
 * `decays` are the per-tap amplitudes; they are scaled by the effect's `mix` so
 * the UI's wet/dry control behaves the way the user expects.
 */
export const REVERB_PRESETS: Record<
  'small-room' | 'large-hall' | 'plate' | 'cathedral',
  { delays: number[]; decays: number[] }
> = {
  'small-room': { delays: [23, 37, 53], decays: [0.3, 0.22, 0.15] },
  'large-hall': { delays: [63, 97, 137, 191], decays: [0.45, 0.34, 0.26, 0.18] },
  plate: { delays: [13, 29, 47, 71], decays: [0.4, 0.3, 0.22, 0.15] },
  cathedral: { delays: [89, 131, 181, 239, 307], decays: [0.55, 0.44, 0.35, 0.27, 0.2] },
};

export const EFFECTS: Record<EffectInstance['type'], EffectSpec> = {
  declip: {
    type: 'declip',
    label: 'De-clip',
    stage: Stage.Repair,
    build: () => 'adeclip',
  },
  declick: {
    type: 'declick',
    label: 'De-click',
    stage: Stage.Repair,
    build: (e, ctx) => {
      if (e.type !== 'declick') return '';
      // ffmpeg accepts 1..100; 0 aborts the whole render.
      return `adeclick=threshold=${n(clamp(e.threshold, 1, 100, 'declick threshold', ctx))}`;
    },
  },
  denoise: {
    type: 'denoise',
    label: 'Noise reduction',
    stage: Stage.Denoise,
    build: (e) => {
      if (e.type !== 'denoise') return '';
      return denoiseParams(e.strength);
    },
  },
  eq: {
    type: 'eq',
    label: 'Equalizer',
    stage: Stage.Eq,
    build: (e) => {
      if (e.type !== 'eq' || e.bands.length === 0) return '';
      // One `equalizer` filter per band, chained.
      return e.bands
        .map(
          (b) =>
            `equalizer=f=${n(b.freq)}:width_type=o:width=${n(b.widthOctaves)}:g=${n(b.gainDb)}`,
        )
        .join(',');
    },
  },
  compressor: {
    type: 'compressor',
    label: 'Compressor',
    stage: Stage.Dynamics,
    build: (e) => {
      if (e.type !== 'compressor') return '';
      return `acompressor=threshold=${db(e.thresholdDb)}:ratio=${n(e.ratio)}:attack=20:release=250:makeup=1`;
    },
  },
  limiter: {
    type: 'limiter',
    label: 'Limiter',
    stage: Stage.Dynamics,
    build: (e, ctx) => {
      if (e.type !== 'limiter') return '';
      // `alimiter` takes a linear limit in (0, 1]; 0 dB (limit 1.0) is the
      // ceiling, so anything above 0 dB has to be pulled back to it.
      const dbv = clamp(e.limitDb, -60, 0, 'limiter level', ctx);
      return `alimiter=limit=${n(Math.pow(10, dbv / 20))}`;
    },
  },
  echo: {
    type: 'echo',
    label: 'Echo',
    stage: Stage.Space,
    build: (e, ctx) => {
      if (e.type !== 'echo') return '';
      // A zero delay makes aecho fail outright.
      const delay = clamp(e.delayMs, 1, 9000, 'echo delay', ctx);
      return `aecho=0.8:0.9:${n(delay)}:${n(clamp(e.decay, 0, 1, 'echo decay', ctx))}`;
    },
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    stage: Stage.Space,
    // A multi-tap echo, not a convolution: this build's `afir` cannot take an
    // impulse response from a file and outputs silence when fed one. See
    // REVERB_PRESETS for the measurements behind that decision.
    build: (e, ctx) => {
      if (e.type !== 'reverb') return '';
      const preset = REVERB_PRESETS[e.preset];
      if (!preset) return '';
      const mix = clamp(e.mix, 0, 1, 'reverb mix', ctx);
      // Scale the tap amplitudes by `mix` so the wet level tracks the control.
      const decays = preset.decays.map((d) => Number((d * mix).toFixed(4)));
      return `aecho=1:1:${preset.delays.join('|')}:${decays.join('|')}`;
    },
  },
  gain: {
    type: 'gain',
    label: 'Gain',
    stage: Stage.Gain,
    build: (e) => {
      if (e.type !== 'gain' || e.gainDb === 0) return '';
      return `volume=${db(e.gainDb)}`;
    },
  },
  normalize: {
    type: 'normalize',
    label: 'Peak normalize',
    stage: Stage.Gain,
    // Peak normalization needs a measurement pass: the renderer measures the
    // clip's peak and feeds the correction in through `resolvedGainDb`, which
    // the compiler applies as a `volume` filter. Nothing to emit here.
    build: () => '',
  },
  reverse: {
    type: 'reverse',
    label: 'Reverse',
    stage: Stage.Repair,
    build: () => 'areverse',
  },
  highpass: {
    type: 'highpass',
    label: 'High-pass',
    stage: Stage.Eq,
    build: (e) => {
      if (e.type !== 'highpass') return '';
      return `highpass=f=${n(e.freq)}`;
    },
  },
  lowpass: {
    type: 'lowpass',
    label: 'Low-pass',
    stage: Stage.Eq,
    build: (e) => {
      if (e.type !== 'lowpass') return '';
      return `lowpass=f=${n(e.freq)}`;
    },
  },
  speed: {
    type: 'speed',
    label: 'Speed',
    stage: Stage.Speed,
    build: (e, ctx) => {
      if (e.type !== 'speed' || e.factor === 1) return '';
      // atempo's accepted range in this build is 0.5..100.
      return `atempo=${n(clamp(e.factor, 0.5, 100, 'speed factor', ctx))}`;
    },
  },
};

export interface BuiltChain {
  /** Comma-joined filter chain, without the leading [in]/[out] labels. */
  chain: string;
  /**
   * Non-fatal diagnostics raised while building, e.g. a parameter that had to be
   * clamped into ffmpeg's accepted range.
   */
  warnings: string[];
}

/**
 * Build the filter chain for one clip's effect list, in stage order.
 * Effects whose `build` returns '' are silently skipped (they are no-ops or are
 * handled by a separate pass).
 */
export function buildEffectChain(effects: EffectInstance[]): BuiltChain {
  const enabled = effects.filter((e) => e.enabled);
  const ordered = [...enabled].sort((a, b) => {
    const sa = EFFECTS[a.type].stage;
    const sb = EFFECTS[b.type].stage;
    if (sa !== sb) return sa - sb;
    return enabled.indexOf(a) - enabled.indexOf(b);
  });

  const parts: string[] = [];
  const warnings: string[] = [];
  const ctx: BuildContext = { warnings };
  for (const e of ordered) {
    const spec = EFFECTS[e.type];
    const frag = spec.build(e, ctx);
    if (frag) parts.push(frag);
  }
  return { chain: parts.join(','), warnings };
}
