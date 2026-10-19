/**
 * The download queue (plan Task 6).
 *
 * One record per `start()` call: its tracks download at most two at a time,
 * tags are written per track, and conversion is a SINGLE flush — one `runBatch`
 * over every raw that reached the tagging stage. That last part is deliberate:
 * the batch pipeline already does loudness normalization, verification and
 * capacity handling far better than a per-track call would, and a single flush
 * is the v0.3 contract (chunked mid-run flushes are out of scope).
 *
 * Failure reasons are stable machine strings the API and the UI key on:
 * `cookie-expired`, `no-confident-match`, `timeout`, `cancelled`, `rate-limit`,
 * `io-error`. A provider may signal one by throwing `DownloadFailure`, or by
 * throwing anything with a string `reason` property.
 *
 * `cookie-expired` is the one reason that stops the world: every still-queued
 * track is failed immediately with the same reason, because a dead session
 * cookie cannot fix itself and retrying three hundred tracks against it is just
 * three hundred failed requests. The in-flight track is allowed to settle.
 *
 * Every external effect is injectable (`sleep`, `now`, `tag`, `convert`) so the
 * unit tests run deterministic and offline; the defaults are the real engine.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { runBatch } from '../batch.ts';
import { probe } from '../probe.ts';
import { CONTAINER_SUPPORT, fetchCover, writeTags } from './tagger.ts';
import { sanitizeFilename } from './resolve.ts';
import { DownloadFailure } from './errors.ts';
import type { ExportPreset } from '../types.ts';
import type {
  DownloadOpts,
  DownloadProvider,
  DownloadRoute,
  ResolvedSource,
  TrackMeta,
  TrackState,
} from './types.ts';

/** Two at a time: enough to hide network latency, gentle enough for Spotify. */
const CONCURRENCY = 2;
/** An existing raw at or below this is a broken half-download, not a keep. */
const SKIP_ABOVE_BYTES = 1024;
const DEFAULT_JITTER_MS: [number, number] = [500, 1500];
/** A single track's download budget; a song is seconds, not an archive. */
const DEFAULT_TRACK_TIMEOUT_MS = 5 * 60_000;
/** Global cooldown after a provider says 429. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;

const TERMINAL_STATES: ReadonlySet<TrackState> = new Set<TrackState>([
  'done',
  'failed',
  'skipped',
  'cancelled',
]);

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface TrackEntry {
  index: number;
  meta: TrackMeta;
  state: TrackState;
  reason?: string;
  rawPath?: string;
  outputPath?: string;
  /** Bitrate of the file actually delivered, read from the source scan. */
  rawKbps?: number;
}

export interface DownloadRecord {
  id: string;
  route: DownloadRoute;
  destination: string;
  sourceName: string;
  preset: ExportPreset;
  createdAt: string;
  tracks: TrackEntry[];
  finished: boolean;
}

/** Everything the flush needs to render the raws into the destination. */
export interface FlushContext {
  destination: string;
  preset: ExportPreset;
}

/** One raw file's outcome, keyed back to the queue by `sourcePath`. */
export interface FlushReportItem {
  sourcePath: string;
  outputPath: string | null;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  rawKbps?: number;
}

export interface TagContext {
  ffmpeg: string;
  scratch: string;
}

export type TagFn = (rawPath: string, meta: TrackMeta, ctx: TagContext) => Promise<unknown>;
export type ConvertFn = (rawPaths: string[], ctx: FlushContext) => Promise<FlushReportItem[]>;

export interface QueueDeps {
  providers: Record<DownloadRoute, DownloadProvider>;
  ffmpeg: string;
  ffprobe: string;
  scratch: string;
  /** Courtesy delay between a record's track starts; default [500, 1500] ms. */
  jitterMs?: [number, number];
  /** Per-track download budget; default 5 minutes. */
  trackTimeoutMs?: number;
  /** Global cooldown after a `rate-limit` rejection; default 30 s. */
  rateLimitPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  tag?: TagFn;
  convert?: ConvertFn;
}

