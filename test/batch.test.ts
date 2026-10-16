/**
 * batch.ts — the full scan -> analyze -> plan -> render -> verify -> report pipeline.
 *
 * These tests are deliberately end-to-end: they encode real audio with ffmpeg, run a
 * real batch, then re-probe the OUTPUT files with ffprobe and assert on the measured
 * bitrate / sample rate / channels / size. A batch that only produced plausible argv
 * strings would fail every one of them.
 *
 * Two contract guarantees are pinned here because they are user requirements:
 *   1. Loudness is two-pass. The proof is not that `measured_I=` appears in the
 *      command line (that is a string assertion) but that the OUTPUT's internal
 *      dynamic range is preserved: a source with a 30 dB step between two halves
 *      must still have a ~30 dB step after normalization, while landing at -14 LUFS.
 *   2. The batch denoise default is gentle afftdn + adeclick. DeepFilterNet must
 *      never appear, because it is a speech model that destroys music.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertClose, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { probe } from '../src/core/probe.ts';
import { parseLoudnormReport } from '../src/core/loudness.ts';
import { usbPreset } from '../src/core/edl.ts';
import { scanLibrary } from '../src/core/library.ts';
import type { LibraryEntry } from '../src/core/library.ts';
import {
  batchEffects,
  containerExtension,
  defaultConcurrency,
  effectivePreset,
  estimateOutputBytes,
  inPlaceName,
  inPlaceTargetProblem,
  manifestJson,
  mapPool,
  planBatch,
  runBatch,
  writeManifest,
} from '../src/core/batch.ts';
import type { BatchOptions } from '../src/core/batch.ts';
import type { ExportPreset } from '../src/core/types.ts';

let bins: BinPaths | null = null;
let unavailable = '';
try {
  bins = findBinaries();
} catch (err) {
  unavailable = (err as Error).message;
}

function skipUnlessAvailable(): boolean {
  if (!bins) {
    process.stdout.write(`  (skipping: ${unavailable.split('\n')[0]})\n`);
    return true;
  }
  return false;
}

const ROOT = join(tmpdir(), 'aus-batch');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Encode a real tone at a given level. */
async function makeTone(
  dir: string,
  name: string,
  opts: { freq?: number; dur?: number; volDb?: number } = {},
): Promise<string> {
  const freq = opts.freq ?? 440;
  const dur = opts.dur ?? 6;
  const out = join(dir, name);
  const r = await runFfmpeg(
    bins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=44100`,
      '-af', `volume=${opts.volDb ?? 0}dB`,
      '-ac', '2', out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`could not create ${name}: exit ${r.code}`);
  return out;
}

/** Build a source whose two halves differ by `stepDb`. */
async function makeDynamicSource(dir: string, name: string, stepDb = 30, half = 4): Promise<string> {
  const quiet = join(dir, `${name}-quiet.wav`);
  const loud = join(dir, `${name}-loud.wav`);
  await runFfmpeg(
    bins!.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${half}:sample_rate=44100`,
      '-af', `volume=-${stepDb}dB`, '-ac', '2', quiet],
    { cwd: dir },
  );
  await runFfmpeg(
    bins!.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${half}:sample_rate=44100`,
      '-ac', '2', loud],
    { cwd: dir },
  );
  const out = join(dir, name);
  const r = await runFfmpeg(
    bins!.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', quiet, '-i', loud,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', out],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`could not build ${name}`);
  return out;
}

/** Mean volume of a slice, in dB, read from ffmpeg's own report. */
async function meanVolume(file: string, ss: number, t: number): Promise<number | null> {
  const dir = scratch('vol');
  try {
    const r = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', file,
        '-af', 'volumedetect', '-f', 'null', '-'],
      { cwd: dir },
    );
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.report ?? '');
    return m ? parseFloat(m[1]!) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Measure a file's integrated loudness / true peak independently of the batch. */
async function measureFile(file: string): Promise<{ i: number; tp: number } | null> {
  const dir = scratch('measure');
  try {
    const r = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-i', file,
        '-af', 'loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json',
        '-f', 'null', '-'],
      { cwd: dir },
    );
    const m = parseLoudnormReport(r.report ?? '');
    return m ? { i: m.inputI, tp: m.inputTp } : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Pure planning helpers                                               */
/* ------------------------------------------------------------------ */

test('batch: effectivePreset applies the loudness override and honours null as "off"', () => {
  const preset = usbPreset();

  const untouched = effectivePreset(preset, undefined);
  assertEq(untouched.loudness.enabled, true, 'undefined keeps the preset target');
  assertEq(untouched.loudness.integratedLufs, -14, 'the USB target is -14 LUFS');

  const overridden = effectivePreset(preset, { integratedLufs: -16, truePeakDb: -2, lra: 9 });
  assertEq(overridden.loudness.enabled, true, 'an explicit target stays enabled');
  assertEq(overridden.loudness.integratedLufs, -16, 'integrated target overridden');
  assertEq(overridden.loudness.truePeakDb, -2, 'true peak overridden');
  assertEq(overridden.loudness.lra, 9, 'LRA overridden');

  const disabled = effectivePreset(preset, null);
  assertEq(disabled.loudness.enabled, false, 'null disables normalization');
  // Disabling must not silently rewrite the target itself.
  assertEq(disabled.loudness.integratedLufs, -14, 'the target is preserved when disabled');
});

test('batch: the batch denoise chain is gentle afftdn + adeclick and never DeepFilterNet', () => {
  const preset = usbPreset();
  assertEq(preset.denoise, 'gentle', 'the USB preset default is gentle');

  const effects = batchEffects(preset);
  assertEq(effects.length, 2, 'exactly two cleanup stages');
  assertEq(effects[0]!.type, 'denoise', 'first stage is denoise');
  const denoise = effects[0]!;
  assert(denoise.type === 'denoise', 'the first stage is a denoise effect');
  if (denoise.type === 'denoise') {
    assertEq(denoise.strength, 'gentle', 'denoise runs at gentle strength');
  }
  assertEq(effects[1]!.type, 'declick', 'second stage is declick');

  // The batch must never reference the speech model.
  const json = JSON.stringify(effects).toLowerCase();
  assert(!json.includes('deepfilter'), 'DeepFilterNet is not in the batch chain');
  assert(!json.includes('dfn'), 'no DFN stage in the batch chain');
  assert(!json.includes('arnndn'), 'no RNN denoiser in the batch chain');

  const off = batchEffects({ ...preset, denoise: 'off' });
  assertEq(off, [], 'denoise "off" yields an empty chain');
});

test('batch: containerExtension and estimateOutputBytes match the preset', () => {
  const preset = usbPreset();
  assertEq(containerExtension(preset), '.mp3', 'USB preset is MP3');
  assertEq(containerExtension({ ...preset, container: 'flac' }), '.flac', 'FLAC extension');
  assertEq(containerExtension({ ...preset, container: 'wav' }), '.wav', 'WAV extension');

  // 320 kbps for 60 s = 320000 * 60 / 8 bytes.
  assertEq(estimateOutputBytes(preset, 60), 2_400_000, 'lossy estimate from bitrate');
  assertEq(estimateOutputBytes(preset, 0), 0, 'zero duration needs zero bytes');
  // A PCM container is estimated from sample rate * channels * 2 bytes.
  const wav: ExportPreset = { ...preset, container: 'wav', bitrateKbps: null };
  assertEq(estimateOutputBytes(wav, 10), 44100 * 2 * 2 * 10, 'PCM estimate');
  // FLAC is estimated as a fraction of PCM, so it must be smaller than WAV.
  const flac: ExportPreset = { ...preset, container: 'flac', bitrateKbps: null };
  assert(estimateOutputBytes(flac, 10) < estimateOutputBytes(wav, 10), 'FLAC estimate is below PCM');
});

test('batch: defaultConcurrency stays inside what one storage device can serve', () => {
  const n = defaultConcurrency();
  assert(Number.isInteger(n) && n >= 1, `concurrency is a positive integer (got ${n})`);
  // This tool renders many small files onto one USB stick. That is bounded by the
  // device, not by the CPU: the old `cpus - 1` default opened 15 concurrent
  // writers against a single FAT32 stick and the device served about 1 MiB/s.
  assert(n <= 4, `does not stampede one device with writers (got ${n})`);
});

test('batch: mapPool runs every item, preserves order and respects the limit', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  let inFlight = 0;
  let peak = 0;
  const out = await mapPool(items, 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 2;
  });
  assertEq(out, [2, 4, 6, 8, 10, 12, 14], 'results are in input order');
  assert(peak <= 3, `never exceeded the concurrency limit (peak ${peak})`);
  assert(peak > 1, `actually ran concurrently (peak ${peak})`);

  assertEq(await mapPool([], 4, async () => 1), [], 'an empty list yields an empty result');
  const single = await mapPool([1], 8, async (n) => n + 1);
  assertEq(single, [2], 'a limit above the item count is clamped');
});

/* ------------------------------------------------------------------ */
/* planBatch                                                           */
/* ------------------------------------------------------------------ */

test('INTEGRATION: planBatch names outputs from tags and derives them from filenames', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('plan');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });

    await makeTone(music, '01 - Artist - First Song.wav', { freq: 440 });
    await makeTone(music, '02 - Artist - Second Song.wav', { freq: 880 });

    const scan = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(scan.entries.length, 2, 'two files scanned');

    const plan = await planBatch(scan.entries, {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe, scratch: dir,
      roots: [music], outputDir: out, preset: usbPreset(),
    });

    assertEq(plan.items.length, 2, 'two plan items');
    for (const item of plan.items) {
      assert(item.outputPath.startsWith(out), `${item.outputPath} is inside the output dir`);
      assert(item.outputPath.endsWith('.mp3'), `${item.outputPath} has the container extension`);
      assert(item.skipped === undefined, `${item.sourcePath} is planned for render`);
      assert(item.durationSec > 0, `${item.sourcePath} carries a duration`);
      // Tags were derived from the filename, because a WAV has none.
      assert(item.tags.title !== undefined, `${item.sourcePath} got a title`);
      assert(item.tags.artist === 'Artist', `${item.sourcePath} got the artist from the filename`);
    }

    const names = plan.items.map((i) => i.outputPath).sort();
    assertEq(new Set(names).size, 2, 'the two outputs have distinct paths');
    assert(names.some((p) => p.includes('First Song')), 'the first title appears in a filename');
    assert(names.some((p) => p.includes('Second Song')), 'the second title appears in a filename');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: planBatch truncates at targetCapacityBytes and marks the overflow skipped', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('capacity');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - A - One.wav', { freq: 440, dur: 6 });
    await makeTone(music, '02 - A - Two.wav', { freq: 880, dur: 6 });

    const scan = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(scan.entries.length, 2, 'two files scanned');

    const preset = usbPreset();
    // One 6 s / 320 kbps item is ~240000 B; a budget of 250000 fits exactly one.
    const perItem = estimateOutputBytes(preset, 6);
    const plan = await planBatch(scan.entries, {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe, scratch: dir,
      roots: [music], outputDir: out, preset,
      targetCapacityBytes: perItem + 1000,
    });

    assertEq(plan.items.length, 2, 'both entries appear in the plan');
    const rendered = plan.items.filter((i) => i.skipped === undefined);
    const skipped = plan.items.filter((i) => i.skipped !== undefined);
    assertEq(rendered.length, 1, 'only one item fits the budget');
    assertEq(skipped.length, 1, 'the other is skipped');
    assert(
      skipped[0]!.skipped!.includes('capacity'),
      `the skip reason names capacity (got ${JSON.stringify(skipped[0]!.skipped)})`,
    );

    // A null budget must not truncate anything.
    const unlimited = await planBatch(scan.entries, {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe, scratch: dir,
      roots: [music], outputDir: out, preset, targetCapacityBytes: null,
    });
    assertEq(unlimited.items.filter((i) => i.skipped === undefined).length, 2, 'null budget renders all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: planBatch drops duplicates before they consume capacity', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('plandup');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    const a = await makeTone(music, '01 - A - Song.wav', { freq: 440, dur: 6 });
    const b = join(music, '02 - A - Song copy.wav');
    writeFileSync(b, readFileSync(a));

    const scan = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(scan.entries.length, 2, 'both copies scanned');

    const plan = await planBatch(scan.entries, {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe, scratch: dir,
      roots: [music], outputDir: out, preset: usbPreset(), dedup: true,
    });

    assertEq(plan.duplicates.length, 1, 'one duplicate group detected');
    assertEq(plan.duplicates[0]!.drop.length, 1, 'one copy is dropped');
    const droppedId = plan.duplicates[0]!.drop[0]!;
    const droppedItem = plan.items.find((i) => i.id === droppedId);
    assert(droppedItem !== undefined, 'the dropped entry is still present in the plan');
    assertEq(droppedItem!.skipped, 'duplicate', 'the dropped item is marked as a duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* runBatch — the real thing                                           */
/* ------------------------------------------------------------------ */

test('INTEGRATION: runBatch renders a real USB library and the outputs verify with ffprobe', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('e2e');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });

    // Three real sources at three different loudness levels.
    await makeTone(music, '01 - Artist - Quiet.wav', { freq: 440, dur: 5, volDb: -24 });
    await makeTone(music, '02 - Artist - Medium.wav', { freq: 660, dur: 5, volDb: -12 });
    await makeTone(music, '03 - Artist - Loud.wav', { freq: 880, dur: 5, volDb: 0 });

    const opts: BatchOptions = {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), dedup: false, concurrency: 2,
    };

    const stages: string[] = [];
    const report = await runBatch({ ...opts, onProgress: (ev) => stages.push(ev.stage) });

    assertEq(report.items.length, 3, 'three items reported');
    const ok = report.items.filter((i) => i.status === 'ok');
    assertEq(ok.length, 3, `all three rendered (statuses ${report.items.map((i) => i.status).join(',')})`);

    assert(report.totalBytes > 0, 'a positive total size was reported');
    assert(report.durationMs >= 0, 'a duration was reported');
    assertEq(report.preset.container, 'mp3', 'the report carries the effective preset');
    assertEq(report.preset.loudness.integratedLufs, -14, 'the report carries the -14 LUFS target');
    assertEq(report.duplicates.length, 0, 'no duplicates were requested');

    // The pipeline must actually have walked every stage.
    for (const stage of ['scan', 'plan', 'render', 'report']) {
      assert(stages.includes(stage), `progress reported the "${stage}" stage`);
    }

    // Independent verification of each output file.
    for (const item of report.items) {
      assert(item.outputPath !== null, `${item.id} has an output path`);
      const file = item.outputPath!;
      assert(existsSync(file), `${file} exists on disk`);
      const size = statSync(file).size;
      assert(size > 1000, `${file} is a real file (${size} bytes)`);

      const info = await probe(bins!.ffprobe, file, dir);
      assert(info.audio !== null, `${file} has an audio stream`);
      const a = info.audio!;
      assertEq(a.bitRate, 320000, `${file} is 320 kbps CBR`);
      assertEq(a.sampleRate, 44100, `${file} is 44.1 kHz`);
      assertEq(a.channels, 2, `${file} is stereo`);
      assert(a.codecName.toLowerCase().includes('mp3'), `${file} is MP3 (${a.codecName})`);
      assertClose(info.format.durationSec, 5, 0.35, `${file} is ~5 s`);

      // The batch's own verifier must also have passed.
      assert(item.verify !== undefined, `${item.id} carries a verify result`);
      assertEq(item.verify!.ok, true, `${item.id} passed verification: ${JSON.stringify(item.verify!.problems)}`);
      assertEq(item.verify!.problems, [], `${item.id} has no verification problems`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch lands the output at -14 LUFS with two-pass loudnorm preserving dynamic range', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('loudness');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });

    // A source with a 30 dB internal step: 4 s quiet, then 4 s loud.
    const src = await makeDynamicSource(dir, 'dynamic.wav', 30, 4);
    const srcQuiet = await meanVolume(src, 0.5, 3);
    const srcLoud = await meanVolume(src, 4.5, 3);
    assert(srcQuiet !== null && srcLoud !== null, 'the source was measurable');
    const srcStep = srcLoud! - srcQuiet!;
    assertClose(srcStep, 30, 1.0, `precondition: the source has a 30 dB step (got ${srcStep.toFixed(2)})`);

    // Give it a filename that yields a stable output name.
    const named = join(music, '01 - Artist - Dynamic.wav');
    writeFileSync(named, readFileSync(src));
    rmSync(src, { force: true });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), concurrency: 1,
    });

    assertEq(report.items.length, 1, 'one item');
    const item = report.items[0]!;
    assertEq(item.status, 'ok', `the render succeeded (${item.message ?? ''})`);
    const file = item.outputPath!;
    assert(existsSync(file), 'the output exists');

    // 1. It must land on the -14 LUFS target.
    const m = await measureFile(file);
    assert(m !== null, 'the output was measurable');
    assertClose(m!.i, -14, 1.5, `integrated loudness is ${m!.i} LUFS, target -14`);
    assert(m!.tp <= -1.0 + 1.0, `true peak ${m!.tp} dBTP stays under the -1.0 ceiling (+1 dB tolerance)`);

    // 2. The internal dynamic range must survive. A single-pass loudnorm would
    //    collapse this step; two-pass applies static gain and preserves it.
    const outQuiet = await meanVolume(file, 0.5, 3);
    const outLoud = await meanVolume(file, 4.5, 3);
    assert(outQuiet !== null && outLoud !== null, 'the output was measurable in halves');
    const outStep = outLoud! - outQuiet!;
    assertClose(
      outStep,
      srcStep,
      1.5,
      `the 30 dB dynamic step survived normalization (source ${srcStep.toFixed(2)} dB, output ${outStep.toFixed(2)} dB)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: a single unreadable source fails alone and does not abort the batch', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('resilience');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });

    await makeTone(music, '01 - Artist - Good One.wav', { freq: 440, dur: 4 });
    // A file with an audio extension but garbage content: ffprobe cannot read it.
    writeFileSync(join(music, '02 - Artist - Broken.wav'), 'not audio at all, just text');
    await makeTone(music, '03 - Artist - Good Two.wav', { freq: 880, dur: 4 });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), concurrency: 2,
    });

    const ok = report.items.filter((i) => i.status === 'ok');
    const failed = report.items.filter((i) => i.status === 'failed');

    assertEq(ok.length, 2, `the two good files still rendered (got ${ok.length} ok)`);
    assertEq(failed.length, 1, `exactly one failure reported (got ${failed.length})`);
    assert(failed[0]!.message !== undefined && failed[0]!.message!.length > 0, 'the failure carries a message');
    assert(failed[0]!.sourcePath.includes('Broken'), 'the failure names the broken file');
    assertEq(failed[0]!.outputPath, null, 'a failed item has no output path');

    // The batch must complete and still report totals.
    assert(report.totalBytes > 0, 'the successful renders contributed bytes');
    assertEq(report.items.length, 3, 'every source appears in the report');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch is idempotent — a second run overwrites and still verifies', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('rerun');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - Artist - Once.wav', { freq: 440, dur: 4 });

    const opts: BatchOptions = {
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), concurrency: 1,
    };
    const first = await runBatch(opts);
    const second = await runBatch(opts);

    assertEq(first.items[0]!.status, 'ok', 'the first run succeeded');
    assertEq(second.items[0]!.status, 'ok', 'the second run succeeded');
    assertEq(first.items[0]!.outputPath, second.items[0]!.outputPath, 'the output path is stable');
    assert(existsSync(second.items[0]!.outputPath!), 'the output still exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch respects a capacity budget end to end', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('capacity-e2e');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - Artist - One.wav', { freq: 440, dur: 5 });
    await makeTone(music, '02 - Artist - Two.wav', { freq: 880, dur: 5 });
    await makeTone(music, '03 - Artist - Three.wav', { freq: 1320, dur: 5 });

    const preset = usbPreset();
    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset, concurrency: 2,
      // Room for exactly one 5 s / 320 kbps output.
      targetCapacityBytes: estimateOutputBytes(preset, 5) + 1000,
    });

    const ok = report.items.filter((i) => i.status === 'ok');
    const skipped = report.items.filter((i) => i.status === 'skipped');
    assertEq(ok.length, 1, `exactly one item rendered (got ${ok.length})`);
    assertEq(skipped.length, 2, `two were skipped (got ${skipped.length})`);
    for (const s of skipped) {
      assertEq(s.outputPath, null, 'a skipped item has no output path');
      assert(s.message !== undefined && s.message.includes('capacity'), 'the skip reason names capacity');
    }

    // Only the rendered file may exist on disk.
    const onDisk = readdirSafe(out).filter((f) => f.endsWith('.mp3'));
    assertEq(onDisk.length, 1, `only one output file was written (got ${JSON.stringify(onDisk)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch with dedup drops a duplicate copy and reports the group', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('dedup-e2e');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    const a = await makeTone(music, '01 - Artist - Original.wav', { freq: 440, dur: 5 });
    writeFileSync(join(music, '02 - Artist - Copy.wav'), readFileSync(a));

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), dedup: true, concurrency: 1,
    });

    assertEq(report.duplicates.length, 1, 'one duplicate group was reported');
    const ok = report.items.filter((i) => i.status === 'ok');
    const skipped = report.items.filter((i) => i.status === 'skipped');
    assertEq(ok.length, 1, `one item rendered (got ${ok.length})`);
    assertEq(skipped.length, 1, `one item skipped as a duplicate (got ${skipped.length})`);
    assertEq(skipped[0]!.message, 'duplicate', 'the skip reason is "duplicate"');
    assertEq(report.totalBytes, statSync(ok[0]!.outputPath!).size, 'the total counts only rendered bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch honours a loudness override and a disabled target', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('override');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - Artist - Tone.wav', { freq: 440, dur: 5, volDb: -20 });

    // An explicit -20 LUFS target.
    const overridden = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch-a'), roots: [music], outputDir: join(dir, 'out-a'),
      preset: usbPreset(), concurrency: 1,
      loudness: { integratedLufs: -20, truePeakDb: -2, lra: 11 },
    });
    assertEq(overridden.items[0]!.status, 'ok', `override render succeeded (${overridden.items[0]!.message ?? ''})`);
    const m = await measureFile(overridden.items[0]!.outputPath!);
    assert(m !== null, 'measurable');
    assertClose(m!.i, -20, 1.5, `the override target was honoured (got ${m!.i} LUFS, wanted -20)`);

    // `loudness: null` disables normalization: the output must NOT be pulled to -14.
    const disabled = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch-b'), roots: [music], outputDir: join(dir, 'out-b'),
      preset: usbPreset(), concurrency: 1, loudness: null,
    });
    assertEq(disabled.items[0]!.status, 'ok', `disabled-loudness render succeeded (${disabled.items[0]!.message ?? ''})`);
    const dm = await measureFile(disabled.items[0]!.outputPath!);
    assert(dm !== null, 'measurable');
    assert(
      Math.abs(dm!.i - -20) > 3,
      `normalization really was skipped: the -20 dBFS source is not at -14 LUFS (measured ${dm!.i})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The report artifact                                                 */
/* ------------------------------------------------------------------ */

test('INTEGRATION: writeManifest writes a readable manifest.json describing the batch', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('manifest');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - Artist - Song.wav', { freq: 440, dur: 4 });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), concurrency: 1,
    });

    const path = join(out, 'manifest.json');
    writeManifest(report, path);
    assert(existsSync(path), 'manifest.json was written');

    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as typeof report;
    assertEq(parsed.items.length, report.items.length, 'every item is in the manifest');
    assertEq(parsed.totalBytes, report.totalBytes, 'the total size round-trips');
    assertEq(parsed.preset.container, 'mp3', 'the preset round-trips');
    assert(Array.isArray(parsed.duplicates), 'the duplicates list round-trips');

    // The manifest must be self-describing enough to re-locate every output.
    for (const item of parsed.items) {
      assert(typeof item.id === 'string' && item.id.length > 0, 'each item has an id');
      assert(typeof item.sourcePath === 'string' && item.sourcePath.length > 0, 'each item names its source');
      assert(
        ['ok', 'failed', 'skipped'].includes(item.status),
        `status is one of the three allowed values (got ${item.status})`,
      );
    }

    assertEq(manifestJson(report), text, 'manifestJson produces exactly what was written');
    // A manifest nested one level deeper must still be created.
    const nested = join(out, 'sub', 'dir', 'manifest.json');
    writeManifest(report, nested);
    assert(existsSync(nested), 'writeManifest creates missing parent directories');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: runBatch surfaces scan errors as failed rows instead of losing them', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('scanerrors');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    mkdirSync(out, { recursive: true });
    await makeTone(music, '01 - Artist - Fine.wav', { freq: 440, dur: 4 });
    writeFileSync(join(music, '02 - Artist - Garbage.wav'), 'garbage bytes');

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg, ffprobe: bins!.ffprobe,
      scratch: join(dir, 'scratch'), roots: [music], outputDir: out,
      preset: usbPreset(), concurrency: 1,
    });

    const ok = report.items.filter((i) => i.status === 'ok');
    assertEq(ok.length, 1, 'the readable file rendered');
    const failed = report.items.filter((i) => i.status === 'failed');
    assertEq(failed.length, 1, 'the unreadable file is reported as failed');
    assert(
      failed[0]!.message!.includes('scan'),
      `the failure is attributed to the scan stage (got ${JSON.stringify(failed[0]!.message)})`,
    );
    assert(failed[0]!.sourcePath.includes('Garbage'), 'the failed row names the offending file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** readdir that tolerates a missing directory. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Overwrite mode: convert a USB in place                              */
/* ------------------------------------------------------------------ */

/** Anything that looks like the staging file overwrite mode renders through. */
function stagingLeftovers(dir: string): string[] {
  return readdirSafe(dir).filter((f) => f.includes('.aus-tmp'));
}

test('INTEGRATION: overwrite converts each file in place and deletes the original', async () => {
  if (skipUnlessAvailable()) return;

  const music = scratch('overwrite-music');
  const unusedOut = scratch('overwrite-unused');
  try {
    const src = await makeTone(music, 'song.wav', { freq: 440, dur: 4 });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      concurrency: 1,
    });

    assertEq(report.items.length, 1, 'one source file, one row');
    assertEq(
      report.items[0]!.status,
      'ok',
      `the row must succeed: ${report.items[0]!.message ?? '(no message)'}`,
    );

    // The conversion lands where the source was, under the preset's extension.
    const produced = join(music, 'song.mp3');
    assert(!existsSync(src), 'the .wav must be gone once its MP3 replacement is in place');
    assert(existsSync(produced), 'the converted file must sit in the source folder');

    // It is a real conversion, not an empty placeholder.
    const info = await probe(bins!.ffprobe, produced, scratch('overwrite-probe'));
    assert(info.audio !== null, 'the produced file has an audio stream');
    assert(info.format.durationSec > 3, `the duration must survive, got ${info.format.durationSec}`);

    // outputDir plays no part in overwrite mode.
    assertEq(readdirSafe(unusedOut).length, 0, 'overwrite must not also write to outputDir');

    // And nothing was left mid-flight.
    assertEq(stagingLeftovers(music).length, 0, 'no staging file may survive a successful run');
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('INTEGRATION: overwrite reports the replaced path, not a staging path', async () => {
  if (skipUnlessAvailable()) return;

  const music = scratch('overwrite-path');
  try {
    await makeTone(music, 'track.wav', { freq: 440, dur: 3 });
    const produced = join(music, 'track.mp3');

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-path-work'),
      roots: [music],
      outputDir: scratch('overwrite-path-unused'),
      preset: usbPreset(),
      overwrite: true,
      concurrency: 1,
    });

    // The manifest the user may keep has to name files that exist afterwards.
    assertEq(report.items[0]!.outputPath, produced, 'the report names the file that now exists');
  } finally {
    rmSync(music, { recursive: true, force: true });
  }
});

