/**
 * Batch USB engine: messy folder in, car-stereo-ready USB content + report out.
 *
 * Six stages, matching `runBatch`:
 *   1. scan    — walk the roots and probe every audio file
 *   2. analyze — fingerprint each file (only when dedup is requested)
 *   3. plan    — tags, filenames, duplicates, capacity
 *   4. render  — two-pass loudness-normalised encode, one job per file
 *   5. verify  — re-probe each output against the preset
 *   6. report  — a structured BatchReport, writable as manifest.json
 *
 * Hard requirements encoded here:
 *  - **Two-pass loudnorm.** `render()` measures the program, then re-encodes using
 *    those measured values as static gain. A single pass is never used as a
 *    fallback: if measurement fails, the item is reported as failed rather than
 *    silently compressing the dynamics. The rendered argv is asserted to carry
 *    `measured_I=` by the batch tests.
 *  - **Gentle denoise only.** `afftdn` at the preset's strength plus `adeclick`.
 *    DeepFilterNet is deliberately absent: measured on this machine it attenuated a
 *    440 Hz musical signal by 57 dB, which would silence an entire library.
 *  - **Per-job scratch.** Every render gets its own scratch directory so concurrent
 *    ffmpeg `-report` logs cannot be confused with one another.
 *  - **Isolation.** One file failing never aborts the batch; it becomes a `failed`
 *    report row and the run continues.
 */

import { basename, dirname, extname, join, resolve } from 'node:path';
import { realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { BinPaths } from './ffbin.ts';
import { defaultConcurrency, mapPool } from './pool.ts';
import { findDuplicates, fingerprint } from './dedup.ts';
import { entryId, ensureDir, scanLibrary } from './library.ts';
import type { LibraryEntry, ScanResult } from './library.ts';
import { makeClip, makeTimeline } from './edl.ts';
import { render, verify } from './render.ts';
import type { EffectInstance, ExportPreset, VerifyResult } from './types.ts';
import { deriveTagsFromFilename, mergeTags, planFilenames, readTags, repairMojibake } from './tags.ts';
import type { TagSet } from './tags.ts';

/* ------------------------------------------------------------------ */
/* Options and results                                                 */
/* ------------------------------------------------------------------ */

export interface BatchOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Scratch root. Each job gets its own subdirectory beneath it. */
  scratch: string;
  /** Directories to scan. */
  roots: string[];
  outputDir: string;
  /**
   * Convert each file *in place*, replacing the source.
   *
   * Off by default, and not a cosmetic switch: a real library is irreplaceable, so
   * each replacement is staged beside the original, verified, and only then moved
   * over it. `outputDir` is ignored in this mode; it stays required so switching
   * modes cannot silently leave the non-overwrite path pointing nowhere.
   */
  overwrite?: boolean;
  /**
   * When present, only these source paths are considered.
   *
   * `roots` says where to look; it cannot say "convert *these* of the files you
   * found". Without this, a UI that lets the user untick a row cannot honour it —
   * the row would be converted anyway, which for a lossless original in overwrite
   * mode means destroying the thing the tick was protecting.
   */
  includePaths?: string[];
  preset: ExportPreset;
  /** Filename pattern; one of FILENAME_PATTERNS. Defaults to '{artist} - {title}'. */
  filenamePattern?: string;
  /**
   * Keep the source's own file name when converting in place.
   *
   * The user chose this as the behaviour of overwrite mode after a real batch
   * renamed 123 of 199 files into `{artist} - {title}` and collided into `(2)`
   * duplicates. So `overwrite: true` alone means "convert this file, do not move it":
   * `preserveNames` defaults to `true` there, `filenamePattern` is not applied, and no
   * `(2)` suffix is ever invented. Passing `false` explicitly restores tag-based
   * re-organisation.
   *
   * It has no effect when `overwrite` is false: exporting into another folder keeps
   * naming its outputs from `filenamePattern`, unchanged.
   */
  preserveNames?: boolean;
  /**
   * Loudness target. `undefined` keeps the preset's target; `null` disables
   * normalization entirely (never a single-pass fallback).
   */
  loudness?: { integratedLufs: number; truePeakDb: number; lra: number } | null;
  /** Detect and drop duplicates. Defaults to false. */
  dedup?: boolean;
  /** Parallel render jobs. Defaults to CPU cores - 1. */
  concurrency?: number;
  /** Capacity budget in bytes; items beyond it are skipped, not failed. */
  targetCapacityBytes?: number | null;
  onProgress?: (ev: { stage: string; done: number; total: number; path?: string }) => void;
}

