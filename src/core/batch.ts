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

import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { statSync, writeFileSync } from 'node:fs';
import type { BinPaths } from './ffbin.ts';
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
  preset: ExportPreset;
  /** Filename pattern; one of FILENAME_PATTERNS. Defaults to '{artist} - {title}'. */
  filenamePattern?: string;
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

  for (const e of entries) {
    const tags = tagsById.get(e.id) ?? {};
    const base = names.get(e.id) ?? e.id;
    const durationSec = e.info.format.durationSec;
    const item: BatchPlanItem = {
      id: e.id,
      sourcePath: e.path,
      outputPath: join(opts.outputDir, base + ext),
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
      outputPath: item.outputPath,
      tags: tagsToMetadata(item.tags),
    });

    if (!result.ok) {
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
      file: item.outputPath,
      preset,
      expectedDurationSec: durationSec,
      expectLoudness: preset.loudness.enabled,
    });

    let bytes = result.sizeBytes;
    try {
      bytes = statSync(item.outputPath).size;
    } catch {
      /* keep the render-reported size */
    }

    return {
      item: {
        id: item.id,
        sourcePath: item.sourcePath,
        outputPath: item.outputPath,
        status: 'ok',
        ...(verified.problems.length > 0 ? { message: verified.problems.join('; ') } : {}),
        verify: verified,
      },
      bytes,
    };
  } catch (err) {
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

/** Run `fn` over every item with at most `limit` in flight. Order preserved. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Math.max(1, Math.floor(limit)), items.length));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Default parallelism: leave one core for the UI and the OS. */
export function defaultConcurrency(): number {
  return Math.max(1, cpus().length - 1);
}

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
