/**
 * Loudness measurement (EBU R128 / ITU-R BS.1770-4).
 *
 * Two-pass normalization is mandatory for music: a single-pass loudnorm
 * compresses dynamic range because it must adjust while it measures. Pass 1
 * measures, pass 2 applies the measurement as static gain, which preserves the
 * dynamics the artist intended.
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

  const measured = parseLoudnormReport(result.report);
  if (!measured) {
    throw new Error(
      'Could not parse loudnorm summary from the ffmpeg report. ' +
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
 * and needs one number each, so the same loudnorm analysis runs straight on the
 * file.
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
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-map', '0:a:0',
    '-af',
    `loudnorm=I=${targets.integratedLufs}:TP=${targets.truePeakDb}:LRA=${targets.lra}:print_format=json`,
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

  const measured = parseLoudnormReport(result.report);
  if (!measured) {
    throw new Error(
      `Could not parse a loudnorm summary for ${filePath}. ` +
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