export interface DownloadQueue {
  start(
    source: ResolvedSource,
    route: DownloadRoute,
    destination: string,
    preset: ExportPreset,
    trackIndices?: number[],
  ): string;
  get(id: string): DownloadRecord | null;
  list(): DownloadRecord[];
  cancel(id: string, trackIndices?: number[]): boolean;
  retry(id: string, trackIndices: number[]): boolean;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

interface ResolvedConfig {
  jitterMs: [number, number];
  trackTimeoutMs: number;
  rateLimitPauseMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  tag: TagFn;
  convert: ConvertFn;
}

interface RecordState {
  record: DownloadRecord;
  provider: DownloadProvider;
  cfg: ResolvedConfig;
  pending: number[];
  active: number;
  inflight: Map<number, AbortController>;
  /** Indices already through a flush — their raws are gone, never re-flush. */
  converted: Set<number>;
  /** Indices cancelled individually (a whole-record cancel uses `cancelled`). */
  cancelIndices: Set<number>;
  failFastReason: string | null;
  cancelled: boolean;
  /** How many tracks have begun the jitter+download path (0 = no jitter yet). */
  starts: number;
  flushing: boolean;
}

/** A provider failure's machine reason, or `io-error` for anything untagged. */
function reasonOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const reason = (err as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return 'io-error';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Settle with the provider, but never wait forever.
 *
 * A hanging provider is exactly what the per-track timeout exists for, and a
 * `Promise.race` against the abort signal is how it stops mattering. The
 * `isTimeout` probe distinguishes the kill timer from a user cancel, because
 * those two are different reasons to the user.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, isTimeout: () => boolean): Promise<T> {
  const kill = (): DownloadFailure =>
    new DownloadFailure(isTimeout() ? 'timeout' : 'cancelled', isTimeout() ? '下載逾時' : '已取消');
  if (signal.aborted) return Promise.reject(kill());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(kill());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Tag one raw file: cover art first where the container allows it, then the
 * metadata. A cover that cannot be fetched is not a failure — `fetchCover`
 * already answers `null` for every network trouble, and a song without its
 * artwork is still the song.
 */
async function defaultTag(rawPath: string, meta: TrackMeta, ctx: TagContext): Promise<unknown> {
  const ext = extname(rawPath).toLowerCase();
  let coverPath: string | null = null;
  if (meta.coverUrl !== '' && CONTAINER_SUPPORT[ext]?.cover === true) {
    coverPath = await fetchCover(meta.coverUrl, ctx.scratch, 10_000);
  }
  return writeTags(rawPath, meta, { ffmpeg: ctx.ffmpeg, coverPath });
}

/**
 * The real flush: probe each raw for the bitrate actually delivered, render
 * them through one batch, and report per-raw outcomes back to the queue.
 *
 * The probe is best-effort on purpose — `rawKbps` is a report for the user
 * ("來源 320 kbps"), never a promise the spec makes, so a probe that fails must
 * not fail the conversion.
 */
export async function singleFlushConvert(
  rawPaths: string[],
  ctx: FlushContext,
  engine: { ffmpeg: string; ffprobe: string; scratch: string },
): Promise<FlushReportItem[]> {
  const kbps = new Map<string, number>();
  await Promise.all(
    rawPaths.map(async (p) => {
      try {
        const info = await probe(engine.ffprobe, p, engine.scratch);
        const rate = info.format.bitRate ?? info.audio?.bitRate ?? null;
        if (rate !== null && rate > 0) kbps.set(p, Math.round(rate / 1000));
      } catch {
        /* report-only: a failed probe is not a failed track */
      }
    }),
  );

  const roots = [...new Set(rawPaths.map((p) => dirname(p)))];
  const report = await runBatch({
    ffmpeg: engine.ffmpeg,
    ffprobe: engine.ffprobe,
    scratch: engine.scratch,
    roots,
    includePaths: rawPaths,
    outputDir: ctx.destination,
    preset: ctx.preset,
  });

  const bySource = new Map(report.items.map((item) => [item.sourcePath, item]));
  return rawPaths.map((sourcePath): FlushReportItem => {
    const item = bySource.get(sourcePath);
    const rawKbps = kbps.get(sourcePath);
    if (!item) {
      return {
        sourcePath,
        outputPath: null,
        status: 'failed',
        message: '轉換報告中沒有這個檔案',
        ...(rawKbps === undefined ? {} : { rawKbps }),
      };
    }
    return {
      sourcePath,
      outputPath: item.outputPath,
      status: item.status,
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(rawKbps === undefined ? {} : { rawKbps }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

export function createDownloadQueue(deps: QueueDeps): DownloadQueue {
  const cfg: ResolvedConfig = {
    jitterMs: deps.jitterMs ?? DEFAULT_JITTER_MS,
    trackTimeoutMs: deps.trackTimeoutMs ?? DEFAULT_TRACK_TIMEOUT_MS,
    rateLimitPauseMs: deps.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => { setTimeout(r, ms); })),
    now: deps.now ?? Date.now,
    tag: deps.tag ?? defaultTag,
    convert:
      deps.convert ??
      ((rawPaths, ctx) =>
        singleFlushConvert(rawPaths, ctx, {
          ffmpeg: deps.ffmpeg,
          ffprobe: deps.ffprobe,
          scratch: deps.scratch,
        })),
  };

  const records = new Map<string, RecordState>();
  let seq = 0;

  const jitter = (st: RecordState): number => {
    const [lo, hi] = st.cfg.jitterMs;
    const span = Math.max(0, hi - lo);
    return lo + Math.floor(Math.random() * (span + 1));
  };

  const isCancelled = (st: RecordState, index: number): boolean =>
    st.cancelled || st.cancelIndices.has(index);

  /** Fail every still-waiting track at once (fail-fast, or a cancel). */
  function drainPending(st: RecordState, state: TrackState, reason: string): void {
    while (st.pending.length > 0) {
      const index = st.pending.shift()!;
      const entry = st.record.tracks[index];
      if (entry && !TERMINAL_STATES.has(entry.state)) {
        entry.state = state;
        entry.reason = reason;
      }
    }
  }

  /** Raws that reached tagging and have not been through a flush yet. */
  function eligibleForFlush(st: RecordState): TrackEntry[] {
    return st.record.tracks.filter(
      (t) =>
        t.rawPath !== undefined &&
        !st.converted.has(t.index) &&
        t.state !== 'failed' &&
        t.state !== 'cancelled',
    );
  }

  function updateFinished(st: RecordState): void {
    if (st.flushing) return;
    const busy = st.record.tracks.some((t) => !TERMINAL_STATES.has(t.state));
    st.record.finished = !busy && st.pending.length === 0 && st.active === 0;
  }

  async function flush(st: RecordState): Promise<void> {
    const eligible = eligibleForFlush(st);
    if (eligible.length === 0) return;
    const wasSkipped = new Set(eligible.filter((t) => t.state === 'skipped').map((t) => t.index));
    for (const t of eligible) t.state = 'converting';

    let report: FlushReportItem[];
    try {
      report = await st.cfg.convert(
        eligible.map((t) => t.rawPath!),
        { destination: st.record.destination, preset: st.record.preset },
      );
    } catch {
      for (const t of eligible) {
        st.converted.add(t.index);
        t.state = 'failed';
        t.reason = 'io-error';
      }
      return;
    }

    const bySource = new Map(report.map((item) => [item.sourcePath, item]));
    for (const t of eligible) {
      st.converted.add(t.index);
      const item = bySource.get(t.rawPath!);
      if (item?.rawKbps !== undefined) t.rawKbps = item.rawKbps;
      if (item?.outputPath) t.outputPath = item.outputPath;
      if (!item || item.status === 'failed') {
        t.state = 'failed';
        t.reason = t.reason ?? 'io-error';
      } else if (wasSkipped.has(t.index)) {
        // A pre-existing raw was converted but NOT downloaded by this run —
        // "skipped" is the honest state, the output path is still reported.
        t.state = 'skipped';
      } else {
        t.state = 'done';
      }
    }
  }

  function settle(st: RecordState): void {
    if (st.flushing) return;
    const eligible = eligibleForFlush(st);
    if (st.active === 0 && st.pending.length === 0 && eligible.length > 0) {
      st.flushing = true;
      void flush(st).finally(() => {
        st.flushing = false;
        updateFinished(st);
      });
      return;
    }
    updateFinished(st);
  }

  async function runTrack(st: RecordState, index: number): Promise<void> {
    const entry = st.record.tracks[index];
    if (!entry) return;
    const meta = entry.meta;

    if (isCancelled(st, index)) {
      entry.state = 'cancelled';
      entry.reason = 'cancelled';
      return;
    }

    // Skip-if-exists: a raw already sitting at the destination with real bytes
    // is a finished download from an earlier run. Half-written files (<= 1 KiB)
    // are not, and get fetched again. A provider may land in more than one
    // container (a YouTube download is webm or m4a), so every extension it can
    // produce is a candidate and the first one holding real bytes wins.
    const base = sanitizeFilename(`${meta.artists} - ${meta.title}`);
    let expected: string | null = null;
    for (const ext of st.provider.rawExtensions) {
      const candidate = join(st.record.destination, `${base}${ext}`);
      if (existsSync(candidate) && sizeOf(candidate) > SKIP_ABOVE_BYTES) {
        expected = candidate;
        break;
      }
    }
    if (expected !== null) {
      entry.rawPath = expected;
      entry.state = 'skipped';
      return;
    }

    if (st.starts > 0) await st.cfg.sleep(jitter(st));
    st.starts += 1;
    if (isCancelled(st, index)) {
      entry.state = 'cancelled';
      entry.reason = 'cancelled';
      return;
    }

    entry.state = 'downloading';
    const controller = new AbortController();
    st.inflight.set(index, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, st.cfg.trackTimeoutMs);

    const opts: DownloadOpts = {
      destination: st.record.destination,
      signal: controller.signal,
      timeoutMs: st.cfg.trackTimeoutMs,
      onStage: (s) => {
        entry.state = s;
      },
    };

    try {
      let rawPath: string | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await raceAbort(
            st.provider.download(meta, st.record.destination, opts),
            controller.signal,
            () => timedOut,
          );
          rawPath = result.rawPath;
          break;
        } catch (err) {
          const reason = reasonOf(err);
          // One global cooldown, one retry — a 429 is a pause, not a verdict.
          if (reason === 'rate-limit' && attempt === 0 && !timedOut && !isCancelled(st, index)) {
            await st.cfg.sleep(st.cfg.rateLimitPauseMs);
            continue;
          }
          throw new DownloadFailure(reason, messageOf(err));
        }
      }
      entry.rawPath = rawPath;
      entry.state = 'tagging';
      await st.cfg.tag(rawPath, meta, { ffmpeg: deps.ffmpeg, scratch: deps.scratch });
    } catch (err) {
      const reason = reasonOf(err);
      if (reason === 'cookie-expired') {
        entry.state = 'failed';
        entry.reason = 'cookie-expired';
        // A dead cookie cannot heal itself: stop feeding the queue.
        st.failFastReason = 'cookie-expired';
        drainPending(st, 'failed', 'cookie-expired');
      } else if (isCancelled(st, index) && reason !== 'timeout') {
        entry.state = 'cancelled';
        entry.reason = 'cancelled';
      } else {
        entry.state = 'failed';
        entry.reason = reason;
      }
    } finally {
      clearTimeout(timer);
      st.inflight.delete(index);
    }
  }

  function pump(st: RecordState): void {
    if (st.cancelled) {
      drainPending(st, 'cancelled', 'cancelled');
      settle(st);
      return;
    }
    if (st.failFastReason !== null) {
      drainPending(st, 'failed', st.failFastReason);
      settle(st);
      return;
    }
    while (st.active < CONCURRENCY && st.pending.length > 0) {
      const index = st.pending.shift()!;
      st.active += 1;
      void runTrack(st, index).finally(() => {
        st.active -= 1;
        pump(st);
      });
    }
    settle(st);
  }

  return {
    start(source, route, destination, preset, trackIndices) {
      const provider = deps.providers[route];
      if (!provider) throw new Error(`unknown download route: ${route}`);
      const wanted = trackIndices === undefined ? null : new Set(trackIndices);
      const tracks: TrackEntry[] = source.tracks.map((meta, index) => {
        const selected = wanted === null || wanted.has(index);
        return selected
          ? { index, meta, state: 'queued' as TrackState }
          : { index, meta, state: 'cancelled' as TrackState, reason: 'cancelled' };
      });
      const now = cfg.now();
      const id = `dl-${(seq += 1).toString(36)}-${now.toString(36)}`;
      const record: DownloadRecord = {
        id,
        route,
        destination,
        sourceName: source.name,
        preset,
        createdAt: new Date(now).toISOString(),
        tracks,
        finished: false,
      };
      const st: RecordState = {
        record,
        provider,
        cfg,
        pending: tracks.filter((t) => t.state === 'queued').map((t) => t.index),
        active: 0,
        inflight: new Map(),
        converted: new Set(),
        cancelIndices: new Set(),
        failFastReason: null,
        cancelled: false,
        starts: 0,
        flushing: false,
      };
      records.set(id, st);
      pump(st);
      return id;
    },

    get(id) {
      return records.get(id)?.record ?? null;
    },

    list() {
      return [...records.values()].map((st) => st.record);
    },

    cancel(id, trackIndices) {
      const st = records.get(id);
      if (!st) return false;
      if (trackIndices === undefined) {
        st.cancelled = true;
        drainPending(st, 'cancelled', 'cancelled');
        for (const controller of st.inflight.values()) controller.abort();
        pump(st);
        return true;
      }
      const wanted = new Set(trackIndices);
      st.pending = st.pending.filter((index) => {
        if (!wanted.has(index)) return true;
        const entry = st.record.tracks[index];
        if (entry && !TERMINAL_STATES.has(entry.state)) {
          entry.state = 'cancelled';
          entry.reason = 'cancelled';
        }
        return false;
      });
      for (const index of wanted) {
        const controller = st.inflight.get(index);
        if (controller) {
          st.cancelIndices.add(index);
          controller.abort();
        }
      }
      settle(st);
      return true;
    },

    retry(id, trackIndices) {
      const st = records.get(id);
      if (!st) return false;
      for (const index of trackIndices) {
        const entry = st.record.tracks[index];
        if (!entry) continue;
        entry.state = 'queued';
        entry.reason = undefined;
        entry.rawPath = undefined;
        entry.outputPath = undefined;
        entry.rawKbps = undefined;
        st.converted.delete(index);
        st.cancelIndices.delete(index);
        if (!st.pending.includes(index)) st.pending.push(index);
      }
      // The user is retrying because something changed — a refilled cookie, a
      // new network — so the old fail-fast verdict no longer applies.
      st.cancelled = false;
      st.failFastReason = null;
      st.record.finished = false;
      pump(st);
      return true;
    },
  };
}
