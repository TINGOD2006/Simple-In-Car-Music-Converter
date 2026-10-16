/**
 * Probing media files with ffprobe.
 *
 * ffprobe's JSON is requested with `-o <file>` rather than stdout, because
 * piped stdio is not available under the sandbox (see ffbin.ts).
 */

import { readFileSync, rmSync, statSync } from 'node:fs';
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
 * JSON, so a usable result is what decides success — not the exit code.
 *
 * But "no streams and no format" is not a usable result: it is what ffprobe
 * writes when it could not read the file at all. Accepting that turned every
 * unreadable file into a confident "no audio stream", which is how a listing
 * came to blame the audio inside files that nothing could open.
 */
function readProbeJson(path: string): RawProbe {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error('ffprobe wrote an empty result');
  let parsed: RawProbe;
  try {
    parsed = JSON.parse(text) as RawProbe;
  } catch (err) {
    throw new Error(
      `ffprobe wrote unparseable JSON: ${(err as Error).message}\n` +
        `First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (!parsed.streams && !parsed.format) {
    throw new Error('the file could not be read: no stream and no format information was produced');
  }
  return parsed;
}

/**
 * A name can be listed by `readdir` and still be impossible to open.
 *
 * The scan used to run ffprobe regardless; ffprobe then wrote `{}` and exited
 * non-zero, and the parser accepted it. Stat first, so an unopenable name is
 * reported as an unopenable name instead of as a streamless audio file.
 */
function assertReadable(file: string): void {
  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(
        `cannot open ${file}: it was listed when the folder was scanned but it is not there now.`,
      );
    }
    const detail = e.code && e.code !== 'UNKNOWN' ? `${e.code}: ${e.message}` : e.message;
    throw new Error(
      `cannot open ${file}: ${detail}. ` +
        'The folder lists this name, but the file cannot be opened and its data cannot be read. ' +
        'That usually means a damaged directory entry or a lost cluster chain, which FAT32 does ' +
        'when a device is unplugged while a file is still being written. ' +
        'The audio may still be intact — run chkdsk on the drive, or copy the file to another disk ' +
        'with a tool that can work around the bad entry.',
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `cannot open ${file}: it is a ${stat.isDirectory() ? 'directory' : 'special file'}, not a regular file.`,
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
  assertReadable(file);

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
