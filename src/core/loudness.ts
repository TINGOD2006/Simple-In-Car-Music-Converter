/**
 * Loudness measurement (EBU R128 / ITU-R BS.1770-4).
 *
 * Two-pass normalization is mandatory for music: a single-pass loudnorm
 * compresses dynamic range because it must adjust while it measures. Pass 1
 * measures, pass 2 applies the measurement as static gain, which preserves the
 * dynamics the artist intended.
 *
 * The measuring pass uses `ebur128`, not `loudnorm`'s analysis mode. Both
 * implement BS.1770-4 and report the same four numbers, but loudnorm runs its
 * whole normalization machinery to produce them. Measured on a 240 s stereo
 * track through the real USB preset chain (denoise included): loudnorm 4868 ms
 * vs ebur128 1483 ms — 3.3x, and 36% of that file's total render time.
 */

import { compile, compileMeasurePass } from './compiler.ts';
import type { CompileInput } from './compiler.ts';
import { runFfmpeg } from './ffbin.ts';
import type { LoudnessMeasurement } from './types.ts';

/** Pull the loudnorm JSON summary out of an ffmpeg report log. */
export function parseLoudnormReport(report: string): LoudnessMeasurement | null {
  // The summary is a JSON object containing input_i / input_tp / input_lra.
  const blocks = report.match(/\{[^{}]*"input_i"[\s\S]*?\}/g);
  if (!blocks || blocks.length === 0) return null;

  // The last block is the final summary (ffmpeg may print progress blocks).
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const raw = blocks[i]!;
    const get = (key: string): number | null => {
      const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"(-?[0-9.]+)"`));
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    };
    const inputI = get('input_i');
    const inputTp = get('input_tp');
    const inputLra = get('input_lra');
    const inputThresh = get('input_thresh');
    if (inputI === null || inputTp === null || inputLra === null || inputThresh === null) continue;
    return {
      inputI,
      inputTp,
      inputLra,
      inputThresh,
      targetOffset: get('target_offset') ?? 0,
    };
  }
  return null;
}

/** Parse one of ffmpeg's `inf` / `-inf` / numeric readings. */
function toNumber(raw: string): number | null {
  const s = raw.toLowerCase();
  if (s === 'inf') return Infinity;
  if (s === '-inf') return -Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the loudness summary out of an `ebur128=peak=true` report log.
 *
 * ebur128 prints its summary in labelled sections and reuses the word
 * `Threshold:` in two of them, so each section is sliced out before matching —
 * a flat regex would read the loudness-range threshold as the integrated one.
 *
 * This is the parser for the *measuring* pass. `loudnorm` and `ebur128` agree
 * to within 0.09 LU on every source shape this tool converts (tone, pink noise,
 * mono, clipped, 22.05 kHz, and a 180 s program with 22.8 LU of range), which is
 * far inside the 1.5 LU verification tolerance.
 *
 * Digital silence is reported as `I: -70.0 LUFS` with `Peak: -inf dBFS`; the
 * peak survives as `-Infinity` so callers can skip normalization instead of
 * feeding `-inf` to the second pass, which ffmpeg rejects outright.
 */
export function parseEbur128Report(report: string): LoudnessMeasurement | null {
  const start = report.lastIndexOf('Integrated loudness');
  if (start < 0) return null;
  const rest = report.slice(start);

  const lraAt = rest.indexOf('Loudness range');
  const tpAt = rest.indexOf('True peak');
  const integrated = lraAt < 0 ? rest : rest.slice(0, lraAt);
  const range = lraAt < 0 ? '' : rest.slice(lraAt);
  const peak = tpAt < 0 ? '' : rest.slice(tpAt);

  const grab = (section: string, re: RegExp): number | null => {
    const m = section.match(re);
    return m ? toNumber(m[1]!) : null;
  };

  const inputI = grab(integrated, /I:\s*(-?(?:inf|[\d.]+))\s*LUFS/i);
  const inputThresh = grab(integrated, /Threshold:\s*(-?(?:inf|[\d.]+))\s*LUFS/i);
  const inputLra = grab(range, /LRA:\s*(-?(?:inf|[\d.]+))\s*LU/i);
  const inputTp = grab(peak, /Peak:\s*(-?(?:inf|[\d.]+))\s*dBFS/i);

  if (inputI === null || inputTp === null || inputLra === null || inputThresh === null) return null;
  // ebur128 has no target, so it reports no offset. The second pass runs in
  // `linear=true`, where the measured values carry the gain and the offset is
  // only a small correction: rendering the same 180 s program with the real
  // loudnorm offset (3.56) landed on -14.04 LUFS and with 0 on -13.94 LUFS.
  return { inputI, inputTp, inputLra, inputThresh, targetOffset: 0 };
}

export interface MeasureOptions {
  ffmpeg: string;
  scratch: string;
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

/**
 * Run the measurement pass and return the measured loudness.
 *
 * The program is compiled exactly as it will be rendered (same trims, effects
 * and joins) and sent to the null muxer, so the measurement reflects the actual
 * program rather than the raw source.
 */
export async function measureLoudness(
  input: Omit<CompileInput, 'outputPath' | 'loudnorm' | 'measure'>,
  opts: MeasureOptions,
): Promise<LoudnessMeasurement> {
  const targets = {
    integratedLufs: opts.integratedLufs,
    truePeakDb: opts.truePeakDb,
    lra: opts.lra,
  };
  const args = compileMeasurePass(input, targets);

  const result = await runFfmpeg(opts.ffmpeg, args, { cwd: opts.scratch });
  if (result.code !== 0) {
    throw new Error(
      `Loudness measurement failed (exit ${result.code})` +
        (result.report ? `\n${result.report.slice(-1200)}` : ''),
    );
  }
  if (!result.report) {
    throw new Error('Loudness measurement produced no ffmpeg report log');
  }

  const measured = parseEbur128Report(result.report);
  if (!measured) {
    throw new Error(
      'Could not parse an ebur128 summary from the ffmpeg report. ' +
        `Report tail:\n${result.report.slice(-800)}`,
    );
  }
  return measured;
}

export interface FileLoudnessTargets {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

/**
 * Measure one file's loudness directly, without building a timeline.
 *
 * {@link measureLoudness} measures a *program* — a compiled timeline with trims,
 * effects and joins. The library table has no timeline: it has hundreds of files
 * and needs one number each, so the same measurement runs straight on the file.
 *
 * `targets` is accepted but unused: `ebur128` measures the file as it is and
 * needs no target. The parameter is kept because the library table measures
 * hundreds of rows per scan and a caller that later wants to switch the filter
 * back should not have to change every call site.
 *
 * `-map 0:a:0` measures the first audio stream of a video container instead of
 * failing on the video stream, which is what a music folder full of `.mp4`
 * usually wants.
 *
 * Throws when the file cannot be decoded, so a caller can mark that one row as
 * failed rather than reporting a loudness of zero and normalising it to silence.
 */
export async function measureFileLoudness(
  ffmpeg: string,
  filePath: string,
  scratch: string,
  targets: FileLoudnessTargets,
): Promise<LoudnessMeasurement> {
  void targets;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', 'ebur128=peak=true',
    '-f', 'null',
    '-',
  ];

  const result = await runFfmpeg(ffmpeg, args, { cwd: scratch });
  if (result.code !== 0) {
    throw new Error(
      `Could not measure ${filePath} (ffmpeg exit ${result.code})` +
        (result.report ? `\n${result.report.slice(-1200)}` : ''),
    );
  }
  if (!result.report) {
    throw new Error(`Measuring ${filePath} produced no ffmpeg report log`);
  }

  const measured = parseEbur128Report(result.report);
  if (!measured) {
    throw new Error(
      `Could not parse an ebur128 summary for ${filePath}. ` +
        `Report tail:\n${result.report.slice(-800)}`,
    );
  }
  return measured;
}

/** Re-export so callers can build a measure-only argv in tests. */
export { compileMeasurePass, compile };

/* ------------------------------------------------------------------ */
/* Peak measurement (for the peak-normalize effect)                      */
/* ------------------------------------------------------------------ */

/**
 * Peak level in dBFS from a `volumedetect` report.
 *
 * Returns `null` when the filter did not report a level, and `-Infinity` for
 * digital silence (`max_volume: -inf dB`) — callers must treat the latter as
 * "nothing to normalize" rather than as a target to boost by an infinite amount.
 */
export function parseVolumedetectReport(report: string): number | null {
  const m = report.match(/max_volume:\s*(-?(?:inf|[\d.]+))\s*dB/i);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw === '-inf' || raw === 'inf') return raw.startsWith('-') ? -Infinity : Infinity;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a peak-measurement pass and return the program's true peak in dBFS.
 *
 * `volumedetect` is the only peak meter this build exposes that writes to the
 * report log, which is what this project's file-based child-process contract
 * requires (piped stdio is denied by the sandbox).
 */
export async function measurePeak(
  ffmpeg: string,
  args: string[],
  scratch: string,
): Promise<number | null> {
  const result = await runFfmpeg(ffmpeg, args, { cwd: scratch });
  if (result.code !== 0 || !result.report) return null;
  return parseVolumedetectReport(result.report);
}