export interface BatchPlanItem {
  id: string;
  sourcePath: string;
  outputPath: string;
  tags: TagSet;
  /** Source duration in seconds, carried from the scan so no re-probe is needed. */
  durationSec: number;
  /** Why this item will not be rendered. Absent means "render it". */
  skipped?: string;
}

export interface DuplicateGroup {
  keep: string;
  drop: string[];
  reason: string;
}

export interface BatchPlan {
  items: BatchPlanItem[];
  duplicates: DuplicateGroup[];
}

export interface BatchReportItem {
  id: string;
  sourcePath: string;
  outputPath: string | null;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  verify?: VerifyResult;
}

export interface BatchReport {
  items: BatchReportItem[];
  duplicates: DuplicateGroup[];
  totalBytes: number;
  durationMs: number;
  preset: ExportPreset;
}

/* ------------------------------------------------------------------ */
/* Preset / loudness helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve the effective preset for this run.
 *
 * `loudness === null` disables normalization (used when the caller has already
 * normalised the material). `undefined` keeps whatever the preset asked for.
 */
export function effectivePreset(preset: ExportPreset, loudness: BatchOptions['loudness']): ExportPreset {
  if (loudness === undefined) return preset;
  if (loudness === null) {
    return { ...preset, loudness: { ...preset.loudness, enabled: false } };
  }
  return {
    ...preset,
    loudness: {
      enabled: true,
      integratedLufs: loudness.integratedLufs,
      truePeakDb: loudness.truePeakDb,
      lra: loudness.lra,
    },
  };
}

/**
 * The gentle cleanup chain the batch applies to every source.
 *
 * `afftdn` at the preset's strength (the USB preset says `gentle` = nr=6) followed
 * by `adeclick`. This is the *only* denoise the batch will ever apply: the
 * DeepFilterNet stage is opt-in per track from the UI, never a batch default.
 */
export function batchEffects(preset: ExportPreset): EffectInstance[] {
  if (preset.denoise === 'off') return [];
  return [
    { id: 'batch-denoise', enabled: true, type: 'denoise', strength: preset.denoise },
    { id: 'batch-declick', enabled: true, type: 'declick', threshold: 2 },
  ];
}

/** Container extension for a preset. */
export function containerExtension(preset: ExportPreset): string {
  switch (preset.container) {
    case 'mp3': return '.mp3';
    case 'wav': return '.wav';
    case 'flac': return '.flac';
    case 'ogg': return '.ogg';
    case 'm4a': return '.m4a';
    case 'aac': return '.aac';
    case 'opus': return '.opus';
    case 'wma': return '.wma';
    case 'aiff': return '.aiff';
    default: return '.bin';
  }
}

const LOSSLESS_CONTAINERS = new Set(['wav', 'aiff', 'flac']);

/* ------------------------------------------------------------------ */
/* In-place naming and the destination name probe                      */
/* ------------------------------------------------------------------ */

/**
 * The file name an in-place conversion writes through.
 *
 * "Keep the original name" means the user's own name, byte for byte: a source that
 * is already in the preset's container keeps it exactly, including its casing
 * (`SONG.MP3` stays `SONG.MP3`), and no `{artist} - {title}` rewrite or `(2)` suffix
 * is invented. Only when the container really changes does the extension follow the
 * format — `song.wav` becomes `song.mp3` — because MP3 bytes inside a file still
 * called `.wav` would be a lie about its contents.
 */
export function inPlaceName(sourcePath: string, presetExtension: string): string {
  const current = extname(sourcePath);
  if (current.toLowerCase() === presetExtension.toLowerCase()) return basename(sourcePath);
  return basename(sourcePath, current) + presetExtension;
}

/**
 * The one sentence a user can act on when a name on their device is unusable.
 *
 * The original error text is kept in the message: it is what a bug report needs, and
 * the advice is what the person in front of the machine needs. Neither is optional.
 */
export const DAMAGED_TARGET_ADVICE =
  '請用磁碟檢查工具修復這個資料夾，或先在電腦上轉換後再複製回來。';

