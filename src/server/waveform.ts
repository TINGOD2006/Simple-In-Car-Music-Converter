/**
 * Waveform peak extraction.
 *
 * ffmpeg decodes a downmixed, downsampled PCM stream to a **file** (never a
 * pipe — piped stdio is denied by the sandbox, see docs/ENVIRONMENT.md §2.1),
 * and we read it back to build min/max peaks for the UI.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from '../core/ffbin.ts';

/** Sample rate used for peak extraction. Low on purpose: peaks do not need fidelity. */
const PEAK_RATE = 8000;

export interface WaveformResult {
  /** Normalised 0..1 peak magnitude per bucket. */
  peaks: number[];
  durationSec: number;
  buckets: number;
}

/**
 * Extract `buckets` normalised peaks from `file`.
 *
 * Returns an empty peak list rather than throwing when the file cannot be
 * decoded, so a bad library entry never takes down the UI.
 */
export async function waveform(
  ffmpeg: string,
  file: string,
  scratch: string,
  buckets = 2000,
): Promise<WaveformResult> {
  const n = Math.max(1, Math.min(20000, Math.floor(buckets)));
  const raw = join(scratch, `wave-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.raw`);

  try {
    const run = await runFfmpeg(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', file,
        '-vn',
        '-ac', '1',
        '-ar', String(PEAK_RATE),
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        raw,
      ],
      { cwd: scratch },
    );

    if (run.code !== 0 || !existsSync(raw)) {
      return { peaks: [], durationSec: 0, buckets: n };
    }

    const buf = readFileSync(raw);
    const samples = Math.floor(buf.length / 2);
    if (samples === 0) return { peaks: [], durationSec: 0, buckets: n };

    const perBucket = Math.max(1, Math.floor(samples / n));
    const peaks: number[] = [];
    let max = 0;

    for (let b = 0; b < n; b += 1) {
      const start = b * perBucket;
      if (start >= samples) break;
      const end = Math.min(samples, start + perBucket);
      let bucketPeak = 0;
      for (let i = start; i < end; i += 1) {
        const v = Math.abs(buf.readInt16LE(i * 2));
        if (v > bucketPeak) bucketPeak = v;
      }
      const norm = bucketPeak / 32768;
      peaks.push(norm);
      if (norm > max) max = norm;
    }

    // Normalise so quiet material still shows a readable waveform, but never
    // amplify a silent file into fake signal.
    if (max > 0 && max < 1) {
      for (let i = 0; i < peaks.length; i += 1) peaks[i] = peaks[i]! / max;
    }

    return {
      peaks,
      durationSec: samples / PEAK_RATE,
      buckets: peaks.length,
    };
  } catch {
    return { peaks: [], durationSec: 0, buckets: n };
  } finally {
    try {
      rmSync(raw, { force: true });
    } catch {
      /* best effort */
    }
  }
}
