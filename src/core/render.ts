/**
 * Rendering: turn a compiled plan into an audio file, then verify it.
 *
 * Every render runs in its own scratch directory so ffmpeg's `-report` log
 * cannot be confused with another job's, and so concurrent batch workers never
 * collide.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from './compiler.ts';
import type { CompileInput, CompileResult } from './compiler.ts';
import { timelineDuration } from './edl.ts';
import { cleanupReports, runFfmpeg } from './ffbin.ts';
import type { BinPaths } from './ffbin.ts';
import { measureLoudness, measurePeak } from './loudness.ts';
import { probe } from './probe.ts';
import type { ExportPreset, MediaInfo, Timeline, VerifyResult } from './types.ts';

export interface RenderOptions {
  bins: BinPaths;
  /** Scratch root; a unique subdirectory is created per render. */
  scratchRoot: string;
  timeline: Timeline;
  preset: ExportPreset;
  sourcePaths: Record<string, string>;
  outputPath: string;
  tags?: Record<string, string>;
  /** Skip loudness normalization even when the preset enables it. */
  skipLoudness?: boolean;
  onProgress?: (stage: string) => void;
}

export interface RenderResult {
  ok: boolean;
  outputPath: string;
  durationSec: number;
  sizeBytes: number;
  compile: CompileResult;
  measured: Awaited<ReturnType<typeof measureLoudness>> | null;
  error: string | null;
}

function uniqueScratch(root: string, tag: string): string {
  const dir = join(root, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clips that ask for peak normalization, mapped to their target peak in dBFS.
 *
 * The first target wins per clip; a clip carrying several `normalize` effects is
 * a UI mistake, not a request to stack gain.
 */
function peakNormalizeTargets(timeline: Timeline): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of timeline.clips) {
    for (const e of c.effects) {
      if (e.type === 'normalize' && e.enabled && !out.has(c.id)) {
        out.set(c.id, e.targetPeakDb);
      }
    }
  }
  return out;
}

