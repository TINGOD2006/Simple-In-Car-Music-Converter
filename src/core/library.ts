/**
 * Library scanning: turn a messy folder tree into a list of probed audio entries.
 *
 * Design notes:
 *  - Scanning is *read-only*: nothing here moves, renames or rewrites a file. The
 *    library is an index; decisions about what to do with it belong to the batch
 *    planner.
 *  - Every file is probed with `probe()`, which exchanges data through files
 *    rather than a stdout pipe (see ffbin.ts for why).
 *  - A file that cannot be probed never aborts the scan: it lands in `errors`
 *    and the walk continues. A music library with one broken file must still be
 *    usable.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { probe } from './probe.ts';
import { defaultConcurrency, mapPool } from './pool.ts';
import { isStagingName } from './staging.ts';
import type { MediaInfo } from './types.ts';

/**
 * Audio container/codec extensions the scanner accepts by default.
 *
 * Deliberately broad: a car stereo library collected over years contains every
 * format the owner ever ripped or downloaded, so the scanner must recognise them
 * all and let `probe()` decide whether the content is actually decodable.
 */
export const AUDIO_EXTENSIONS: string[] = [
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'm4a', 'mp4',
  // yt-dlp's bestaudio stream for most YouTube videos is Opus inside a WebM
  // container, so a finished download lands as `<name>.webm`. Without the
  // extension here the converter never sees the file and reports
  // 轉換報告中沒有這個檔案 on an otherwise perfect download.
  'webm', 'weba',
  'wma', 'aiff', 'aif', 'alac', 'ape', 'wv', 'tta', 'ac3', 'dts',
  'mka', 'amr', 'au', 'ra', 'rm', 'caf', 'mpc', 'spx',
  // Common cousins that show up in real collections.
  'mp2', 'm4b', 'm4r', 'asf', 'dff', 'dsf',
];

const EXT_SET: Set<string> = new Set(AUDIO_EXTENSIONS.map((e) => `.${e.toLowerCase()}`));

/** True when the path's extension is a recognised audio container. */
export function isAudioFile(p: string): boolean {
  return EXT_SET.has(extname(p).toLowerCase());
}

export interface LibraryEntry {
  /** Stable id derived from the absolute path; stable across scans. */
  id: string;
  path: string;
  info: MediaInfo;
  /**
   * Acoustic fingerprint, filled in by the batch analyser when dedup is requested.
   * Absent means "not computed"; `null` means "computed and unavailable".
   */
  fp?: string | null;
}

export interface ScanResult {
  entries: LibraryEntry[];
  errors: { path: string; message: string }[];
}

/**
 * Stable, collision-resistant id for a path.
 *
 * Hashing the normalised absolute path (rather than using the path itself as the
 * id) keeps ids short in reports and manifests while staying deterministic, so
 * re-scanning the same tree yields the same ids and a saved manifest still
 * matches.
 */
export function entryId(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  const norm = normalize(abs).replace(/\\/g, '/').toLowerCase();
  return 'L' + createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

/**
 * Create a directory, tolerating sandboxes that deny `mkdir`.
 *
 * Returns the path either way: a caller that gets the path back and then fails to
 * write into it will surface a clearer error than one that threw during setup.
 */
export function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* Some sandboxes deny mkdir; the caller may already have created it. */
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

function walk(
  dir: string,
  exts: Set<string>,
  recursive: boolean,
  out: string[],
  errors: { path: string; message: string }[],
  visited: Set<string>,
): void {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ path: dir, message: (err as Error).message });
    return;
  }

  for (const d of dirents) {
    // Skip staging files by NAME, before any extension test. `batch.ts` names its
    // temporary `<original>.aus-tmp-<6 chars><ext>` — it keeps the target extension
    // so ffmpeg can pick a muxer, so `extname()` alone sees `.mp3` and a leftover
    // from a crashed run would be scanned as a track and renamed onto the real file
    // (INCIDENT-2026-10-16, defect 2: the manufactured `(2)` duplicate). Checked
    // before the directory test too, so a staging-named directory is not descended.
    if (isStagingName(d.name)) continue;

    const full = join(dir, d.name);
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      // Follow links only if they resolve to a real file/dir, and never twice:
      // a link loop would otherwise make the walk non-terminating.
      try {
        const real = realpathSync(full);
        if (visited.has(real)) continue;
        visited.add(real);
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (err) {
        errors.push({ path: full, message: (err as Error).message });
        continue;
      }
    }

    if (isDir) {
      if (!recursive) continue;
      if (!d.isSymbolicLink()) {
        let real = full;
        try {
          real = realpathSync(full);
        } catch {
          /* keep the plain path */
        }
        if (visited.has(real)) continue;
        visited.add(real);
      }
      walk(full, exts, recursive, out, errors, visited);
    } else if (isFile) {
      if (exts.has(extname(d.name).toLowerCase())) out.push(full);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

export interface ScanOptions {
  roots: string[];
  ffprobe: string;
  scratch: string;
  /** Extension allow-list (with or without the leading dot). Defaults to AUDIO_EXTENSIONS. */
  extensions?: string[];
  /** Recurse into subdirectories. Defaults to true. */
  recursive?: boolean;
  /**
   * How many files to probe at once. Defaults to the device-safe cap in
   * pool.ts — probing one at a time measured 0.80 s per file, which is what made
   * a 200-file stick look like it had hung.
   */
  concurrency?: number;
  /**
   * The prober, injectable so tests can exercise the scan's concurrency and
   * ordering without spawning hundreds of ffprobe processes.
   */
  probeFile?: (ffprobe: string, path: string, scratch: string) => Promise<MediaInfo>;
  onProgress?: (done: number, total: number, path: string) => void;
}

/** One file's fate, kept separate from the aggregate so ordering stays explicit. */
type ProbeOutcome =
  | { path: string; info: MediaInfo; error: null }
  | { path: string; info: null; error: string };

/**
 * Walk every root, probe every audio file, and return what was found.
 *
 * Files are sorted first, then probed with bounded concurrency, then reported in
 * that sorted order — so the listing is reproducible run to run even though the
 * probes finish in whatever order the device lets them.
 */
export async function scanLibrary(opts: ScanOptions): Promise<ScanResult> {
  const raw = opts.extensions ?? AUDIO_EXTENSIONS;
  const exts = new Set(raw.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  const recursive = opts.recursive ?? true;

  const errors: { path: string; message: string }[] = [];
  const files: string[] = [];

  for (const root of opts.roots) {
    const visited = new Set<string>();
    try {
      visited.add(realpathSync(root));
    } catch {
      /* root may not exist yet; readdirSync below will report it */
    }
    walk(root, exts, recursive, files, errors, visited);
  }

  files.sort();

  const runProbe = opts.probeFile ?? probe;
  const concurrency = Math.max(1, opts.concurrency ?? defaultConcurrency());

  let done = 0;
  const outcomes = await mapPool<string, ProbeOutcome>(files, concurrency, async (path) => {
    try {
      const info = await runProbe(opts.ffprobe, path, opts.scratch);
      return { path, info, error: null };
    } catch (err) {
      return { path, info: null, error: (err as Error).message };
    } finally {
      done += 1;
      opts.onProgress?.(done, files.length, path);
    }
  });

  const entries: LibraryEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== null) {
      errors.push({ path: outcome.path, message: outcome.error });
    } else if (!outcome.info.audio) {
      errors.push({ path: outcome.path, message: 'no audio stream' });
    } else {
      entries.push({ id: entryId(outcome.path), path: outcome.path, info: outcome.info });
    }
  }

  return { entries, errors };
}
