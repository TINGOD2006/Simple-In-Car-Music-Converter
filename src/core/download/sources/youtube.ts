/**
 * Resolving a YouTube URL into tracks, through the shipped `yt-dlp` (plan Task 5).
 *
 * Structured data never comes back on stdout: this process may run under a
 * sandbox that denies *piped* stdio to children, so `runYtDlp` discards stdout
 * and `--print-to-file` is the only channel that survives. `-J` is therefore not
 * merely unfashionable here, it silently yields nothing — which is why the
 * argument shape is asserted in the tests.
 *
 * Measured against yt-dlp 2026.08.19 on this machine:
 *   `--flat-playlist --simulate --print-to-file "<tpl>" <file> <url>` exit 0,
 *   one tab-separated line per entry (11 rows / 8,331 bytes for a real album);
 *   a dead video exits 1 and writes no file at all. The exit code plus stderr is
 *   therefore the entire diagnostic surface — there is no sidecar error file to
 *   read, and the spec's earlier claim that one exists was measured false.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyYtDlpFailure, runYtDlp, type RunYtDlpResult, type YtDlpFailureReason } from '../../ytdlp.ts';
import { DownloadFailure } from '../errors.ts';
import { parseYouTubeUrl } from '../parse.ts';
import { PLAYLIST_CAP, PlaylistTooLargeError } from '../resolve.ts';
import type { ResolvedSource, TrackMeta } from '../types.ts';

/**
 * The tab-separated columns `--print-to-file` writes.
 *
 * Real tab characters, not `\t` escapes: yt-dlp writes the template's literal
 * bytes, and a real tab is unambiguous either way (measured). `uploader,channel`
 * is yt-dlp's "first field that is not None" form, which is how the spec's
 * `uploader ?? channel` is expressed in one column.
 */
const TEMPLATE = ['%(id)s', '%(title)s', '%(uploader,channel)s', '%(duration)s', '%(thumbnails)j'].join('\t');

/** The columns, so a malformed row can never be read past its end. */
const COL_ID = 0;
const COL_TITLE = 1;
const COL_UPLOADER = 2;
const COL_DURATION = 3;
const COL_THUMBNAILS = 4;

/* ------------------------------------------------------------------ */
/* The injected seam                                                   */
/* ------------------------------------------------------------------ */

export interface YtDlpRunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Abort the child; the runner resolves with `cancelled`. */
  signal?: AbortSignal;
}

/**
 * Everything that would execute the real binary.
 *
 * Tests inject this so the whole resolve path is exercised offline; the real
 * `yt-dlp.exe` cannot even start in this sandbox (PyInstaller's onefile
 * self-extraction is refused), which makes the seam load-bearing rather than
 * merely tidy.
 */
export type YtDlpRunner = (args: string[], opts: YtDlpRunOptions) => Promise<RunYtDlpResult>;

export interface YouTubeResolveDeps {
  /** Path to `yt-dlp.exe`, as found by `findYtDlp`. */
  bin: string;
  /** Directory the child runs in; the row file is written here. */
  scratch: string;
  /** Injected by tests; defaults to the real runner. */
  run?: YtDlpRunner;
}

