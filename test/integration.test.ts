/**
 * Integration tests: these actually run ffmpeg.
 *
 * They are the only tests that prove the compiled argv is valid ffmpeg syntax and
 * that a real file comes out matching the USB preset. Each test creates its own
 * scratch directory and removes it afterwards, so a failure leaves nothing behind.
 *
 * Skipped automatically (with a printed notice) when ffmpeg cannot be located, so
 * the unit suites still run on a machine without it.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertClose, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { probe } from '../src/core/probe.ts';
import * as EDL from '../src/core/edl.ts';
import { render, verify } from '../src/core/render.ts';
import type { Timeline } from '../src/core/types.ts';

let bins: BinPaths | null = null;
let unavailable = '';
try {
  bins = findBinaries();
} catch (err) {
  unavailable = (err as Error).message;
}

const ROOT = join(tmpdir(), 'aus-integration');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Generate a deterministic test tone. Returns the file path. */
async function makeTone(
  dir: string,
  name: string,
  opts: { freq?: number; dur?: number; rate?: number; channels?: number } = {},
): Promise<string> {
  const freq = opts.freq ?? 440;
  const dur = opts.dur ?? 5;
  const rate = opts.rate ?? 48000;
  const channels = opts.channels ?? 2;
  const out = join(dir, name);

  const r = await runFfmpeg(
    bins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=${rate}`,
      '-ac', String(channels),
      out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) {
    throw new Error(`could not create test tone ${name}: exit ${r.code}`);
  }
  return out;
}

function skipUnlessAvailable(): boolean {
  if (!bins) {
    process.stdout.write(`  (skipping: ${unavailable.split('\n')[0]})\n`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */

test('doctor: ffmpeg and ffprobe both run', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('doctor');
  try {
    const ff = await runFfmpeg(bins!.ffmpeg, ['-version'], { cwd: dir });
    const fp = await runFfmpeg(bins!.ffprobe, ['-version'], { cwd: dir });
    assertEq(ff.code, 0, 'ffmpeg -version succeeds');
    assertEq(fp.code, 0, 'ffprobe -version succeeds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe reads a generated WAV accurately', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('probe');
  try {
    const wav = await makeTone(dir, 'tone.wav', { freq: 440, dur: 5, rate: 48000, channels: 2 });
    const info = await probe(bins!.ffprobe, wav, dir);

    assert(info.audio !== null, 'has an audio stream');
    assertEq(info.audio!.sampleRate, 48000, 'sample rate');
    assertEq(info.audio!.channels, 2, 'channels');
    assertEq(info.audio!.codecName, 'pcm_s16le', 'codec');
    assertClose(info.format.durationSec, 5, 0.05, 'duration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render produces an MP3 matching the USB preset and verify accepts it', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('render-usb');
  try {
    const src = await makeTone(dir, 'src.wav', { freq: 440, dur: 6, rate: 48000, channels: 2 });
    const out = join(dir, 'out.mp3');

    const preset = EDL.usbPreset();
    const timeline: Timeline = EDL.makeTimeline(
      [EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 6 })],
      preset.sampleRate,
      preset.channels,
    );

    const result = await render({
      bins: bins!,
      scratchRoot: ROOT,
      timeline,
      preset,
      sourcePaths: { src0: src },
      outputPath: out,
    });

    assert(result.ok, `render succeeded: ${result.error ?? ''}`);
    assert(existsSync(out), 'output file exists');
    assert(statSync(out).size > 1000, 'output is not empty');
    assert(result.measured !== null, 'loudness was measured');

    const v = await verify({
      bins: bins!,
      scratchRoot: ROOT,
      file: out,
      preset,
      expectedDurationSec: 6,
      expectLoudness: true,
    });

    assert(v.ok, `verify passed: ${v.problems.join('; ')}`);
    assertEq(v.info.audio!.codecName, 'mp3', 'output codec');
    assertEq(v.info.audio!.sampleRate, 44100, 'output sample rate');
    assertEq(v.info.audio!.channels, 2, 'output channels');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two-pass loudness actually lands near the -14 LUFS target', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('loudness');
  try {
    // A quiet source: single-pass normalization would have to move it a long way,
    // which is exactly the case where two-pass behaviour is observable.
    const src = await makeTone(dir, 'quiet.wav', { freq: 220, dur: 8, rate: 44100, channels: 2 });
    const quiet = join(dir, 'quiet-10db.wav');

    const att = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-af', 'volume=-20dB', quiet],
      { cwd: dir },
    );
    assertEq(att.code, 0, 'attenuated the test tone');

    const preset = EDL.usbPreset();
    const timeline: Timeline = EDL.makeTimeline(
      [EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 8 })],
      preset.sampleRate,
      preset.channels,
    );
    const out = join(dir, 'normalized.mp3');

    const result = await render({
      bins: bins!,
      scratchRoot: ROOT,
      timeline,
      preset,
      sourcePaths: { src0: quiet },
      outputPath: out,
    });
    assert(result.ok, `render succeeded: ${result.error ?? ''}`);

    const v = await verify({
      bins: bins!,
      scratchRoot: ROOT,
      file: out,
      preset,
      expectLoudness: true,
    });
    assert(v.measured !== null, 'measured the output loudness');
    assertClose(v.measured!.inputI, -14, 1.5, 'integrated loudness near -14 LUFS');
    assert(v.measured!.inputTp <= -1.0 + 1.0, `true peak ${v.measured!.inputTp} within ceiling`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete + silence edits change the rendered duration as expected', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('edit-duration');
  try {
    const src = await makeTone(dir, 'src.wav', { freq: 330, dur: 10, rate: 44100, channels: 2 });
    const preset = { ...EDL.usbPreset(), loudness: { ...EDL.usbPreset().loudness, enabled: false } };

    let timeline: Timeline = EDL.makeTimeline(
      [EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 10 })],
      preset.sampleRate,
      preset.channels,
    );
    timeline = EDL.deleteRange(timeline, 2, 4); // -2s
    timeline = EDL.silenceRange(timeline, 0, 1); // length preserved

    const out = join(dir, 'edited.mp3');
    const result = await render({
      bins: bins!,
      scratchRoot: ROOT,
      timeline,
      preset,
      sourcePaths: { src0: src },
      outputPath: out,
    });
    assert(result.ok, `render succeeded: ${result.error ?? ''}`);
    assertClose(result.durationSec, 8, 1e-6, 'EDL duration is 8s');

    const v = await verify({
      bins: bins!,
      scratchRoot: ROOT,
      file: out,
      preset,
      expectedDurationSec: 8,
    });
    assert(v.ok, `duration verified: ${v.problems.join('; ')}`);
    assertClose(v.info.format.durationSec, 8, 0.35, 'rendered duration matches the EDL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effects compile into a valid filter graph that ffmpeg accepts', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('effects');
  try {
    const src = await makeTone(dir, 'src.wav', { freq: 440, dur: 5, rate: 44100, channels: 2 });
    const preset = { ...EDL.usbPreset(), loudness: { ...EDL.usbPreset().loudness, enabled: false } };

    const clip = EDL.makeClip({
      sourceId: 'src0',
      srcIn: 1,
      srcOut: 4,
      gainDb: -3,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      effects: [
        { id: 'e1', enabled: true, type: 'denoise', strength: 'gentle' },
        { id: 'e2', enabled: true, type: 'highpass', freq: 80 },
        { id: 'e3', enabled: true, type: 'eq', bands: [{ freq: 1000, gainDb: 2, widthOctaves: 1 }] },
        { id: 'e4', enabled: true, type: 'echo', delayMs: 120, decay: 0.3 },
        { id: 'e5', enabled: true, type: 'compressor', thresholdDb: -18, ratio: 3 },
      ],
    });

    const out = join(dir, 'fx.mp3');
    const result = await render({
      bins: bins!,
      scratchRoot: ROOT,
      timeline: EDL.makeTimeline([clip], preset.sampleRate, preset.channels),
      preset,
      sourcePaths: { src0: src },
      outputPath: out,
    });

    assert(result.ok, `effects render succeeded: ${result.error ?? ''}`);
    assertClose(result.durationSec, 3, 1e-6, 'trimmed to 3s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify rejects a file whose properties do not match the preset', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('verify-negative');
  try {
    // A 22.05 kHz mono WAV cannot satisfy the 44.1 kHz stereo MP3 preset.
    const src = await makeTone(dir, 'odd.wav', { freq: 440, dur: 3, rate: 22050, channels: 1 });
    const v = await verify({
      bins: bins!,
      scratchRoot: ROOT,
      file: src,
      preset: EDL.usbPreset(),
    });
    assert(!v.ok, 'verification failed as expected');
    assert(v.problems.length > 0, 'problems are reported');
    const text = v.problems.join(' ');
    assert(text.includes('sample rate') || text.includes('channel'), `meaningful problem: ${text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batch of three files renders independently and in parallel', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('batch');
  try {
    const preset = { ...EDL.usbPreset(), loudness: { ...EDL.usbPreset().loudness, enabled: false } };
    const sources = await Promise.all([
      makeTone(dir, 'a.wav', { freq: 220, dur: 3 }),
      makeTone(dir, 'b.wav', { freq: 440, dur: 4 }),
      makeTone(dir, 'c.wav', { freq: 880, dur: 2 }),
    ]);

    const results = await Promise.all(
      sources.map((src, i) => {
        const timeline: Timeline = EDL.makeTimeline(
          [EDL.makeClip({ sourceId: 's', srcIn: 0, srcOut: [3, 4, 2][i]! })],
          preset.sampleRate,
          preset.channels,
        );
        return render({
          bins: bins!,
          scratchRoot: ROOT,
          timeline,
          preset,
          sourcePaths: { s: src },
          outputPath: join(dir, `out${i}.mp3`),
        });
      }),
    );

    for (let i = 0; i < results.length; i += 1) {
      assert(results[i]!.ok, `batch item ${i} succeeded: ${results[i]!.error ?? ''}`);
      assert(existsSync(results[i]!.outputPath), `batch item ${i} produced a file`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
