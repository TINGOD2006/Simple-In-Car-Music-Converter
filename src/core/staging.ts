/**
 * Staging files: the crash-safe temporary names the batch engine renders into.
 *
 * Why this module exists
 * ----------------------
 * In overwrite mode `batch.ts` renders to `<original>.aus-tmp-<6 chars><ext>` in
 * the *same directory* as the original and then renames it over the original. The
 * target extension is deliberately preserved — ffmpeg cannot pick a muxer
 * otherwise — which means a leftover `Song.aus-tmp-u9nvkk.mp3` is indistinguishable
 * from an MP3 to anything that only looks at the extension. Two consequences:
 *
 *  1. The scanner must exclude these names, or a leftover from a crashed run is
 *     scanned as a track and then renamed onto the real file, manufacturing a
 *     `(2)` duplicate (docs/INCIDENT-2026-10-16-batch-failures.md, defect 2).
 *  2. A run that dies between "rendered" and "renamed" leaves one behind forever,
 *     wasting space on the stick. `sweepStaleStaging()` reclaims those, but only
 *     when it can prove the file is not still being written.
 *
 * `STAGING_MARK` is the single source of truth for both rules, so the scanner and
 * the sweeper can never drift apart about what a staging file is.
 */

import type { Dirent } from 'node:fs';
import { closeSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The infix every staging name carries, exactly as `batch.ts` writes it.
 *
 * Lower-case here; `isStagingName()` compares case-insensitively because the mark
 * travels through FAT32/exFAT volumes and Windows tools that do not preserve case.
 */
export const STAGING_MARK = '.aus-tmp-';

/**
 * Default staleness window: one hour.
 *
 * A render that is still running holds its staging file open, so rule (b) already
 * protects it; this window is the second, coarser guard for the case where the
 * writer died without releasing anything. An hour is far longer than any single
 * track render and far shorter than "the user will notice eventually".
 */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * True when a *name* (never a full path — callers must pass a basename) carries the
 * staging mark, case-insensitively.
 *
 * "Contains" rather than "starts with" or "ends with" on purpose: the real name is
 * `<original name>.aus-tmp-<random><extension>`, so the mark sits in the middle and
 * the surrounding text is arbitrary user data.
 */
export function isStagingName(name: string): boolean {
  return name.toLowerCase().includes(STAGING_MARK);
}

/**
 * Can this process open `file` for read+write right now?
 *
 * This is rule (b) of the sweep: anything we cannot open for write is treated as
 * "someone else is using it" and is left alone. Failing closed is the whole point —
 * a leftover staging file costs disk space, while deleting a file a render is still
 * writing destroys the only copy of that work.
 *
 * Empirically verified on Windows/Node (see docs/SPEC.md 9.4), because the limit
 * matters: libuv opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE |
 * FILE_SHARE_DELETE`, so an ordinary handle held by *this* process does NOT make a
 * second `openSync('r+')` fail, and `unlinkSync` would happily delete the file from
 * under it. Rule (b) therefore catches what the OS does enforce: an exclusive
 * holder in another process (EBUSY) and a breakage that makes the path unopenable
 * (the corrupt-directory-entry case from the incident report).
 */
function canOpenForWrite(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'r+');
  } catch {
    return false;
  }
  try {
    closeSync(fd);
  } catch {
    // A handle we cannot close is not a handle we are allowed to delete behind.
    return false;
  }
  return true;
}

export interface SweepResult {
  /**
   * Staging files that were proven stale and unlinked. Absolute paths, sorted.
   *
   * A path is reported here only if `unlinkSync` actually succeeded.
   */
  removed: string[];
  /**
   * Staging *files* that were found and deliberately left alone: too fresh, not
   * openable for write, or not removable. Absolute paths, sorted.
   *
   * Non-staging files and staging-named directories are not candidates at all and
   * are therefore never listed here — silence means "not our business".
   */
  kept: string[];
}

/**
 * Delete leftover staging files under `dirs`.
 *
 * Walks each directory recursively (staging files are written next to the original
 * they replace, which is wherever the music is) and removes a candidate only when
 * every one of these holds:
 *
 *  - it is a **regular file** — never a directory, never a symlink, never a device;
 *  - its name carries `STAGING_MARK` (case-insensitive) — non-staging files are
 *    never considered, however old or unreachable they are;
 *  - its mtime is older than `olderThanMs` (default one hour);
 *  - it can be opened for read+write, i.e. rule (b) above.
 *
 * This function never creates, never renames and never removes a directory, and it
 * never descends through a symbolic link (a link loop would make the walk
 * non-terminating, and the link may point outside the volumes the caller named).
 * An unreadable directory is skipped silently: a sweep is a cleanup, not a report.
 */
export function sweepStaleStaging(
  dirs: string[],
  olderThanMs: number = STAGING_MAX_AGE_MS,
): SweepResult {
  const removed: string[] = [];
  const kept: string[] = [];
  const cutoff = Date.now() - Math.max(0, olderThanMs);

  const consider = (file: string): void => {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      // Named like a staging file but unstat-able (corrupt directory entry, or it
      // vanished under us). We cannot prove it is stale, so we do not delete it.
      kept.push(file);
      return;
    }
    if (!stat.isFile()) return;
    if (!(stat.mtimeMs < cutoff)) {
      kept.push(file);
      return;
    }
    if (!canOpenForWrite(file)) {
      kept.push(file);
      return;
    }
    try {
      unlinkSync(file);
      removed.push(file);
    } catch {
      // Lost a race with another process that grabbed the file between our probe and
      // the unlink, or the directory entry is not ours to remove. Either way: keep it.
      kept.push(file);
    }
  };

  const walk = (dir: string): void => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      // Checked before anything else so a link is never followed: a link loop would
      // make this non-terminating, and the link may point outside the named volumes.
      // Directories are always recursed — even staging-named ones — but they are
      // never candidates themselves; only regular files can be removed.
      if (d.isSymbolicLink()) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        walk(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (!isStagingName(d.name)) continue;
      consider(full);
    }
  };

  for (const dir of dirs) walk(dir);

  removed.sort();
  kept.sort();
  return { removed, kept };
}