function resolveRunner(deps: YouTubeResolveDeps): YtDlpRunner {
  return deps.run ?? ((args, opts) => runYtDlp(deps.bin, args, opts));
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

/**
 * yt-dlp prints `NA` for a field the video does not carry, and JSON-encodes a
 * missing value as `null`. Both mean "absent", not "the literal string".
 */
function clean(value: string): string {
  const trimmed = value.trim();
  return trimmed === 'NA' || trimmed === 'null' || trimmed === 'None' ? '' : trimmed;
}

/** Last thumbnail's URL, or '' — an empty, malformed or truncated list is not fatal. */
function lastThumbnail(json: string): string {
  if (json === '') return '';
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return '';
    const last: unknown = parsed[parsed.length - 1];
    if (last === null || typeof last !== 'object') return '';
    const url = (last as { url?: unknown }).url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

function rowToMeta(line: string): TrackMeta | null {
  const cols = line.split('\t');
  const sourceId = clean(cols[COL_ID] ?? '');
  if (sourceId === '') return null;

  const seconds = Number(clean(cols[COL_DURATION] ?? ''));
  return {
    title: clean(cols[COL_TITLE] ?? ''),
    // yt-dlp carries no artist/album for YouTube sources; the channel is the artist.
    artists: clean(cols[COL_UPLOADER] ?? '') || 'YouTube',
    album: '',
    durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    coverUrl: lastThumbnail(clean(cols[COL_THUMBNAILS] ?? '')),
    sourceId,
  };
}

function readRows(file: string): TrackMeta[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No file at all is "nothing resolved", not a crash: a failed run writes none.
    return [];
  }
  const tracks: TrackMeta[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const meta = rowToMeta(line);
    if (meta) tracks.push(meta);
  }
  return tracks;
}

/* ------------------------------------------------------------------ */
/* Failure reporting                                                   */
/* ------------------------------------------------------------------ */

const FAILURE_MESSAGES: Record<YtDlpFailureReason, string> = {
  'ytdlp-missing': '找不到 yt-dlp.exe — 請執行 node tools/fetch-ytdlp.mjs',
  'video-unavailable': '這部影片無法使用（可能已刪除、設為私人或有區域限制）',
  'live-unsupported': '直播中的影片無法下載 — 請等直播結束後再試',
  'no-audio-format': '找不到可下載的音訊格式',
  'rate-limit': 'YouTube 要求確認不是自動程式 — 請稍後再試',
  'io-error': 'yt-dlp 執行失敗',
};

function failureMessage(reason: YtDlpFailureReason, stderr: string): string {
  const base = FAILURE_MESSAGES[reason];
  if (reason !== 'io-error') return base;
  const firstLine = stderr.split('\n').find((l) => l.trim() !== '');
  return firstLine ? `${base}：${firstLine.trim()}` : base;
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

/** A per-run row file; unique so two resolves in flight cannot collide. */
let rowCounter = 0;

function rowFile(scratch: string): string {
  rowCounter += 1;
  return join(scratch, `ytdlp-rows-${process.pid}-${rowCounter}.tsv`);
}

/**
 * Resolve an accepted YouTube URL into tracks.
 *
 * Rejecting an unaccepted URL is this function's job as well as the parser's:
 * `resolveYouTubeSource` is exported, so it cannot assume a caller ran
 * `detectPlatform` first.
 */
export async function resolveYouTubeSource(
  url: string,
  deps: YouTubeResolveDeps,
): Promise<ResolvedSource> {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) throw new DownloadFailure('unsupported-url', `無法辨識的 YouTube 連結：${url}`);

  const out = rowFile(deps.scratch);
  const result = await resolveRunner(deps)(
    ['--flat-playlist', '--simulate', '--no-warnings', '--print-to-file', TEMPLATE, out, url],
    { cwd: deps.scratch },
  );

  if (result.code !== 0) {
    const reason = classifyYtDlpFailure(result.code, result.stderr);
    throw new DownloadFailure(reason, failureMessage(reason, result.stderr));
  }

  const tracks = readRows(out);
  if (tracks.length === 0) {
    throw new DownloadFailure(
      'no-tracks',
      '這個連結沒有可下載的曲目（播放清單可能是空的，或所有曲目都無法存取）',
    );
  }
  if (tracks.length > PLAYLIST_CAP) throw new PlaylistTooLargeError(tracks.length);

  // yt-dlp reports no playlist title in this mode, and inventing one would lie
  // about which list was pasted — the id is at least exact and unique.
  const name = parsed.kind === 'video' ? (tracks[0]?.title ?? parsed.id) : parsed.id;
  return { platform: 'youtube', kind: parsed.kind, name, tracks };
}