/** Render a timeline to `outputPath`. Never throws for a failed render. */
export async function render(opts: RenderOptions): Promise<RenderResult> {
  const scratch = uniqueScratch(opts.scratchRoot, 'render');
  const log = (s: string): void => opts.onProgress?.(s);

  try {
    const wantLoudness = opts.preset.loudness.enabled && !opts.skipLoudness;
    let measured: RenderResult['measured'] = null;

    const baseInput: Omit<CompileInput, 'outputPath'> = {
      timeline: opts.timeline,
      preset: opts.preset,
      sourcePaths: opts.sourcePaths,
      tags: opts.tags,
    };

    if (wantLoudness) {
      log('measuring loudness');
      measured = await measureLoudness(baseInput, {
        ffmpeg: opts.bins.ffmpeg,
        scratch,
        integratedLufs: opts.preset.loudness.integratedLufs,
        truePeakDb: opts.preset.loudness.truePeakDb,
        lra: opts.preset.loudness.lra,
      });
      cleanupReports(scratch);
    }

    // Peak normalization is a separate measurement: the `normalize` effect
    // needs the clip's own peak before it can know how much gain to apply.
    // Without this pass the effect compiled to nothing and silently did nothing.
    // Each clip is measured on its own — the program peak would be wrong for
    // every clip but the loudest one.
    const normalizeTargets = peakNormalizeTargets(opts.timeline);
    const resolvedGainDb: Record<string, number> = {};
    if (normalizeTargets.size > 0) {
      log('measuring peak');
      for (const [clipId, targetPeakDb] of normalizeTargets) {
        const clip = opts.timeline.clips.find((c) => c.id === clipId);
        if (!clip) continue;
        const solo = { ...opts.timeline, clips: [clip] };
        const peakArgs = compile({
          ...baseInput,
          timeline: solo,
          outputPath: '-',
          peakMeasure: true,
        }).args;
        // Swap the file output for the null muxer: this pass only measures.
        const outIdx = peakArgs.lastIndexOf('-');
        if (outIdx >= 0) peakArgs.splice(outIdx, 1);
        peakArgs.push('-f', 'null', '-');

        const peak = await measurePeak(opts.bins.ffmpeg, peakArgs, scratch);
        cleanupReports(scratch);
        if (peak !== null && Number.isFinite(peak)) {
          resolvedGainDb[clipId] = targetPeakDb - peak;
        } else if (peak === -Infinity) {
          // Digital silence: there is nothing to normalize and any gain would be
          // meaningless, so leave the clip untouched.
          log('peak normalization skipped: the clip is silent');
        }
      }
    }

    log('rendering');
    const compiled = compile({
      ...baseInput,
      outputPath: opts.outputPath,
      resolvedGainDb: Object.keys(resolvedGainDb).length > 0 ? resolvedGainDb : undefined,
      loudnorm: wantLoudness && measured
        ? {
            measured,
            integratedLufs: opts.preset.loudness.integratedLufs,
            truePeakDb: opts.preset.loudness.truePeakDb,
            lra: opts.preset.loudness.lra,
          }
        : null,
    });

    const run = await runFfmpeg(opts.bins.ffmpeg, compiled.args, { cwd: scratch });
    if (run.code !== 0 || !existsSync(opts.outputPath)) {
      return {
        ok: false,
        outputPath: opts.outputPath,
        durationSec: 0,
        sizeBytes: 0,
        compile: compiled,
        measured,
        error:
          `ffmpeg exited ${run.code}` +
          (run.report ? `\n${run.report.slice(-1500)}` : ' (no report log)'),
      };
    }

    const st = statSync(opts.outputPath);
    return {
      ok: true,
      outputPath: opts.outputPath,
      // `timelineDuration` (not a raw sum) because crossfades make the real
      // program shorter than the sum of the clip durations; a raw sum would
      // make verify() report a false duration mismatch on every crossfade.
      durationSec: timelineDuration(opts.timeline),
      sizeBytes: st.size,
      compile: compiled,
      measured,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      outputPath: opts.outputPath,
      durationSec: 0,
      sizeBytes: 0,
      compile: { args: [], inputs: [], filterComplex: '', warnings: [] },
      measured: null,
      error: (err as Error).message,
    };
  } finally {
    cleanupReports(scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export interface VerifyOptions {
  bins: BinPaths;
  scratchRoot: string;
  file: string;
  preset: ExportPreset;
  /** Expected program duration in seconds; checked with a tolerance. */
  expectedDurationSec?: number;
  /** Measured source loudness to compare against the target. */
  expectLoudness?: boolean;
}

const DURATION_TOLERANCE_SEC = 0.35;
const LUFS_TOLERANCE = 1.5;
const TP_TOLERANCE_DB = 1.0;

/**
 * Re-probe an output and assert it matches the preset.
 *
 * This exists because "ffmpeg exited 0" is not evidence that the file is
 * correct: a car stereo cares about container, bitrate, sample rate, channel
 * count and actual loudness, all of which are checked here.
 */
export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const scratch = uniqueScratch(opts.scratchRoot, 'verify');
  const problems: string[] = [];
  let info: MediaInfo;
  let measured: VerifyResult['measured'] = null;

  try {
    info = await probe(opts.bins.ffprobe, opts.file, scratch);

    if (!info.audio) {
      problems.push('output has no audio stream');
    } else {
      const a = info.audio;
      const p = opts.preset;

      if (a.sampleRate !== p.sampleRate) {
        problems.push(`sample rate is ${a.sampleRate} Hz, expected ${p.sampleRate} Hz`);
      }
      if (a.channels !== p.channels) {
        problems.push(`channel count is ${a.channels}, expected ${p.channels}`);
      }

      const expectedCodec = codecFamily(p.codec);
      if (expectedCodec && !a.codecName.toLowerCase().includes(expectedCodec)) {
        problems.push(`codec is ${a.codecName}, expected ${expectedCodec}`);
      }

      if (p.bitrateKbps !== null && p.container === 'mp3') {
        const br = a.bitRate ?? info.format.bitRate ?? 0;
        // CBR: allow a small tolerance for container overhead reporting.
        const target = p.bitrateKbps * 1000;
        if (br > 0 && Math.abs(br - target) > target * 0.05) {
          problems.push(
            `bitrate is ${Math.round(br / 1000)} kbps, expected ~${p.bitrateKbps} kbps (CBR)`,
          );
        }
      }
    }

    if (opts.expectedDurationSec !== undefined && info.format.durationSec > 0) {
      const delta = Math.abs(info.format.durationSec - opts.expectedDurationSec);
      if (delta > DURATION_TOLERANCE_SEC) {
        problems.push(
          `duration is ${info.format.durationSec.toFixed(3)}s, expected ` +
            `${opts.expectedDurationSec.toFixed(3)}s (delta ${delta.toFixed(3)}s)`,
        );
      }
    }

    if (opts.expectLoudness && opts.preset.loudness.enabled) {
      const tl: Timeline = { clips: [], sampleRate: opts.preset.sampleRate, channels: opts.preset.channels };
      const args = [
        '-hide_banner',
        '-i', opts.file,
        '-af', `loudnorm=I=${opts.preset.loudness.integratedLufs}:TP=${opts.preset.loudness.truePeakDb}:LRA=${opts.preset.loudness.lra}:print_format=json`,
        '-f', 'null', '-',
      ];
      void tl;
      const run = await runFfmpeg(opts.bins.ffmpeg, args, { cwd: scratch });
      if (run.report) {
        const { parseLoudnormReport } = await import('./loudness.ts');
        measured = parseLoudnormReport(run.report);
      }
      if (!measured) {
        problems.push('could not measure output loudness');
      } else {
        const dl = Math.abs(measured.inputI - opts.preset.loudness.integratedLufs);
        if (dl > LUFS_TOLERANCE) {
          problems.push(
            `integrated loudness is ${measured.inputI} LUFS, target ` +
              `${opts.preset.loudness.integratedLufs} LUFS (off by ${dl.toFixed(2)})`,
          );
        }
        if (measured.inputTp > opts.preset.loudness.truePeakDb + TP_TOLERANCE_DB) {
          problems.push(
            `true peak is ${measured.inputTp} dBTP, ceiling is ${opts.preset.loudness.truePeakDb} dBTP`,
          );
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      problems: [`verification failed: ${(err as Error).message}`],
      info: null as unknown as MediaInfo,
      measured: null,
    };
  } finally {
    cleanupReports(scratch);
    rmSync(scratch, { recursive: true, force: true });
  }

  return { ok: problems.length === 0, problems, info, measured };
}

function codecFamily(codec: string): string | null {
  switch (codec) {
    case 'libmp3lame':
      return 'mp3';
    case 'libvorbis':
      return 'vorbis';
    case 'libopus':
      return 'opus';
    case 'aac':
      return 'aac';
    case 'flac':
      return 'flac';
    case 'pcm_s16le':
      return 'pcm_s16le';
    case 'wmav2':
      return 'wmav2';
    default:
      return null;
  }
}