/** Message for a destination name the device will not let us write to. */
export function damagedTargetMessage(target: string, cause: string): string {
  return `目標檔名在這台裝置上損毀，無法寫入：${basename(target)}。${DAMAGED_TARGET_ADVICE}（${cause}）`;
}

/** Two paths that name one and the same file on disk, whatever their casing. */
function isSameFile(a: string, b: string): boolean {
  try {
    // realpath resolves to the name that is actually on disk, so on a
    // case-insensitive volume `SONG.MP3` and `song.mp3` compare equal — which the
    // naive string comparison used to get wrong.
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Why an in-place rename must not be attempted, or `null` when it may proceed.
 *
 * The destination is probed *before* the rename, because afterwards the original is
 * already gone and there is nothing left to protect. On the user's USB stick a
 * damaged FAT32 directory entry occupies the target name: `statSync` then throws
 * `UNKNOWN: unknown error` instead of ENOENT, and the rename fails with an errno that
 * tells the user nothing. So anything that is not a clean ENOENT counts as an
 * unusable name — the code is deliberately not narrowed to one errno, because the one
 * this device reports is not the standard one and the message text is not a contract.
 */
export function inPlaceTargetProblem(target: string, sourcePath: string): string | null {
  try {
    const st = statSync(target);
    if (st.isDirectory()) {
      return damagedTargetMessage(target, '這個名字被一個同名的資料夾佔住');
    }
    if (isSameFile(target, sourcePath)) return null; // the file being replaced
    // A regular file that is not this item's own source is somebody else's track.
    // Renaming over it would destroy it, and deleting it afterwards would destroy
    // the very conversion we just wrote.
    return `目標檔名已被另一個檔案佔用：${basename(target)}。就地覆寫不會覆蓋一個不是它來源的檔案，因此這一項保持原檔不動。`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // nothing there: normal
    return damagedTargetMessage(target, `原始錯誤：${(err as Error).message}`);
  }
}

/** True when a regular file already sits at `path` (a directory does not count). */
function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Estimated output size in bytes.
 *
 * Lossy formats are computed from the bitrate; PCM from the sample format; FLAC from
 * an empirical ~55% of PCM (measured on this machine for typical music). This is an
 * estimate used only for capacity planning — the real size is measured after each
 * render and reported.
 */
export function estimateOutputBytes(preset: ExportPreset, durationSec: number): number {
  const d = Math.max(0, durationSec);
  if (preset.bitrateKbps !== null && !LOSSLESS_CONTAINERS.has(preset.container)) {
    return Math.round((preset.bitrateKbps * 1000 * d) / 8);
  }
  const pcm = preset.sampleRate * preset.channels * 2 * d;
  if (preset.container === 'flac') return Math.round(pcm * 0.55);
  return Math.round(pcm);
}

/* ------------------------------------------------------------------ */
/* Stage 1-3: scan, analyze, plan                                      */
/* ------------------------------------------------------------------ */

/** Read container tags, repair mojibake in each field. */
export function resolveTags(entry: LibraryEntry): TagSet {
  const raw = readTags(entry.info);
  const repaired: TagSet = {};
  const sink = repaired as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') sink[k] = repairMojibake(v);
  }
  return mergeTags(repaired, deriveTagsFromFilename(entry.path));
}

/** Map a TagSet onto ffmpeg `-metadata` keys. Empty fields are omitted. */
export function tagsToMetadata(tags: TagSet): Record<string, string> {
  const out: Record<string, string> = {};
  if (tags.title) out['title'] = tags.title;
  if (tags.artist) out['artist'] = tags.artist;
  if (tags.album) out['album'] = tags.album;
  if (tags.albumArtist) out['album_artist'] = tags.albumArtist;
  if (tags.track) out['track'] = tags.track;
  if (tags.year) out['date'] = tags.year;
  if (tags.genre) out['genre'] = tags.genre;
  if (tags.comment) out['comment'] = tags.comment;
  return out;
}

/**
 * Decide what to render, what to drop as duplicate, and what exceeds capacity.
 *
 * `entries` order is the caller's priority order: when a capacity budget is set, the
 * earliest entries that fit are kept and the remainder are marked `skipped`.
 */
export async function planBatch(entries: LibraryEntry[], opts: BatchOptions): Promise<BatchPlan> {
  const preset = effectivePreset(opts.preset, opts.loudness);
  const ext = containerExtension(preset);
  const pattern = opts.filenamePattern ?? '{artist} - {title}';
  // The user's decision, not a default we inherited: converting in place keeps the
  // original names unless the caller explicitly asks for tag-based re-organisation.
  const preserveNames = opts.overwrite === true && opts.preserveNames !== false;

  // Restrict to an explicit selection before anything else looks at the list.
  // Paths are resolved and lower-cased because Windows callers disagree about
  // case, and a selection that silently misses is worse than no selection at all.
  if (opts.includePaths) {
    const wanted = new Set(opts.includePaths.map((p) => resolve(p).toLowerCase()));
    entries = entries.filter((e) => wanted.has(resolve(e.path).toLowerCase()));
  }

  // Duplicates are resolved over *all* entries first, so a dropped duplicate never
  // consumes capacity or a render slot.
  let duplicates: DuplicateGroup[] = [];
  if (opts.dedup) {
    duplicates = findDuplicates(
      entries.map((e) => ({
        id: e.id,
        path: e.path,
        durationSec: e.info.format.durationSec,
        // Prefer the stream's bitrate; fall back to the container's, so the
        // keeper choice can favour the better-quality copy of the same song.
        bitRate: e.info.audio?.bitRate ?? e.info.format.bitRate,
        fp: e.fp ?? null,
      })),
    );
  }
  const dropped = new Set<string>();
  for (const g of duplicates) for (const d of g.drop) dropped.add(d);

  const tagged = entries.map((e) => ({ id: e.id, tags: resolveTags(e) }));
  const names = planFilenames(tagged, pattern);
  const tagsById = new Map(tagged.map((t) => [t.id, t.tags]));

  const items: BatchPlanItem[] = [];
  let used = 0;
  const budget = opts.targetCapacityBytes ?? null;
  /** In-place targets already spoken for, keyed case-insensitively. */
  const claimedTargets = new Map<string, string>();

  for (const e of entries) {
    const tags = tagsById.get(e.id) ?? {};
    const base = names.get(e.id) ?? e.id;
    const durationSec = e.info.format.durationSec;
    const item: BatchPlanItem = {
      id: e.id,
      sourcePath: e.path,
      // Overwriting puts the target where the source was: with the name preserved
      // that is the file itself, and a format change lands as the preset's extension
      // beside it rather than in a separate folder.
      outputPath: opts.overwrite
        ? preserveNames
          ? join(dirname(e.path), inPlaceName(e.path, ext))
          : join(dirname(e.path), base + ext)
        : join(opts.outputDir, base + ext),
      tags,
      durationSec,
    };

    if (dropped.has(e.id)) {
      item.skipped = 'duplicate';
      items.push(item);
      continue;
    }

    if (budget !== null) {
      const need = estimateOutputBytes(preset, durationSec);
      if (used + need > budget) {
        const left = Math.max(0, budget - used);
        item.skipped = `exceeds capacity (needs ~${need} B, only ${left} B left)`;
        items.push(item);
        continue;
      }
      used += need;
    }

    // One target, one track. Preserved names make a collision reachable — `song.flac`
    // and `song.mp3` in the same folder both want `song.mp3` — and the loser's rename
    // would destroy the winner's conversion and then delete its own source. That is
    // silent data loss, so it is refused here instead: a skipped row is visible in
    // the report, a clobbered track is not.
    if (opts.overwrite) {
      const ownFile = item.outputPath === item.sourcePath;
      if (!ownFile && isExistingFile(item.outputPath)) {
        item.skipped = `target name is taken by an existing file (${basename(item.outputPath)})`;
        items.push(item);
        continue;
      }
      const key = resolve(item.outputPath).toLowerCase();
      if (claimedTargets.has(key)) {
        item.skipped = `target name is already claimed by another track in this batch (${basename(item.outputPath)})`;
        items.push(item);
        continue;
      }
      claimedTargets.set(key, item.id);
    }

    items.push(item);
  }

  return { items, duplicates };
}

/* ------------------------------------------------------------------ */
/* Stage 4-5: render and verify                                         */
/* ------------------------------------------------------------------ */

export interface RenderJobOutcome {
  item: BatchReportItem;
  bytes: number;
}

/**
 * Render and verify one plan item.
 *
 * Never throws: any failure (bad source, ffmpeg error, sandbox denial) becomes a
 * `failed` row so the rest of the batch continues.
 */
async function runOne(
  item: BatchPlanItem,
  opts: BatchOptions,
  preset: ExportPreset,
  bins: BinPaths,
): Promise<RenderJobOutcome> {
  if (item.skipped) {
    return {
      item: {
        id: item.id,
        sourcePath: item.sourcePath,
        outputPath: null,
        status: 'skipped',
        message: item.skipped,
      },
      bytes: 0,
    };
  }

  // Each job gets its own scratch directory: concurrent ffmpeg `-report` logs must
  // never be confused, and one failure cannot poison a sibling's scratch space.
  const jobScratch = join(
    opts.scratch,
    `job-${item.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  ensureDir(jobScratch);

  const durationSec = item.durationSec;
  if (!(durationSec > 0)) {
    return {
      item: {
        id: item.id,
        sourcePath: item.sourcePath,
        outputPath: null,
        status: 'failed',
        message: 'source duration is unknown or zero',
      },
      bytes: 0,
    };
  }

  // In overwrite mode the target IS the source, so the render must never write
  // there directly: a half-written file would destroy the original. Stage beside
  // it instead — same directory, therefore same volume, which is what makes the
  // final move an atomic replace rather than a copy that can be interrupted.
  const finalPath = item.outputPath;
  const stagingPath = opts.overwrite
    ? join(
        dirname(finalPath),
        `${basename(finalPath, extname(finalPath))}.aus-tmp-${Math.random().toString(36).slice(2, 8)}${extname(finalPath)}`,
      )
    : finalPath;

  /** Drop the staged file. Never touches the original, which is the whole point. */
  const discardStaged = (): void => {
    if (!opts.overwrite) return;
    try {
      rmSync(stagingPath, { force: true });
    } catch {
      // A leftover staging file beats a lost original.
    }
  };

  try {
    const timeline = makeTimeline(
      [
        makeClip({
          sourceId: 'src',
          srcIn: 0,
          srcOut: durationSec,
          effects: batchEffects(preset),
        }),
      ],
      preset.sampleRate,
      preset.channels,
    );

    const result = await render({
      bins,
      scratchRoot: jobScratch,
      timeline,
      preset,
      sourcePaths: { src: item.sourcePath },
      outputPath: stagingPath,
      tags: tagsToMetadata(item.tags),
    });

    if (!result.ok) {
      discardStaged();
      return {
        item: {
          id: item.id,
          sourcePath: item.sourcePath,
          outputPath: null,
          status: 'failed',
          message: result.error ?? 'render failed',
        },
        bytes: 0,
      };
    }

    opts.onProgress?.({ stage: 'verify', done: 0, total: 1, path: item.sourcePath });

    const verified = await verify({
      bins,
      scratchRoot: jobScratch,
      file: stagingPath,
      preset,
      expectedDurationSec: durationSec,
      expectLoudness: preset.loudness.enabled,
    });

    if (opts.overwrite) {
      if (verified.problems.length > 0) {
        // A replacement that did not pass verification is not allowed to retire a
        // working original. The user keeps the file they already had.
        discardStaged();
        return {
          item: {
            id: item.id,
            sourcePath: item.sourcePath,
            outputPath: null,
            status: 'failed',
            message: `refusing to replace the original: ${verified.problems.join('; ')}`,
          },
          bytes: 0,
        };
      }

      // Verified good. Only now does the original stop existing: the move is atomic
      // within one volume, and a renamed-away source is removed after it, never before.
      //
      // The destination is probed first. A damaged name on the device makes the rename
      // fail with an errno that says nothing to the user, and this is the last moment
      // at which the original is still untouched and we can explain what to do.
      const problem = inPlaceTargetProblem(finalPath, item.sourcePath);
      if (problem !== null) {
        discardStaged();
        return {
          item: {
            id: item.id,
            sourcePath: item.sourcePath,
            outputPath: null,
            status: 'failed',
            message: problem,
          },
          bytes: 0,
        };
      }

      try {
        renameSync(stagingPath, finalPath);
      } catch (err) {
        // Any rename failure is reported as a name the device would not accept, with
        // the original error text appended: the raw errno alone is not actionable.
        discardStaged();
        return {
          item: {
            id: item.id,
            sourcePath: item.sourcePath,
            outputPath: null,
            status: 'failed',
            message: damagedTargetMessage(finalPath, `原始錯誤：${(err as Error).message}`),
          },
          bytes: 0,
        };
      }
      // Only remove the source when it is genuinely a *different* file. On a
      // case-insensitive volume `TRACK.MP3` and `Track.mp3` are one entry, and the
      // string comparison used to delete the conversion that had just been written.
      if (!isSameFile(item.sourcePath, finalPath)) rmSync(item.sourcePath, { force: true });
    }

    let bytes = result.sizeBytes;
    try {
      bytes = statSync(finalPath).size;
    } catch {
      /* keep the render-reported size */
    }

    return {
      item: {
        id: item.id,
        sourcePath: item.sourcePath,
        outputPath: finalPath,
        status: 'ok',
        ...(verified.problems.length > 0 ? { message: verified.problems.join('; ') } : {}),
        verify: verified,
      },
      bytes,
    };
  } catch (err) {
    discardStaged();
    return {
      item: {
        id: item.id,
        sourcePath: item.sourcePath,
        outputPath: null,
        status: 'failed',
        message: (err as Error).message,
      },
      bytes: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

/*
 * `mapPool` and `defaultConcurrency` live in pool.ts: batch.ts imports
 * library.ts, so defining the pool here would make library.ts -> pool.ts a
 * cycle. Re-exported so existing callers (and the tests) keep working.
 */
export { defaultConcurrency, mapPool };

/* ------------------------------------------------------------------ */
/* Stage 6: the report                                                  */
/* ------------------------------------------------------------------ */

/** Serialize a report as pretty JSON. */
export function manifestJson(report: BatchReport): string {
  return JSON.stringify(report, null, 2);
}

/** Write a report to `path` as manifest.json. Creates the parent directory. */
export function writeManifest(report: BatchReport, path: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, manifestJson(report), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the whole pipeline.
 *
 * Roots are scanned, duplicates optionally removed, every survivor rendered with
 * two-pass loudness normalization and verified, and a structured report returned. A
 * failure in any single item is captured in the report — the batch always completes
 * and always returns a report.
 */
export async function runBatch(opts: BatchOptions): Promise<BatchReport> {
  const started = Date.now();
  const preset = effectivePreset(opts.preset, opts.loudness);
  const bins: BinPaths = { ffmpeg: opts.ffmpeg, ffprobe: opts.ffprobe, source: 'batch' };
  const progress = opts.onProgress;
  const concurrency = Math.max(1, opts.concurrency ?? defaultConcurrency());

  ensureDir(opts.scratch);
  ensureDir(opts.outputDir);

  // 1. scan
  progress?.({ stage: 'scan', done: 0, total: 0 });
  const scan: ScanResult = await scanLibrary({
    roots: opts.roots,
    ffprobe: opts.ffprobe,
    scratch: opts.scratch,
    onProgress: (done, total, path) => progress?.({ stage: 'scan', done, total, path }),
  });

  // 2. analyze — fingerprints, only when duplicate detection is on.
  if (opts.dedup && scan.entries.length > 0) {
    const total = scan.entries.length;
    let done = 0;
    await mapPool(scan.entries, concurrency, async (e) => {
      e.fp = await fingerprint(opts.ffmpeg, e.path, opts.scratch);
      done += 1;
      progress?.({ stage: 'analyze', done, total, path: e.path });
    });
  }

  // 3. plan
  progress?.({ stage: 'plan', done: 0, total: scan.entries.length });
  const plan = await planBatch(scan.entries, { ...opts, dedup: opts.dedup, concurrency });

  // 4. render (+ 5. verify, inside runOne)
  const total = plan.items.length;
  let done = 0;
  const outcomes = await mapPool(plan.items, concurrency, async (item) => {
    const outcome = await runOne(item, opts, preset, bins);
    done += 1;
    progress?.({ stage: 'render', done, total, path: item.sourcePath });
    return outcome;
  });

  // 6. report
  progress?.({ stage: 'report', done: total, total });
  const items = outcomes.map((o) => o.item);
  const totalBytes = outcomes.reduce((s, o) => s + o.bytes, 0);

  // Surface scan errors as failed rows so they are visible in the report rather than
  // silently lost.
  for (const err of scan.errors) {
    items.push({
      id: entryId(err.path),
      sourcePath: err.path,
      outputPath: null,
      status: 'failed',
      message: `scan: ${err.message}`,
    });
  }

  return {
    items,
    duplicates: plan.duplicates,
    totalBytes,
    durationMs: Date.now() - started,
    preset,
  };
}
