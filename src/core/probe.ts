/**
 * Probing media files with ffprobe.
 *
 * ffprobe's JSON is requested with `-o <file>` rather than stdout, because
 * piped stdio is not available under the sandbox (see ffbin.ts).
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from './ffbin.ts';
import type { BinPaths } from './ffbin.ts';
import type { FormatInfo, MediaInfo, StreamInfo } from './types.ts';

interface RawStream {
  index?: number;
  codec_name?: string;
  codec_long_name?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bits_per_raw_sample?: string;
  bit_rate?: string;
  duration?: string;
  codec_type?: string;
}

interface RawFormat {
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

interface RawProbe {
  streams?: RawStream[];
  format?: RawFormat;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ffprobe exits non-zero for some merely-odd files while still writing valid
 * JSON, so the file's presence is what decides success — not the exit code.
 */
function readProbeJson(path: string): RawProbe {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error('ffprobe wrote an empty result');
  try {
    return JSON.parse(text) as RawProbe;
  } catch (err) {
    throw new Error(
      `ffprobe wrote unparseable JSON: ${(err as Error).message}\n` +
        `First 200 chars: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Probe one file.
 *
 * @param ffprobe  path to ffprobe.exe
 * @param file     media file to inspect
 * @param scratch  directory for the temporary JSON result
 */
export async function probe(
  ffprobe: string,
  file: string,
  scratch: string,
): Promise<MediaInfo> {
  const out = join(scratch, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  const result = await runFfmpeg(
    ffprobe,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-o', out,
      file,
    ],
    { cwd: scratch },
  );

  let raw: RawProbe;
  try {
    raw = readProbeJson(out);
  } catch (err) {
    const detail = result.report ? `\nffprobe report:\n${result.report.slice(-800)}` : '';
    throw new Error(`ffprobe failed on ${file}: ${(err as Error).message}${detail}`);
  } finally {
    rmSync(out, { force: true });
  }

  const streams: StreamInfo[] = (raw.streams ?? [])
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index ?? 0,
      codecName: s.codec_name ?? 'unknown',
      codecLongName: s.codec_long_name ?? '',
      sampleRate: num(s.sample_rate) ?? 0,
      channels: s.channels ?? 0,
      channelLayout: s.channel_layout ?? '',
      bitsPerRawSample: num(s.bits_per_raw_sample),
      bitRate: num(s.bit_rate),
      durationSec: num(s.duration),
    }));

  const fmt = raw.format ?? {};
  const format: FormatInfo = {
    formatName: fmt.format_name ?? 'unknown',
    formatLongName: fmt.format_long_name ?? '',
    durationSec: num(fmt.duration) ?? 0,
    sizeBytes: num(fmt.size) ?? 0,
    bitRate: num(fmt.bit_rate),
    tags: fmt.tags ?? {},
  };

  return {
    path: file,
    streams,
    audio: streams[0] ?? null,
    format,
    probedAt: new Date().toISOString(),
  };
}