test('INTEGRATION: overwrite leaves an unreadable source byte-identical', async () => {
  if (skipUnlessAvailable()) return;

  const music = scratch('overwrite-broken');
  try {
    const broken = join(music, 'broken.wav');
    const original = Buffer.from('these are not audio bytes, and they must survive');
    writeFileSync(broken, original);

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-broken-work'),
      roots: [music],
      outputDir: scratch('overwrite-broken-unused'),
      preset: usbPreset(),
      overwrite: true,
      concurrency: 1,
    });

    assertEq(report.items[0]!.status, 'failed', 'an unreadable source is reported, not converted');
    assert(
      readFileSync(broken).equals(original),
      'the original bytes must be untouched when nothing could be produced',
    );
    assertEq(stagingLeftovers(music).length, 0, 'a failed run must not leave a staging file behind');
  } finally {
    rmSync(music, { recursive: true, force: true });
  }
});

test('INTEGRATION: planBatch converts only the paths the caller selected', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('select');
  try {
    const music = join(dir, 'music');
    const out = join(dir, 'out');
    mkdirSync(music, { recursive: true });
    await makeTone(music, 'keep.wav', { freq: 440, dur: 4 });
    await makeTone(music, 'skip.wav', { freq: 880, dur: 4 });

    const scan = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(scan.entries.length, 2, 'two files scanned');

    const base = {
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: dir,
      roots: [music],
      outputDir: out,
      preset: usbPreset(),
    };
    const keepPath = scan.entries.find((e) => e.path.endsWith('keep.wav'))!.path;

    // This is the guarantee that makes an unticked row meaningful. Without it a UI
    // that lets the user leave a lossless original alone would overwrite it anyway,
    // because a scan of a folder returns every audio file in it.
    const unfiltered = await planBatch(scan.entries, base);
    assertEq(unfiltered.items.length, 2, 'without a selection, everything found is planned');

    const selected = await planBatch(scan.entries, { ...base, includePaths: [keepPath] });
    assertEq(selected.items.length, 1, 'with a selection, only the selected path is planned');
    assertEq(selected.items[0]!.sourcePath, keepPath, 'and it is the one that was selected');

    // Windows callers disagree about case, and a selection that silently misses is
    // worse than no selection: it reads as "nothing to do" instead of an error.
    const wrongCase = await planBatch(scan.entries, {
      ...base,
      includePaths: [keepPath.toUpperCase()],
    });
    assertEq(wrongCase.items.length, 1, 'the selection is matched case-insensitively');

    const nothing = await planBatch(scan.entries, {
      ...base,
      includePaths: [join(music, 'absent.wav')],
    });
    assertEq(nothing.items.length, 0, 'selecting a path that was not scanned plans nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Overwrite mode: the destination name, and what happens when the     */
/* device refuses to accept it                                         */
/* ------------------------------------------------------------------ */

test('INTEGRATION: overwrite refuses a damaged destination name and leaves the original intact', async () => {
  if (skipUnlessAvailable()) return;

  // The user's stick had a damaged FAT32 directory entry occupying a track's name.
  // `statSync` then throws a non-ENOENT error (`UNKNOWN: unknown error`, errno -4094)
  // and the rename failed with an errno that told nobody what to do. A directory with
  // the same name is the local stand-in for "that name is occupied by something that
  // is not a usable file": it makes `renameSync` fail, and it is not ENOENT.
  const music = scratch('overwrite-damaged');
  const unusedOut = scratch('overwrite-damaged-unused');
  try {
    const source = await makeTone(music, 'victim.wav', { freq: 440, dur: 3 });
    const targetName = join(music, 'victim.mp3');
    mkdirSync(targetName);
    const bytesBefore = readFileSync(source);
    const mtimeBefore = statSync(source).mtimeMs;

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-damaged-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      concurrency: 1,
    });

    const row = report.items[0]!;
    assertEq(row.status, 'failed', 'an unusable destination name must fail the row, not the file');
    const msg = row.message ?? '';
    assert(msg.includes('損毀'), `the message must say the name is damaged, got: ${msg}`);
    assert(
      msg.includes('磁碟檢查工具') && msg.includes('先在電腦上轉換'),
      `the message must tell the user what to do about it, got: ${msg}`,
    );
    assert(msg.includes('victim.mp3'), `the message must name the file, got: ${msg}`);
    // The device's own words are preserved whenever a syscall refused: on the real
    // stick `statSync` throws `UNKNOWN: unknown error` (errno -4094) for a damaged
    // FAT32 entry, and that text is what a bug report needs. A directory in the way is
    // refused before anything is attempted, so it explains the obstruction instead —
    // there is no errno to quote.
    assert(
      msg.includes('原始錯誤：') || msg.includes('同名的資料夾'),
      `the message must say what was actually wrong, got: ${msg}`,
    );
    assertEq(row.outputPath, null, 'a failed row must not claim a path it did not produce');

    // The one promise that matters: nothing about the original changed.
    assert(existsSync(source), 'the original must still exist');
    assert(
      readFileSync(source).equals(bytesBefore),
      'the original bytes must be untouched when its replacement could not be moved in',
    );
    assertEq(
      statSync(source).mtimeMs,
      mtimeBefore,
      'the original mtime must be untouched as well (a rewrite would move it)',
    );
    assert(statSync(targetName).isDirectory(), 'the occupying directory must not be deleted');

    // And the staged replacement is cleaned up rather than left on the stick.
    assertEq(stagingLeftovers(music).length, 0, 'a refused replacement must not leave a staging file');
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('INTEGRATION: in-place overwrite keeps the original names by default', async () => {
  if (skipUnlessAvailable()) return;

  // The regression this pins: a real batch renamed 123 of 199 files to
  // `{artist} - {title}` and two tracks that share a title became `X.mp3` and `X (2).mp3`.
  // Converting in place must not move a file at all — not the tags' idea of its name,
  // and certainly not a `(2)` suffix invented because two files disagree with it.
  const music = scratch('overwrite-keepnames');
  const unusedOut = scratch('overwrite-keepnames-unused');
  try {
    const first = '01 - Daft Punk - Around the World.wav';
    const second = '02 - Daft Punk - Around the World.flac';
    await makeTone(music, first, { freq: 440, dur: 3 });
    await makeTone(music, second, { freq: 880, dur: 3 });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-keepnames-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      // An explicit pattern must be ignored while the names are preserved: the point
      // of the default is that the user's own file names survive untouched.
      filenamePattern: '{artist} - {title}',
      concurrency: 1,
    });

    assertEq(report.items.length, 2, 'two sources, two rows');
    for (const row of report.items) {
      assertEq(
        row.status,
        'ok',
        `both conversions must succeed: ${row.message ?? '(no message)'}`,
      );
    }
    const produced = readdirSafe(music).filter((f) => f.endsWith('.mp3')).sort();
    assertEq(
      produced.join('|'),
      '01 - Daft Punk - Around the World.mp3|02 - Daft Punk - Around the World.mp3',
      'each file keeps its own name, with only the container extension following the preset',
    );
    assert(
      !readdirSafe(music).some((f) => f.includes('(2)')),
      'no (2) suffix may ever be invented by an in-place conversion',
    );
    assert(!existsSync(join(music, first)), 'the converted source is replaced, not duplicated');
    assert(!existsSync(join(music, second)), 'the converted source is replaced, not duplicated');
    assertEq(stagingLeftovers(music).length, 0, 'no staging file may survive a successful run');
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('INTEGRATION: preserveNames:false still re-organises in-place by the tag pattern', async () => {
  if (skipUnlessAvailable()) return;

  const music = scratch('overwrite-rename');
  const unusedOut = scratch('overwrite-rename-unused');
  try {
    const source = await makeTone(music, '01 - Daft Punk - Around the World.wav', {
      freq: 440,
      dur: 3,
    });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-rename-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      preserveNames: false,
      concurrency: 1,
    });

    const row = report.items[0]!;
    assertEq(row.status, 'ok', `the row must succeed: ${row.message ?? '(no message)'}`);
    assertEq(
      row.outputPath,
      join(music, 'Daft Punk - Around the World.mp3'),
      'an explicit false restores tag-based naming',
    );
    assert(existsSync(join(music, 'Daft Punk - Around the World.mp3')), 'the renamed file exists');
    assert(!existsSync(source), 'the source moved to its new name');
    assertEq(stagingLeftovers(music).length, 0, 'no staging file may survive a successful run');
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('INTEGRATION: in-place naming keeps a source name that already has the preset extension', async () => {
  if (skipUnlessAvailable()) return;

  // "Preserve the name" has to mean the bytes of the name, not a normalisation of
  // them: a file already called `TRACK.MP3` must come out as `TRACK.MP3`, not
  // `TRACK.mp3` and not `TRACK (2).mp3`.
  const music = scratch('overwrite-case');
  const unusedOut = scratch('overwrite-case-unused');
  try {
    await makeTone(music, 'TRACK.MP3', { freq: 440, dur: 3 });

    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-case-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      concurrency: 1,
    });

    const row = report.items[0]!;
    assertEq(row.status, 'ok', `the row must succeed: ${row.message ?? '(no message)'}`);
    assertEq(row.outputPath, join(music, 'TRACK.MP3'), 'the name is preserved exactly');
    // Filtered to the audio files on purpose: `makeTone` runs ffmpeg with the folder as
    // its cwd, so its own report log is a by-product of this test's setup, not of the
    // batch (the engine runs ffmpeg inside its scratch directory and removes it).
    const mp3s = readdirSafe(music).filter((f) => f.toLowerCase().endsWith('.mp3'));
    assertEq(mp3s.join('|'), 'TRACK.MP3', 'one file, under its original name');
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('INTEGRATION: an in-place conversion never claims a name another file already uses', async () => {
  if (skipUnlessAvailable()) return;

  // With names preserved, `song.flac` and an existing `song.mp3` in the same folder
  // both want `song.mp3`. Renaming over it would destroy a file that was never part of
  // this batch, and the flac would be deleted afterwards as a "replaced" source. That
  // is silent data loss, so the collision is refused and the row is skipped visibly.
  const music = scratch('overwrite-clash');
  const unusedOut = scratch('overwrite-clash-unused');
  try {
    const existing = await makeTone(music, 'song.mp3', { freq: 440, dur: 2 });
    const loser = await makeTone(music, 'song.flac', { freq: 880, dur: 2 });
    const existingBytes = readFileSync(existing);

    // Only the .flac is selected, so the .mp3 is not part of this batch: whatever
    // happens to the .flac, the .mp3 must come out of the run untouched.
    const report = await runBatch({
      ffmpeg: bins!.ffmpeg,
      ffprobe: bins!.ffprobe,
      scratch: scratch('overwrite-clash-work'),
      roots: [music],
      outputDir: unusedOut,
      preset: usbPreset(),
      overwrite: true,
      includePaths: [loser],
      concurrency: 1,
    });

    const row = report.items[0]!;
    assertEq(row.status, 'skipped', 'the track that would clobber a file is skipped, not converted');
    assert(
      (row.message ?? '').includes('target name is taken by an existing file'),
      `the skip must say why, got: ${row.message ?? '(no message)'}`,
    );
    assert(existsSync(loser), 'the skipped source must survive untouched');
    assert(
      readFileSync(existing).equals(existingBytes),
      'a file outside the batch must not be replaced by a track that merely wants its name',
    );
    assertEq(stagingLeftovers(music).length, 0, 'a skipped row renders nothing at all');

    // Two tracks in one batch can also collide on a name that does not exist yet:
    // `song.wav` and `song.flac` both convert to `song.mp3`. Exactly one may take it,
    // and the other must be skipped visibly rather than convert over the first.
    const pair = scratch('overwrite-clash-pair');
    try {
      await makeTone(pair, 'song.flac', { freq: 440, dur: 2 });
      await makeTone(pair, 'song.wav', { freq: 880, dur: 2 });
      const scan = await scanLibrary({ roots: [pair], ffprobe: bins!.ffprobe, scratch: pair });
      assertEq(scan.entries.length, 2, 'both sources scanned');
      const plan = await planBatch(scan.entries, {
        ffmpeg: bins!.ffmpeg,
        ffprobe: bins!.ffprobe,
        scratch: pair,
        roots: [pair],
        outputDir: scratch('overwrite-clash-pair-out'),
        preset: usbPreset(),
        overwrite: true,
      });
      const planned = plan.items.filter((i) => i.skipped === undefined);
      const claimed = plan.items.filter((i) => (i.skipped ?? '').includes('already claimed'));
      assertEq(planned.length, 1, 'one target, one track: exactly one may take the name');
      assertEq(claimed.length, 1, 'the other is skipped, visibly, instead of overwriting it');
      assertEq(planned[0]!.outputPath, join(pair, 'song.mp3'), 'the winner writes the contested name');
      assertEq(
        readdirSafe(pair).filter((f) => f.endsWith('.mp3')).length,
        0,
        'planning writes nothing: this is decided before any render',
      );
    } finally {
      rmSync(pair, { recursive: true, force: true });
    }
  } finally {
    rmSync(music, { recursive: true, force: true });
    rmSync(unusedOut, { recursive: true, force: true });
  }
});

test('inPlaceName and inPlaceTargetProblem: the naming rule and the non-ENOENT path', () => {
  // Pure units, no ffmpeg: they pin the two decisions that are easy to get wrong and
  // that the integration tests above can only reach on a real volume.
  assertEq(
    inPlaceName(join('m', 'song.wav'), '.mp3'),
    'song.mp3',
    'a container change follows the preset extension',
  );
  assertEq(
    inPlaceName(join('m', 'TRACK.MP3'), '.mp3'),
    'TRACK.MP3',
    'an already-correct extension is kept byte for byte, casing included',
  );
  assertEq(
    inPlaceName(join('m', 'no-extension'), '.mp3'),
    'no-extension.mp3',
    'a name with no extension simply gains one',
  );

  // A missing target is the normal case and must not be reported as damage.
  const dir = scratch('inplace-unit');
  try {
    assertEq(
      inPlaceTargetProblem(join(dir, 'absent.mp3'), join(dir, 'absent.wav')),
      null,
      'ENOENT means "nothing in the way", not damage',
    );
    assertEq(
      inPlaceTargetProblem(join(dir, 'same.wav'), join(dir, 'same.wav')),
      null,
      'the file being replaced is not an obstruction',
    );

    // The only locally synthesizable non-ENOENT stat failure: a NUL byte is not a
    // legal path. Whatever a device reports instead — the user's stick says
    // `UNKNOWN: unknown error` — the rule is "anything that is not ENOENT".
    const damaged = inPlaceTargetProblem('bad\0name.mp3', join(dir, 'src.wav'));
    assert(damaged !== null, 'a non-ENOENT stat failure must be reported as a damaged name');
    assert(
      damaged!.includes('損毀') && damaged!.includes('原始錯誤：'),
      `the message must be actionable and keep the original text, got: ${damaged}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
