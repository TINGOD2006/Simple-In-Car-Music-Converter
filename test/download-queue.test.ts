/**
 * queue.ts — the download queue (plan Task 6).
 *
 * Unit tests run on scripted providers with injected sleep/now and STUB
 * tagging/conversion so they stay deterministic; test (i) is the real-engine
 * integration: real provider fixtures (lavfi sine .ogg), real tagger, one real
 * runBatch flush.
 *
 * The queue contract pinned here:
 *   - at most 2 tracks download at once
 *   - jitter (default [500,1500] ms) between a record's track starts
 *   - a hanging provider is killed by the per-track timeout, the queue moves on
 *   - cancel aborts in-flight downloads and the provider's partial file is gone
 *   - skip-if-exists: an existing raw >1 KiB is `skipped`, smaller re-downloads
 *   - retry re-queues only the requested failed indices
 *   - a cookie-expired failure fails every still-queued track fast
 *   - a no-confident-match failure never stops the other tracks
 *   - rate-limit pauses globally and retries the track once
 *   - conversion is ONE flush (one runBatch) after the last tag settles
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { probe } from '../src/core/probe.ts';
import { readTags } from '../src/core/tags.ts';
import { createDownloadQueue, singleFlushConvert } from '../src/core/download/queue.ts';
import type { DownloadQueue, FlushReportItem, QueueDeps } from '../src/core/download/queue.ts';
import type {
  DownloadOpts,
  DownloadProvider,
  ResolvedSource,
  TrackMeta,
} from '../src/core/download/types.ts';
import { DownloadFailure } from '../src/core/download/errors.ts';
import { sanitizeFilename } from '../src/core/download/resolve.ts';
import type { ExportPreset } from '../src/core/types.ts';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PRESET: ExportPreset = {
  container: 'mp3',
  codec: 'libmp3lame',
  bitrateKbps: 320,
  sampleRate: 44100,
  channels: 2,
  loudness: { enabled: false, integratedLufs: -14, truePeakDb: -1, lra: 11 },
  id3v2Version: 3,
  denoise: 'off',
};

function metaOf(n: number, title?: string, artists?: string): TrackMeta {
  return {
    title: title ?? `Song ${n}`,
    artists: artists ?? `Artist ${n}`,
    album: 'Album',
    durationSec: 60,
    coverUrl: '',
    sourceId: `id${n}`,
  };
}

function sourceOf(tracks: TrackMeta[], name = 'Test Album'): ResolvedSource {
  return { kind: 'track', name, platform: 'spotify', tracks };
}

interface MockState { calls: string[] }

type MockBehavior = (
  track: TrackMeta,
  destBase: string,
  opts: DownloadOpts,
  nthCall: number,
) => Promise<{ rawPath: string }>;

function instantProvider(state: MockState, behavior: MockBehavior): DownloadProvider {
  return {
    id: 'spotify-direct',
    rawExtensions: ['.ogg'],
    async resolve() {
      throw new Error('resolve unused in queue tests');
    },
    async download(track, destBase, opts) {
      state.calls.push(track.sourceId);
      return behavior(track, destBase, opts, state.calls.length);
    },
  };
}

/** A provider download that materialises the raw file at its sanitised name. */
function writeRawBehavior(state: MockState): MockBehavior {
  return async (track, destBase) => {
    mkdirSync(destBase, { recursive: true });
    const rawPath = join(destBase, `${sanitizeFilename(`${track.artists} - ${track.title}`)}.ogg`);
    writeFileSync(rawPath, `raw ${track.sourceId}`);
    return { rawPath };
  };
}

/**
 * A provider whose raw can land in either container (as the YouTube routes
 * genuinely can: yt-dlp yields webm or m4a depending on the video).
 */
function multiExtProvider(state: MockState): DownloadProvider {
  return {
    id: 'youtube-match',
    rawExtensions: ['.webm', '.m4a'],
    async resolve() {
      throw new Error('resolve unused in queue tests');
    },
    async download(track, destBase) {
      state.calls.push(track.sourceId);
      mkdirSync(destBase, { recursive: true });
      const rawPath = join(destBase, `${sanitizeFilename(`${track.artists} - ${track.title}`)}.webm`);
      writeFileSync(rawPath, `raw ${track.sourceId}`);
      return { rawPath };
    },
  };
}

