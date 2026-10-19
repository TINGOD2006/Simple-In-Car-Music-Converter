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

/**
 * One parsed `--print-to-file` row, before it is shaped for either consumer.
 *
 * `durationSec` is already 0 when the field was absent and `artist` already
 * carries the `uploader ?? channel` fallback, because both consumers need the
 * same answers and must not each re-invent them.
 */
interface ParsedRow {
  sourceId: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnailUrl: string;
}

function parseRow(line: string): ParsedRow | null {
  const cols = line.split('\t');
  const sourceId = clean(cols[COL_ID] ?? '');
  if (sourceId === '') return null;

  const seconds = Number(clean(cols[COL_DURATION] ?? ''));
  return {
    sourceId,
    title: clean(cols[COL_TITLE] ?? ''),
    // yt-dlp carries no artist/album for YouTube sources; the channel is the artist.
    artist: clean(cols[COL_UPLOADER] ?? '') || 'YouTube',
    durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    thumbnailUrl: lastThumbnail(clean(cols[COL_THUMBNAILS] ?? '')),
  };
}

function rowToMeta(row: ParsedRow): TrackMeta {
  return {
    title: row.title,
    artists: row.artist,
    album: '',
    durationSec: row.durationSec,
    coverUrl: row.thumbnailUrl,
    sourceId: row.sourceId,
  };
}

/** Read a row file written by `--print-to-file`; a missing file means "no rows". */
function readRows(file: string): ParsedRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No file at all is "nothing resolved", not a crash: a failed run writes none.
    return [];
  }
  const rows: ParsedRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
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

/**
 * The zh-TW message for a failure reason.
 *
 * Exported because the download providers own failures too and must not keep a
 * second copy of the same user-facing copy — a drifted duplicate here would
 * reach the UI as two different explanations of one problem.
 */
export function ytDlpFailureMessage(reason: YtDlpFailureReason, stderr: string): string {
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
    throw new DownloadFailure(reason, ytDlpFailureMessage(reason, result.stderr));
  }

  const rows = readRows(out);
  if (rows.length === 0) {
    throw new DownloadFailure(
      'no-tracks',
      '這個連結沒有可下載的曲目（播放清單可能是空的，或所有曲目都無法存取）',
    );
  }
  if (rows.length > PLAYLIST_CAP) throw new PlaylistTooLargeError(rows.length);

  const tracks = rows.map(rowToMeta);

  // yt-dlp reports no playlist title in this mode, and inventing one would lie
  // about which list was pasted — the id is at least exact and unique.
  const name = parsed.kind === 'video' ? (tracks[0]?.title ?? parsed.id) : parsed.id;
  return { platform: 'youtube', kind: parsed.kind, name, tracks };
}

/**
 * A YouTube Music search result, shaped for `youtube-match`'s scorer.
 *
 * This type used to live in the vendor declarations because the search used to
 * come from a vendored package. Both are ours now, so the row shape is ours too.
 */
export interface YouTubeSongRow {
  videoId: string;
  title: string;
  artistName: string;
  /** Search rows carry no album; always ''. */
  albumName: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

/** How many candidates a match attempt scores; more only widens the wrong guess. */
export const SEARCH_LIMIT = 5;

/**
 * Search YouTube for `query`, returning scoring candidates.
 *
 * The invocation is deliberately identical to `resolveYouTubeSource`'s, with a
 * `ytsearch5:` pseudo-URL in place of a real one: it is the same
 * `--print-to-file` channel, and it is the direct route's own command shape
 * rather than a second, subtly different one.
 */
export async function searchYouTubeRows(
  query: string,
  deps: YouTubeResolveDeps,
): Promise<YouTubeSongRow[]> {
  const out = rowFile(deps.scratch);
  const result = await resolveRunner(deps)(
    [
      '--flat-playlist',
      '--simulate',
      '--no-warnings',
      '--print-to-file',
      TEMPLATE,
      out,
      `ytsearch${SEARCH_LIMIT}:${query}`,
    ],
    { cwd: deps.scratch },
  );

  if (result.code !== 0) {
    const reason = classifyYtDlpFailure(result.code, result.stderr);
    throw new DownloadFailure(reason, ytDlpFailureMessage(reason, result.stderr));
  }

  return readRows(out).map((row) => ({
    videoId: row.sourceId,
    title: row.title,
    artistName: row.artist,
    albumName: '',
    durationSec: row.durationSec > 0 ? row.durationSec : null,
    thumbnailUrl: row.thumbnailUrl === '' ? null : row.thumbnailUrl,
  }));
}
