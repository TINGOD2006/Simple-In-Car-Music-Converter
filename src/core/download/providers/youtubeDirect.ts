/**
 * The `youtube-direct` route (plan Task 6): paste a YouTube URL, get the audio.
 *
 * yt-dlp decides the container, so the provider cannot name the file exactly:
 * `-o "<dir>/<artists> - <title>.%(ext)s"` lets the downloader append whatever
 * extension it actually produced, and the provider then *discovers* the result
 * by scanning for the known audio containers. Both the folder and the stem are
 * the provider's to build, because the queue hands `download()` a destination
 * directory and its skip rule looks for `<dir>/<artists> - <title><ext>`.
 * That is also why `rawExtensions` is a list here and not the single scalar it
 * used to be.
 *
 * Two yt-dlp behaviours this depends on, both measured (see the design spec):
 *   - `--force-overwrites` is required because the queue, not yt-dlp, owns the
 *     "an existing file over 1 KB counts as done" rule; without it a leftover
 *     500-byte stub would silently become the deliverable.
 *   - a cancelled download leaves `<name>.webm.part` — the extension survives
 *     into the partial's name — so cleanup cannot look for `<name>.part`.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { classifyYtDlpFailure, findYtDlp, runYtDlp } from '../../ytdlp.ts';
import { DownloadFailure } from '../errors.ts';
import { sanitizeFilename } from '../resolve.ts';
import { resolveYouTubeSource, ytDlpFailureMessage, type YtDlpRunner } from '../sources/youtube.ts';
import type { DownloadOpts, DownloadProvider, ResolvedSource, TrackMeta } from '../types.ts';

/**
 * Containers yt-dlp may land for `bestaudio`. `.ogg`/`.mp4`/`.mkv` are not
 * expected from this selector but cost nothing to recognise, and a miss here
 * would look like a failed download.
 */
const LANDED_EXTENSIONS: readonly string[] = ['.webm', '.m4a', '.ogg', '.mp4', '.mkv'];

const PART_SUFFIX = '.part';

export interface YoutubeDirectDeps {
  /** Path to `yt-dlp.exe`, as already resolved by the caller. */
  bin: string;
  /** Directory the child runs in. */
  scratch: string;
  /** Injected by tests; defaults to the real runner. */
  run?: YtDlpRunner;
  /**
   * Late lookup, used instead of `bin` when supplied — the seam that lets a
   * test prove "yt-dlp is not installed" without touching the filesystem.
   */
  find?: (explicit?: string) => string;
}

function missingBinary(): DownloadFailure {
  const reason = 'ytdlp-missing';
  return new DownloadFailure(reason, ytDlpFailureMessage(reason, ''));
}

function resolveBin(deps: YoutubeDirectDeps): string {
  if (deps.find) {
    let found = '';
    try {
      found = deps.find();
    } catch {
      throw missingBinary();
    }
    if (found) return found;
  }
  if (deps.bin) return deps.bin;
  try {
    return findYtDlp();
  } catch {
    throw missingBinary();
  }
}

/* ------------------------------------------------------------------ */
/* Discovering what landed                                             */
/* ------------------------------------------------------------------ */

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // a vanished directory is "nothing landed", not a crash
  }
}

function landedFiles(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const name of listDir(dir)) {
    if (!name.startsWith(base)) continue;
    if (!LANDED_EXTENSIONS.includes(name.slice(base.length))) continue;
    found.push(join(dir, name));
  }
  return found;
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Newest wins: a re-download and a fallback container can both be on disk. */
function newest(files: string[]): string {
  let best = files[0] as string;
  let bestAt = mtimeMs(best);
  for (const file of files.slice(1)) {
    const at = mtimeMs(file);
    if (at > bestAt) {
      best = file;
      bestAt = at;
    }
  }
  return best;
}

/** Remove `<base>.part` and `<base>.<ext>.part`; nothing else is ours to delete. */
function deletePartials(dir: string, base: string): void {
  for (const name of listDir(dir)) {
    if (!name.startsWith(base) || !name.endsWith(PART_SUFFIX)) continue;
    rmSync(join(dir, name), { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

export function createYoutubeDirectProvider(deps: YoutubeDirectDeps): DownloadProvider {
  function runnerFor(bin: string): YtDlpRunner {
    return deps.run ?? ((args, opts) => runYtDlp(bin, args, opts));
  }

  return {
    id: 'youtube-direct',
    rawExtensions: ['.webm', '.m4a'],

    resolve(url: string): Promise<ResolvedSource> {
      const bin = resolveBin(deps);
      return resolveYouTubeSource(url, { bin, scratch: deps.scratch, run: runnerFor(bin) });
    },

    async download(track: TrackMeta, destination: string, opts: DownloadOpts): Promise<{ rawPath: string }> {
      const bin = resolveBin(deps);
      const dir = destination;
      // The queue passes a destination FOLDER; the file name is the provider's
      // job, and it has to be the same one the queue's skip rule probes.
      const base = sanitizeFilename(`${track.artists} - ${track.title}`);
      mkdirSync(dir, { recursive: true });

      const args = [
        '-f',
        'bestaudio/best',
        '--no-playlist',
        '--force-overwrites',
        '-o',
        join(dir, `${base}.%(ext)s`),
        '--',
        track.sourceId,
      ];

      let result;
      try {
        result = await runnerFor(bin)(args, {
          cwd: deps.scratch,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        });
      } catch (err) {
        deletePartials(dir, base);
        throw new DownloadFailure('io-error', `yt-dlp 執行失敗：${(err as Error).message}`);
      }

      if (result.cancelled || opts.signal.aborted) {
        deletePartials(dir, base);
        throw new DownloadFailure('cancelled', '下載已取消');
      }

      if (result.code !== 0) {
        deletePartials(dir, base);
        const reason = classifyYtDlpFailure(result.code, result.stderr);
        throw new DownloadFailure(reason, ytDlpFailureMessage(reason, result.stderr));
      }

      const landed = landedFiles(dir, base);
      if (landed.length === 0) {
        // Exit 0 with no file means the format selector matched nothing usable.
        const reason = 'no-audio-format';
        throw new DownloadFailure(reason, ytDlpFailureMessage(reason, result.stderr));
      }
      return { rawPath: newest(landed) };
    },
  };
}