/** Queue deps whose tag/convert steps are stubs — no ffmpeg in unit tests. */
function stubDeps(provider: DownloadProvider, overrides: Partial<QueueDeps> = {}): QueueDeps {
  return {
    providers: { 'spotify-direct': provider, 'youtube-match': provider, 'youtube-direct': provider },
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    scratch: '.',
    sleep: () => Promise.resolve(),
    tag: () => Promise.resolve({}),
    convert: (rawPaths) =>
      Promise.resolve(
        rawPaths.map((p): FlushReportItem => ({
          sourcePath: p,
          outputPath: p.slice(0, -4) + '.mp3',
          status: 'ok',
        })),
      ),
    ...overrides,
  };
}

const ROOT = join(tmpdir(), 'aus-queue');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function untilFinished(queue: DownloadQueue, id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = queue.get(id);
    if (!rec) throw new Error(`record ${id} disappeared`);
    if (rec.finished) return rec;
    if (Date.now() > deadline) {
      throw new Error(`record did not finish; states: ${rec.tracks.map((t) => `${t.index}:${t.state}`).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

/* ------------------------------------------------------------------ */

test('queue never exceeds two concurrent downloads', async () => {
  const state: MockState = { calls: [] };
  let inFlight = 0;
  let peak = 0;
  const provider = instantProvider(state, async (track) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight -= 1;
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const queue = createDownloadQueue(stubDeps(provider));
  const tracks = [1, 2, 3, 4, 5].map((n) => metaOf(n));
  const id = queue.start(sourceOf(tracks), 'spotify-direct', 'Q:\\unused', PRESET);
  const rec = await untilFinished(queue, id);
  assertEq(peak, 2, 'peak concurrency is exactly the 2-slot cap');
  assertEq(rec.tracks.length, 5, 'all five tracks are in the record');
  assert(rec.tracks.every((t) => t.state === 'done'), 'all five tracks done');
});

test('jitter sleeps between a record\u2019s track starts, within [500,1500] ms', async () => {
  const state: MockState = { calls: [] };
  const provider = instantProvider(state, writeRawBehavior(state));
  const slept: number[] = [];
  const queue = createDownloadQueue(stubDeps(provider, {
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  }));
  const id = queue.start(
    sourceOf([metaOf(1), metaOf(2), metaOf(3)]),
    'spotify-direct', 'Q:\\unused', PRESET,
  );
  await untilFinished(queue, id);
  assertEq(slept.length, 2, 'jitter fires between starts, not before the first');
  assert(slept.every((ms) => ms >= 500 && ms <= 1500), `jitter values in window: ${slept.join(', ')}`);
});

test('a hanging provider times out and the queue continues with the next track', async () => {
  const state: MockState = { calls: [] };
  const provider = instantProvider(state, async (track) => {
    if (track.sourceId === 'id0') await new Promise(() => { /* hangs forever */ });
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const convertCalls: string[] = [];
  const queue = createDownloadQueue(stubDeps(provider, {
    trackTimeoutMs: 200,
    convert: (rawPaths) => {
      convertCalls.push(...rawPaths);
      return Promise.resolve(rawPaths.map((p): FlushReportItem => ({ sourcePath: p, outputPath: p + '.out', status: 'ok' })));
    },
  }));
  const id = queue.start(sourceOf([metaOf(0), metaOf(1)]), 'spotify-direct', 'Q:\\unused', PRESET);
  const rec = await untilFinished(queue, id, 30_000);
  assertEq(rec.tracks[0]?.state, 'failed', 'hung track failed');
  assertEq(rec.tracks[0]?.reason, 'timeout', 'hung track failed with reason timeout');
  assertEq(rec.tracks[1]?.state, 'done', 'next track completed');
  assertEq(convertCalls.length, 1, 'flush ran once with only the finished track');
});

test('cancel mid-flight aborts the download and the partial file is gone', async () => {
  const dir = scratch('cancel');
  try {
    let partPath = '';
    const provider: DownloadProvider = {
      id: 'spotify-direct',
      rawExtensions: ['.ogg'],
      async resolve() { throw new Error('unused'); },
      download(_track, destBase, opts) {
        return new Promise((_res, rej) => {
          mkdirSync(destBase, { recursive: true });
          partPath = join(destBase, 'partial.webm.part');
          writeFileSync(partPath, 'partial-bytes');
          opts.signal.addEventListener('abort', () => {
            rmSync(partPath, { force: true });
            rej(new Error('aborted'));
          });
        });
      },
    };
    const queue = createDownloadQueue(stubDeps(provider));
    // The destination must be a real directory: this mock materialises its
    // partial file there, which is the thing cancellation has to clean up.
    const id = queue.start(sourceOf([metaOf(0)]), 'spotify-direct', dir, PRESET);

    const deadline = Date.now() + 5_000;
    while (!existsSync(partPath)) {
      if (Date.now() > deadline) throw new Error('mock provider never wrote its partial file');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(queue.cancel(id), 'cancel reports the record was found');
    const rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'cancelled', 'track state is cancelled');
    assertEq(rec.tracks[0]?.reason, 'cancelled', 'track reason is cancelled');
    assert(!existsSync(partPath), 'the provider cleaned its partial file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-if-exists: a raw above 1 KiB is skipped, a smaller one re-downloads', async () => {
  const dir = scratch('skip-exists');
  try {
    const state: MockState = { calls: [] };
    const provider = instantProvider(state, writeRawBehavior(state));
    const queue = createDownloadQueue(stubDeps(provider));
    const base = join(dir, `${sanitizeFilename('Artist 1 - Song 1')}.ogg`);

    writeFileSync(base, Buffer.alloc(2048, 7));
    let id = queue.start(sourceOf([metaOf(1)]), 'spotify-direct', dir, PRESET);
    let rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'skipped', 'big existing raw is skipped');
    assertEq(state.calls.length, 0, 'the provider was never called for a skipped track');

    writeFileSync(base, Buffer.alloc(500, 7));
    id = queue.start(sourceOf([metaOf(1)]), 'spotify-direct', dir, PRESET);
    rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'done', 'small existing raw re-downloads');
    assertEq(state.calls.length, 1, 'the provider ran once for the small raw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retry re-queues only the requested failed indices', async () => {
  const state: MockState = { calls: [] };
  const seen = new Map<string, number>();
  const provider = instantProvider(state, async (track) => {
    const nth = (seen.get(track.sourceId) ?? 0) + 1;
    seen.set(track.sourceId, nth);
    if (track.sourceId === 'id0' && nth === 1) throw new Error('transient io failure');
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const queue = createDownloadQueue(stubDeps(provider));
  const id = queue.start(sourceOf([metaOf(0), metaOf(1)]), 'spotify-direct', 'Q:\\unused', PRESET);
  let rec = await untilFinished(queue, id);
  assertEq(rec.tracks[0]?.state, 'failed', 'first attempt failed');
  assertEq(rec.tracks[1]?.state, 'done', 'unaffected track is done');

  assert(queue.retry(id, [0]), 'retry reports the record was found');
  rec = await untilFinished(queue, id);
  assertEq(rec.tracks[0]?.state, 'done', 'retried track succeeded on its second attempt');
  assertEq(rec.tracks[1]?.state, 'done', 'retry left the finished track alone');
  const id0Calls = state.calls.filter((c) => c === 'id0').length;
  const id1Calls = state.calls.filter((c) => c === 'id1').length;
  assertEq(id0Calls, 2, 'the failed track ran twice');
  assertEq(id1Calls, 1, 'the finished track never re-ran');
});

test('a cookie-expired failure fails every still-queued track fast', async () => {
  const state: MockState = { calls: [] };
  const provider = instantProvider(state, async (track) => {
    if (track.sourceId === 'id0') throw new DownloadFailure('cookie-expired', 'sp_dc 已失效');
    await new Promise((r) => setTimeout(r, 25));
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const queue = createDownloadQueue(stubDeps(provider));
  const id = queue.start(
    sourceOf([metaOf(0), metaOf(1), metaOf(2), metaOf(3)]),
    'spotify-direct', 'Q:\\unused', PRESET,
  );
  const rec = await untilFinished(queue, id);
  assertEq(rec.tracks[0]?.reason, 'cookie-expired', 'the origin failure kept its reason');
  assertEq(rec.tracks[2]?.state, 'failed', 'queued track 2 failed fast');
  assertEq(rec.tracks[2]?.reason, 'cookie-expired', 'queued track 2 carries the same reason');
  assertEq(rec.tracks[3]?.state, 'failed', 'queued track 3 failed fast');
  assertEq(rec.tracks[1]?.state, 'done', 'the in-flight track still finished');
  assertEq(state.calls.length, 2, 'no further provider calls after the fail-fast');
});

test('hostile titles land at sanitised names inside the destination', async () => {
  const dir = scratch('filenames');
  try {
    const state: MockState = { calls: [] };
    const provider = instantProvider(state, writeRawBehavior(state));
    const queue = createDownloadQueue(stubDeps(provider));
    const metas = [
      metaOf(0, 'AC/DC: "Best" <Hits>?', 'Weird*Band:'),
      metaOf(1, '標題《中文》：測試？', 'A/B\\C|D?E*F"G:H<I>J'),
      metaOf(2, 'trailing...   ', '  spaced  '),
    ];
    const id = queue.start(sourceOf(metas), 'spotify-direct', dir, PRESET);
    const rec = await untilFinished(queue, id);
    for (const t of rec.tracks) {
      const raw = t.rawPath;
      assert(raw !== undefined, 'track has a raw path');
      const expected = join(dir, `${sanitizeFilename(`${t.meta.artists} - ${t.meta.title}`)}.ogg`);
      assertEq(raw, expected, 'raw path is the sanitised name inside the destination');
      assert(existsSync(raw), 'the raw file exists at that path');
    }
    assert(rec.tracks.every((t) => t.state === 'done'), 'all tracks done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: conversion is ONE real runBatch flush and tags survive', async () => {
  let bins: BinPaths | null = null;
  try {
    bins = findBinaries();
  } catch {
    // fall through to the skip below
  }
  if (!bins) {
    process.stdout.write('  (skipping: no ffmpeg binaries)\n');
    return;
  }
  const dir = scratch('flush');
  try {
    const state: MockState = { calls: [] };
    const provider = instantProvider(state, async (track, destBase) => {
      mkdirSync(destBase, { recursive: true });
      const rawPath = join(dir, `${sanitizeFilename(`${track.artists} - ${track.title}`)}.ogg`);
      const r = await runFfmpeg(
        bins!.ffmpeg,
        ['-y', '-hide_banner', '-loglevel', 'error',
         '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
         '-c:a', 'libvorbis', rawPath],
        { cwd: dir, timeoutMs: 30_000 },
      );
      assertEq(r.code, 0, `fixture for ${track.sourceId} encodes`);
      return { rawPath };
    });

    let queueRef: DownloadQueue | null = null;
    let idRef = '';
    const convertCalls: string[][] = [];
    const snapshots: string[][] = [];
    const deps: QueueDeps = {
      providers: { 'spotify-direct': provider, 'youtube-match': provider, 'youtube-direct': provider },
      ffmpeg: bins.ffmpeg,
      ffprobe: bins.ffprobe,
      scratch: dir,
      sleep: () => Promise.resolve(),
      convert: (rawPaths, ctx) => {
        convertCalls.push([...rawPaths]);
        const rec = queueRef?.get(idRef);
        if (rec) snapshots.push(rec.tracks.filter((t) => t.rawPath).map((t) => t.state));
        return singleFlushConvert(rawPaths, ctx, { ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe, scratch: dir });
      },
    };
    const queue = createDownloadQueue(deps);
    const id = queue.start(
      sourceOf([metaOf(0, '頭一個'), metaOf(1, '第二首')]),
      'spotify-direct', dir, PRESET,
    );
    queueRef = queue;
    idRef = id;

    const rec = await untilFinished(queue, id, 120_000);
    assertEq(convertCalls.length, 1, 'exactly one flush for two tracks');
    assertEq(convertCalls[0]?.length, 2, 'the flush carried both raws');
    assert(snapshots[0]?.every((s) => s === 'converting'), 'flushed tracks passed through converting');

    for (const t of rec.tracks) {
      assertEq(t.state, 'done', `track ${t.index} done`);
      assert(t.outputPath !== undefined, 'track has an output path');
      assert(t.outputPath!.endsWith('.mp3'), 'output uses the preset container');
      assert(existsSync(t.outputPath!), 'output exists');
      assert(t.rawKbps !== undefined && t.rawKbps > 0, 'source bitrate was probed');
      const info = await probe(bins.ffprobe, t.outputPath!, dir);
      assertEq(readTags(info).title, t.meta.title, 'converted output kept its title tag');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a no-confident-match failure does not stop the other tracks', async () => {
  const state: MockState = { calls: [] };
  const provider = instantProvider(state, async (track) => {
    if (track.sourceId === 'id1') throw new DownloadFailure('no-confident-match', '找不到對應版本');
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const queue = createDownloadQueue(stubDeps(provider));
  const id = queue.start(sourceOf([metaOf(0), metaOf(1), metaOf(2)]), 'spotify-direct', 'Q:\\unused', PRESET);
  const rec = await untilFinished(queue, id);
  assertEq(rec.tracks[1]?.state, 'failed', 'unmatched track failed');
  assertEq(rec.tracks[1]?.reason, 'no-confident-match', 'reason carried through');
  assert(rec.tracks[0]?.state === 'done' && rec.tracks[2]?.state === 'done', 'other tracks finished');
});

test('rate-limit pauses globally and retries the track once', async () => {
  const state: MockState = { calls: [] };
  const seen = new Map<string, number>();
  const provider = instantProvider(state, async (track) => {
    const nth = (seen.get(track.sourceId) ?? 0) + 1;
    seen.set(track.sourceId, nth);
    if (track.sourceId === 'id0' && nth === 1) throw new DownloadFailure('rate-limit', '429');
    return { rawPath: `X:\\never\\${track.sourceId}.ogg` };
  });
  const slept: number[] = [];
  const queue = createDownloadQueue(stubDeps(provider, {
    rateLimitPauseMs: 5,
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  }));
  const id = queue.start(sourceOf([metaOf(0), metaOf(1)]), 'spotify-direct', 'Q:\\unused', PRESET);
  const rec = await untilFinished(queue, id);
  assert(slept.includes(5), `the rate-limit pause was slept: ${slept.join(', ')}`);
  assertEq(rec.tracks[0]?.state, 'done', 'rate-limited track succeeded on retry');
  assertEq(state.calls.filter((c) => c === 'id0').length, 2, 'rate-limited track ran twice');
  assertEq(state.calls.filter((c) => c === 'id1').length, 1, 'the other track ran once');
});

/* ------------------------------------------------------------------ */
/* Skip-if-exists across a provider's whole extension list (Task 4)     */
/* ------------------------------------------------------------------ */

test('skip-if-exists matches a raw under the second extension', async () => {
  const state: MockState = { calls: [] };
  const provider = multiExtProvider(state);
  const meta = metaOf(1);
  const dir = scratch('skip-second-ext');
  try {
    const expected = join(dir, `${sanitizeFilename(`${meta.artists} - ${meta.title}`)}.m4a`);
    writeFileSync(expected, Buffer.alloc(2048));
    const queue = createDownloadQueue(stubDeps(provider));
    const id = queue.start(sourceOf([meta]), 'youtube-match', dir, PRESET);
    const rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'skipped', 'an existing .m4a counts as a finished download');
    assertEq(state.calls.length, 0, 'the provider was never called');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-if-exists re-downloads a sub-1 KiB raw', async () => {
  const state: MockState = { calls: [] };
  const provider = multiExtProvider(state);
  const meta = metaOf(2);
  const dir = scratch('skip-too-small');
  try {
    const expected = join(dir, `${sanitizeFilename(`${meta.artists} - ${meta.title}`)}.webm`);
    writeFileSync(expected, Buffer.alloc(500));
    const queue = createDownloadQueue(stubDeps(provider));
    const id = queue.start(sourceOf([meta]), 'youtube-match', dir, PRESET);
    const rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'done', 'a half-written raw is fetched again');
    assertEq(state.calls.length, 1, 'the provider ran once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-if-exists downloads when no candidate extension exists', async () => {
  const state: MockState = { calls: [] };
  const provider = multiExtProvider(state);
  const meta = metaOf(3);
  const dir = scratch('skip-none');
  try {
    const queue = createDownloadQueue(stubDeps(provider));
    const id = queue.start(sourceOf([meta]), 'youtube-match', dir, PRESET);
    const rec = await untilFinished(queue, id);
    assertEq(rec.tracks[0]?.state, 'done', 'nothing to skip');
    assertEq(state.calls.length, 1, 'the provider ran once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
