/**
 * Pipeline compiler: EDL -> ffmpeg arguments.
 *
 * This is the heart of the engine and the most heavily tested part of it: it is a
 * pure function from (timeline, preset, resolved gains) to an argv array, so the
 * whole render plan can be asserted in unit tests without touching ffmpeg.
 */

import { buildEffectChain } from './effects.ts';
import { clipDuration } from './edl.ts';
import type { Clip, ExportPreset, Timeline } from './types.ts';

export interface CompileInput {
  timeline: Timeline;
  preset: ExportPreset;
  /** Source id -> absolute path on disk. */
  sourcePaths: Record<string, string>;
  /**
   * Per-clip gain resolved by a measurement pass, in dB, added on top of the
   * clip's own `gainDb`. Used for peak normalization.
   */
  resolvedGainDb?: Record<string, number>;
  /** Absolute paths for impulse responses, keyed by preset name. */
  impulsePaths?: Record<string, string>;
  /** Output file path. */
  outputPath: string;
  /** Metadata tags to write. */
  tags?: Record<string, string>;
  /**
   * Loudness normalization: when set, a two-pass loudnorm is applied to the
   * *mixed* program. `measured` must come from a prior measure pass.
   */
  loudnorm?: {
    measured: { inputI: number; inputTp: number; inputLra: number; inputThresh: number; targetOffset: number };
    integratedLufs: number;
    truePeakDb: number;
    lra: number;
  } | null;
  /**
   * Measurement pass: append a loudnorm analysis filter to the program chain
   * and write nothing. Used to obtain the values `loudnorm.measured` needs.
   */
  measure?: {
    integratedLufs: number;
    truePeakDb: number;
    lra: number;
  } | null;
  /**
   * Peak-measurement pass: append `volumedetect` to the program chain and write
   * nothing. Supplies the peak level that the `normalize` effect needs — without
   * it `normalize` cannot know how much gain to apply.
   */
  peakMeasure?: boolean;
}

export interface CompileResult {
  args: string[];
  /** Distinct source paths referenced, in input order. */
  inputs: string[];
  filterComplex: string;
  warnings: string[];
}

const SILENCE_SOURCE = '__silence__';

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
}

/**
 * Build the per-clip chain: trim -> fades -> effects -> gain.
 *
 * `preset.denoise` is applied here, not in the batch layer, so that a single
 * track exported from the editor sounds exactly like the same track exported by
 * the batch run. When the clip carries its own explicit denoise effect the
 * preset's is skipped — the user's choice wins.
 */
