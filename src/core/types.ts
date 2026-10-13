/**
 * Core data types for Audio USB Studio.
 *
 * Design rule: the EDL (edit decision list) is the single source of truth for
 * every edit. Nothing here mutates audio; audio is only produced at render time.
 */

export type ChannelCount = 1 | 2;

/** One decoded/probed audio stream. */
export interface StreamInfo {
  index: number;
  codecName: string;
  codecLongName: string;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  bitsPerRawSample: number | null;
  bitRate: number | null;
  durationSec: number | null;
}

export interface FormatInfo {
  formatName: string;
  formatLongName: string;
  durationSec: number;
  sizeBytes: number;
  bitRate: number | null;
  tags: Record<string, string>;
}

/** Result of probing one media file. */
export interface MediaInfo {
  path: string;
  streams: StreamInfo[];
  /** First audio stream, or null when the file has no audio. */
  audio: StreamInfo | null;
  format: FormatInfo;
  probedAt: string;
}

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

export type EffectType =
  | 'gain'
  | 'normalize'
  | 'eq'
  | 'reverb'
  | 'echo'
  | 'reverse'
  | 'denoise'
  | 'declick'
  | 'declip'
  | 'highpass'
  | 'lowpass'
  | 'compressor'
  | 'limiter'
  | 'speed';

interface EffectCommon {
  id: string;
  enabled: boolean;
}

export interface GainEffect extends EffectCommon {
  type: 'gain';
  gainDb: number;
}

export interface NormalizeEffect extends EffectCommon {
  type: 'normalize';
  /** Target true peak in dBTP, e.g. -1.0 */
  targetPeakDb: number;
}

export interface EqBand {
  /** Centre frequency in Hz. */
  freq: number;
  /** Gain in dB (positive = boost). */
  gainDb: number;
  /** Bandwidth in octaves. */
  widthOctaves: number;
}

export interface EqEffect extends EffectCommon {
  type: 'eq';
  bands: EqBand[];
}

export interface ReverbEffect extends EffectCommon {
  type: 'reverb';
  /** Impulse-response preset; resolved to a generated IR file at render time. */
  preset: 'small-room' | 'large-hall' | 'plate' | 'cathedral';
  mix: number;
}

export interface EchoEffect extends EffectCommon {
  type: 'echo';
  delayMs: number;
  decay: number;
}

export interface ReverseEffect extends EffectCommon {
  type: 'reverse';
}

export type DenoiseStrength = 'gentle' | 'moderate' | 'strong';

export interface DenoiseEffect extends EffectCommon {
  type: 'denoise';
  strength: DenoiseStrength;
}

export interface DeclickEffect extends EffectCommon {
  type: 'declick';
  threshold: number;
}

export interface DeclipEffect extends EffectCommon {
  type: 'declip';
}

export interface HighpassEffect extends EffectCommon {
  type: 'highpass';
  freq: number;
}

export interface LowpassEffect extends EffectCommon {
  type: 'lowpass';
  freq: number;
}

export interface CompressorEffect extends EffectCommon {
  type: 'compressor';
  thresholdDb: number;
  ratio: number;
}

export interface LimiterEffect extends EffectCommon {
  type: 'limiter';
  limitDb: number;
}

export interface SpeedEffect extends EffectCommon {
  type: 'speed';
  /** 1.0 = unchanged. Pitch is preserved (rubberband/atempo). */
  factor: number;
}

export type EffectInstance =
  | GainEffect
  | NormalizeEffect
  | EqEffect
  | ReverbEffect
  | EchoEffect
  | ReverseEffect
  | DenoiseEffect
  | DeclickEffect
  | DeclipEffect
  | HighpassEffect
  | LowpassEffect
  | CompressorEffect
  | LimiterEffect
  | SpeedEffect;

/* ------------------------------------------------------------------ */
/* EDL                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A clip references a half-open time range `[srcIn, srcOut)` of one source.
 * Clips in a timeline are played back-to-back in array order; a clip's
 * position on the timeline is implied by the durations of preceding clips.
 * That keeps edits (insert/delete/reorder) as pure array operations.
 */
export interface Clip {
  id: string;
  sourceId: string;
  srcIn: number;
  srcOut: number;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Crossfade with the *previous* clip, in seconds. */
  crossfadeInSec: number;
  effects: EffectInstance[];
  /** Optional label for the UI; never affects audio. */
  label?: string;
}

export interface Timeline {
  clips: Clip[];
  /** Working sample rate for the whole timeline. */
  sampleRate: number;
  channels: ChannelCount;
}

export interface SourceRef {
  id: string;
  path: string;
  info: MediaInfo;
}

export interface LoudnessTarget {
  enabled: boolean;
  /** Integrated loudness target in LUFS. */
  integratedLufs: number;
  /** True-peak ceiling in dBTP. */
  truePeakDb: number;
  /** Loudness range target. */
  lra: number;
}

export type ContainerFormat =
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'ogg'
  | 'm4a'
  | 'aac'
  | 'opus'
  | 'wma'
  | 'aiff';

export interface ExportPreset {
  container: ContainerFormat;
  codec: string;
  /** Used only for lossy codecs. */
  bitrateKbps: number | null;
  sampleRate: number;
  channels: ChannelCount;
  loudness: LoudnessTarget;
  id3v2Version: 3 | 4 | null;
  /** Batch-pipeline denoise stage. Deliberately conservative. */
  denoise: 'off' | 'gentle' | 'moderate';
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  sources: Record<string, SourceRef>;
  timeline: Timeline;
  export: ExportPreset;
}

/* ------------------------------------------------------------------ */
/* Job / render results                                                */
/* ------------------------------------------------------------------ */

export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  info: MediaInfo;
  measured: LoudnessMeasurement | null;
}
