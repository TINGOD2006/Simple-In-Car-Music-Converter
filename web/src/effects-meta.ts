/**
 * UI-side effect metadata.
 *
 * Mirrors the 14 effects declared in `src/core/effects.ts` — same `type` strings,
 * same parameter names, same stage ordering. It is duplicated (rather than
 * imported) so the web package builds standalone. The UI uses this ONLY to render
 * controls and to build `EffectInstance` *data*; it never builds an ffmpeg filter
 * string, because the UI does no DSP.
 */

import type { EffectInstance, EffectType } from './api-types.ts';
import { newId } from './edits.ts';

export type ParamKind = 'number' | 'select' | 'bands';

export interface ParamSpec {
  key: string;
  label: string;
  kind: ParamKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

export interface EffectMeta {
  type: EffectType;
  label: string;
  /** Same ordering contract as the engine: repair→denoise→eq→dynamics→space→gain→speed. */
  stage: number;
  /** Sensible starting values used when the effect is added. */
  defaults: () => EffectInstance;
  params: ParamSpec[];
}

function base(type: EffectType): { id: string; enabled: boolean; type: EffectType } {
  return { id: newId('fx'), enabled: true, type };
}

export const EFFECT_META: Record<EffectType, EffectMeta> = {
  declip: {
    type: 'declip',
    label: 'De-clip',
    stage: 10,
    defaults: () => ({ ...base('declip'), type: 'declip' }),
    params: [],
  },
  declick: {
    type: 'declick',
    label: 'De-click',
    stage: 10,
    defaults: () => ({ ...base('declick'), type: 'declick', threshold: 2 }),
    params: [{ key: 'threshold', label: 'Threshold', kind: 'number', min: 1, max: 10, step: 0.5 }],
  },
  reverse: {
    type: 'reverse',
    label: 'Reverse',
    stage: 10,
    defaults: () => ({ ...base('reverse'), type: 'reverse' }),
    params: [],
  },
  denoise: {
    type: 'denoise',
    label: 'Noise reduction',
    stage: 20,
    defaults: () => ({ ...base('denoise'), type: 'denoise', strength: 'gentle' }),
    params: [
      {
        key: 'strength',
        label: 'Strength',
        kind: 'select',
        options: [
          { value: 'gentle', label: '溫和 (gentle)' },
          { value: 'moderate', label: '中等 (moderate)' },
          { value: 'strong', label: '強 (strong)' },
        ],
      },
    ],
  },
  eq: {
    type: 'eq',
    label: 'Equalizer',
    stage: 30,
    defaults: () => ({
      ...base('eq'),
      type: 'eq',
      bands: [{ freq: 1000, gainDb: 0, widthOctaves: 1 }],
    }),
    params: [{ key: 'bands', label: 'Bands', kind: 'bands' }],
  },
  highpass: {
    type: 'highpass',
    label: 'High-pass',
    stage: 30,
    defaults: () => ({ ...base('highpass'), type: 'highpass', freq: 80 }),
    params: [{ key: 'freq', label: 'Frequency', kind: 'number', min: 20, max: 20000, step: 10, unit: 'Hz' }],
  },
  lowpass: {
    type: 'lowpass',
    label: 'Low-pass',
    stage: 30,
    defaults: () => ({ ...base('lowpass'), type: 'lowpass', freq: 16000 }),
    params: [{ key: 'freq', label: 'Frequency', kind: 'number', min: 20, max: 20000, step: 10, unit: 'Hz' }],
  },
  compressor: {
    type: 'compressor',
    label: 'Compressor',
    stage: 40,
    defaults: () => ({ ...base('compressor'), type: 'compressor', thresholdDb: -18, ratio: 3 }),
    params: [
      { key: 'thresholdDb', label: 'Threshold', kind: 'number', min: -60, max: 0, step: 1, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', kind: 'number', min: 1, max: 20, step: 0.5 },
    ],
  },
  limiter: {
    type: 'limiter',
    label: 'Limiter',
    stage: 40,
    defaults: () => ({ ...base('limiter'), type: 'limiter', limitDb: -1 }),
    params: [{ key: 'limitDb', label: 'Ceiling', kind: 'number', min: -12, max: 0, step: 0.1, unit: 'dB' }],
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    stage: 50,
    defaults: () => ({ ...base('reverb'), type: 'reverb', preset: 'small-room', mix: 0.25 }),
    params: [
      {
        key: 'preset',
        label: 'Preset',
        kind: 'select',
        options: [
          { value: 'small-room', label: 'Small room' },
          { value: 'large-hall', label: 'Large hall' },
          { value: 'plate', label: 'Plate' },
          { value: 'cathedral', label: 'Cathedral' },
        ],
      },
      { key: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.05 },
    ],
  },
  echo: {
    type: 'echo',
    label: 'Echo',
    stage: 50,
    defaults: () => ({ ...base('echo'), type: 'echo', delayMs: 250, decay: 0.4 }),
    params: [
      { key: 'delayMs', label: 'Delay', kind: 'number', min: 1, max: 2000, step: 10, unit: 'ms' },
      { key: 'decay', label: 'Decay', kind: 'number', min: 0, max: 1, step: 0.05 },
    ],
  },
  gain: {
    type: 'gain',
    label: 'Gain',
    stage: 60,
    defaults: () => ({ ...base('gain'), type: 'gain', gainDb: 0 }),
    params: [{ key: 'gainDb', label: 'Gain', kind: 'number', min: -24, max: 24, step: 0.5, unit: 'dB' }],
  },
  normalize: {
    type: 'normalize',
    label: 'Peak normalize',
    stage: 60,
    defaults: () => ({ ...base('normalize'), type: 'normalize', targetPeakDb: -1 }),
    params: [{ key: 'targetPeakDb', label: 'Target peak', kind: 'number', min: -12, max: 0, step: 0.1, unit: 'dBTP' }],
  },
  speed: {
    type: 'speed',
    label: 'Speed',
    stage: 70,
    defaults: () => ({ ...base('speed'), type: 'speed', factor: 1 }),
    params: [{ key: 'factor', label: 'Factor', kind: 'number', min: 0.5, max: 2, step: 0.05, unit: '×' }],
  },
};

/** Display order = engine processing order, which is what the user should see. */
export const EFFECT_ORDER: EffectType[] = (
  Object.values(EFFECT_META) as EffectMeta[]
)
  .slice()
  .sort((a, b) => a.stage - b.stage || a.label.localeCompare(b.label))
  .map((m) => m.type);

export function makeEffect(type: EffectType): EffectInstance {
  return EFFECT_META[type].defaults();
}

/** Read a parameter off an effect instance without losing type safety. */
export function getParam(e: EffectInstance, key: string): string | number | undefined {
  const rec = e as unknown as Record<string, unknown>;
  const v = rec[key];
  if (typeof v === 'string' || typeof v === 'number') return v;
  return undefined;
}

/**
 * Apply a scalar parameter edit. Returns a new object — never mutates the input,
 * so the history snapshot stack stays valid.
 */
export function setParam(e: EffectInstance, key: string, value: string | number): EffectInstance {
  return { ...e, [key]: value } as EffectInstance;
}