function buildClipChain(
  clip: Clip,
  resolvedGainDb: number | undefined,
  preset: ExportPreset,
  warnings: string[],
): string {
  const parts: string[] = [];

  const d = clipDuration(clip);
  parts.push(`atrim=start=${fmt(clip.srcIn)}:end=${fmt(clip.srcOut)}`);
  // Reset timestamps so downstream time-based filters see a zero-based stream.
  parts.push(`asetpts=N/SR/TB`);

  if (clip.effects.some((e) => e.type === 'reverse')) {
    // areverse must operate on the trimmed clip; harmless to include early.
    parts.push('areverse');
  }

  let effects = clip.effects.filter((e) => e.type !== 'reverse');
  const hasOwnDenoise = effects.some((e) => e.type === 'denoise' && e.enabled);
  if (preset.denoise !== 'off' && !hasOwnDenoise) {
    effects = [
      ...effects,
      { id: `preset-denoise-${clip.id}`, enabled: true, type: 'denoise', strength: preset.denoise },
    ];
  }

  const built = buildEffectChain(effects);
  if (built.chain) parts.push(built.chain);
  warnings.push(...built.warnings);

  // `resolvedGainDb` is this clip's already-resolved correction (looked up by
  // the caller); add it to the clip's own gain.
  const gain = clip.gainDb + (resolvedGainDb ?? 0);
  if (gain !== 0) parts.push(`volume=${fmt(gain)}dB`);

  // Fades are applied last so they shape the final clip level.
  if (clip.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${fmt(Math.min(clip.fadeInSec, d))}`);
  if (clip.fadeOutSec > 0) {
    const start = Math.max(0, d - clip.fadeOutSec);
    parts.push(`afade=t=out:st=${fmt(start)}:d=${fmt(clip.fadeOutSec)}`);
  }

  return parts.filter(Boolean).join(',');
}

/**
 * Compile a timeline into ffmpeg arguments.
 *
 * Sources are declared once each as `-i` inputs; clips then reference them by
 * input index. Silence clips are generated with `anullsrc` rather than an input
 * file, so a muted region costs nothing on disk.
 */
export function compile(input: CompileInput): CompileResult {
  const { timeline, preset, sourcePaths, outputPath } = input;
  const warnings: string[] = [];

  if (timeline.clips.length === 0) {
    throw new Error('Cannot render an empty timeline');
  }

  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const args: string[] = [];
  // Position in the ffmpeg input list (the order of the `-i` flags). Silence
  // occupies a slot here without contributing a path to `inputs`, which stays
  // a list of real files on disk.
  let inputCount = 0;

  const needSilence = timeline.clips.some((c) => c.sourceId === SILENCE_SOURCE);
  if (needSilence) {
    inputIndex.set(SILENCE_SOURCE, inputCount++);
    args.push(
      '-f', 'lavfi',
      '-t', fmt(timelineDurationSafe(timeline)),
      '-i', `anullsrc=r=${preset.sampleRate}:cl=${preset.channels === 1 ? 'mono' : 'stereo'}`,
    );
  }

  for (const clip of timeline.clips) {
    if (clip.sourceId === SILENCE_SOURCE) continue;
    if (inputIndex.has(clip.sourceId)) continue;
    const path = sourcePaths[clip.sourceId];
    if (!path) {
      throw new Error(`No path registered for source ${clip.sourceId}`);
    }
    inputIndex.set(clip.sourceId, inputCount++);
    inputs.push(path);
    args.push('-i', path);
  }

  const labels: string[] = [];
  const filters: string[] = [];

  timeline.clips.forEach((clip, i) => {
    const label = `c${i}`;
    labels.push(label);

    if (clip.sourceId === SILENCE_SOURCE) {
      const idx = inputIndex.get(SILENCE_SOURCE)!;
      filters.push(
        `[${idx}:a]atrim=start=0:end=${fmt(clipDuration(clip))},asetpts=N/SR/TB,` +
          `aformat=sample_fmts=fltp:channel_layouts=${preset.channels === 1 ? 'mono' : 'stereo'}[${label}]`,
      );
      return;
    }

    const idx = inputIndex.get(clip.sourceId)!;
    const chain = buildClipChain(clip, input.resolvedGainDb?.[clip.id], preset, warnings);
    filters.push(`[${idx}:a]${chain}[${label}]`);
  });

  // Join clips. Two clips join either with a crossfade or a hard concat.
  let mixed = labels[0]!;
  let pendingCrossfade = false;

  for (let i = 1; i < labels.length; i += 1) {
    const clip = timeline.clips[i]!;
    const next = labels[i]!;
    const outLabel = `m${i}`;

    if (clip.crossfadeInSec > 0) {
      filters.push(
        `[${mixed}][${next}]acrossfade=d=${fmt(clip.crossfadeInSec)}:c1=tri:c2=tri[${outLabel}]`,
      );
    } else {
      filters.push(`[${mixed}][${next}]concat=n=2:v=0:a=1[${outLabel}]`);
    }
    mixed = outLabel;
    pendingCrossfade = false;
  }
  void pendingCrossfade;

  // Program-level finishing: loudness, then format conversion.
  const tail: string[] = [];
  if (input.peakMeasure) {
    // Peak-measurement pass for the `normalize` effect: measure the program
    // exactly as it will be rendered and report the peak to the log.
    tail.push('volumedetect');
  } else if (input.measure) {
    // Measurement pass: analyse the program exactly as it will be rendered.
    //
    // `ebur128`, not `loudnorm`'s analysis mode: both implement BS.1770-4 and
    // report the same four numbers, but loudnorm runs its entire normalization
    // machinery to produce them. Through the real USB preset chain this pass is
    // 4868 ms with loudnorm and 1483 ms with ebur128 on a 240 s track (3.3x).
    // The two agree to within 0.09 LU on every source shape measured, well
    // inside the 1.5 LU verification tolerance. `peak=true` is required: without
    // it ebur128 prints no true peak and the second pass has no ceiling.
    tail.push('ebur128=peak=true');
  } else if (input.loudnorm) {
    const m = input.loudnorm.measured;
    // A non-finite measurement means the program is digital silence (ebur128
    // reports `I: -70.0 LUFS` / `Peak: -inf dBFS`). There is no gain that makes
    // silence louder, and ffmpeg rejects `measured_TP=-inf` outright with
    // "Result too large" and exits non-zero, so the normalization is skipped and
    // the silent program is encoded as-is.
    if (!Number.isFinite(m.inputI) || !Number.isFinite(m.inputTp)) {
      // nothing to normalize
    } else {
      // `linear=true` is only honoured while the target LRA is >= the measured LRA.
      // If the target is smaller, ffmpeg silently drops to dynamic mode: the
      // integrated level then misses the target and the dynamics get squeezed
      // (measured on a -30/-9/-30 dB source: LRA=11 -> -12.35 LUFS, off by 1.65 LU,
      // while LRA=22 -> -13.96 LUFS, off by 0.04, with the LRA preserved intact).
      // Raising the target to the source's own LRA keeps linear mode, which is what
      // actually preserves the music; a source narrower than the target is unaffected.
      const effectiveLra = Math.max(input.loudnorm.lra, m.inputLra);
      tail.push(
        `loudnorm=I=${fmt(input.loudnorm.integratedLufs)}` +
          `:TP=${fmt(input.loudnorm.truePeakDb)}` +
          `:LRA=${fmt(effectiveLra)}` +
          `:measured_I=${fmt(m.inputI)}` +
          `:measured_TP=${fmt(m.inputTp)}` +
          `:measured_LRA=${fmt(m.inputLra)}` +
          `:measured_thresh=${fmt(m.inputThresh)}` +
          `:offset=${fmt(m.targetOffset)}` +
          ':linear=true:print_format=summary',
      );
    }
  }

  tail.push(`aresample=${preset.sampleRate}`);
  tail.push(`aformat=sample_fmts=fltp:channel_layouts=${preset.channels === 1 ? 'mono' : 'stereo'}`);

  const programLabel = 'prog';
  filters.push(`[${mixed}]${tail.join(',')}[${programLabel}]`);

  const filterComplex = filters.join(';');

  const out: string[] = ['-hide_banner', '-y', ...args];
  out.push('-filter_complex', filterComplex);
  out.push('-map', `[${programLabel}]`);

  // Codec / container settings.
  out.push('-ar', String(preset.sampleRate));
  out.push('-ac', String(preset.channels));

  if (preset.bitrateKbps !== null && isLossy(preset.codec)) {
    out.push('-c:a', preset.codec, '-b:a', `${preset.bitrateKbps}k`);
    if (preset.codec === 'libmp3lame') {
      // Force CBR for the car-stereo requirement. With libmp3lame, `-b:a`
      // alone selects CBR; adding `-abr 1` would switch it to ABR and the
      // stream would come out at roughly half the requested bitrate.
      // `-minrate/-maxrate/-bufsize` pin the rate so the muxer advertises
      // the same constant bitrate the preset promised.
      out.push('-minrate', `${preset.bitrateKbps}k`);
      out.push('-maxrate', `${preset.bitrateKbps}k`);
      out.push('-bufsize', `${preset.bitrateKbps * 2}k`);
    }
  } else {
    out.push('-c:a', preset.codec);
  }

  if (preset.id3v2Version !== null) {
    out.push('-id3v2_version', String(preset.id3v2Version));
  }

  if (input.tags) {
    for (const [k, v] of Object.entries(input.tags)) {
      if (v === '') continue;
      out.push('-metadata', `${k}=${v}`);
    }
  }

  out.push(outputPath);

  return { args: out, inputs, filterComplex, warnings };
}

function timelineDurationSafe(t: Timeline): number {
  const d = t.clips.reduce((s, c) => s + clipDuration(c), 0);
  return d > 0 ? Number(d.toFixed(6)) : 1;
}

/**
 * Whether a codec throws audio away. Exported because the UI's preset list has to
 * agree with the engine about which targets are lossy, and `test/presets.test.ts`
 * pins the two together.
 */
export function isLossy(codec: string): boolean {
  return ['libmp3lame', 'libvorbis', 'libopus', 'aac', 'wmav2', 'libtwolame'].includes(codec);
}

/**
 * Compile the *measurement* pass for loudness normalization: analyse the same
 * program the render will produce, writing no audio. The returned argv is run
 * with `-report`; its loudnorm JSON summary supplies `loudnorm.measured`.
 */
export function compileMeasurePass(
  input: Omit<CompileInput, 'outputPath' | 'loudnorm'>,
  targets: { integratedLufs: number; truePeakDb: number; lra: number },
): string[] {
  const built = compile({
    ...input,
    loudnorm: null,
    measure: targets,
    outputPath: '-',
  });
  const args = [...built.args];
  // Replace the null-muxer placeholder path with an explicit null output.
  const outIdx = args.lastIndexOf('-');
  if (outIdx >= 0) args.splice(outIdx, 1);
  args.push('-f', 'null', '-');
  return args;
}
