/**
 * Tests for the DeepFilterNet external-process stage and its guard rails.
 *
 * Two kinds of test live here:
 *
 * 1. UNIT (always run): discovery, availability, policy wording, the
 *    never-throws contract, and the safety net that keeps AI denoise out of the
 *    batch pipeline.
 * 2. INTEGRATION (skip when the binaries are absent): generate a synthetic
 *    "music-like" signal, run it through DeepFilterNet, and *measure* how much of
 *    the music it removes. These numbers are the evidence behind the policy; they
 *    are asserted loosely (the exact figure is an ffmpeg version detail) but the
 *    printed values are the point.
 *
 * Everything skips rather than fails when ffmpeg or deep-filter.exe is missing, so
 * a machine without the 27 MB model still gets a fully green unit suite.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import { APP_ROOT_ENV } from '../src/core/approot.ts';
import { probe } from '../src/core/probe.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { compile } from '../src/core/compiler.ts';
import * as EDL from '../src/core/edl.ts';
import type { Timeline } from '../src/core/types.ts';
import {
  BATCH_DENOISE_DEFAULT,
  DEEP_FILTER_ENV,
  assertNotInBatchPipeline,
  denoiseFile,
  describeDenoisePolicy,
  findAiDenoiseTraces,
  findDeepFilter,
  isAvailable,
} from '../src/core/denoise.ts';

/* ------------------------------------------------------------------ */
/* Environment probes                                                  */
/* ------------------------------------------------------------------ */

let bins: BinPaths | null = null;
try {
  bins = findBinaries();
} catch {
  bins = null;
}

/** Locate a real deep-filter.exe for the integration tests. */
const dfnPath = findDeepFilter();

const ROOT = join(tmpdir(), 'aus-denoise');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function skipNoFfmpeg(): boolean {
  if (!bins) {
    process.stdout.write('  (skipping: ffmpeg not found)\n');
    return true;
  }
  return false;
}

function skipNoDfn(): boolean {
  if (!dfnPath) {
    process.stdout.write('  (skipping: deep-filter.exe not found; run node tools/fetch-deep-filter.mjs)\n');
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Unit: discovery and availability                                    */
/* ------------------------------------------------------------------ */

test('findDeepFilter returns null for a path that does not exist', () => {
  const bogus = join(ROOT, 'definitely-not-here', 'deep-filter.exe');
  // The repo defaults are skipped so this stays a true "nothing found" case even
  // on a machine where tools/bin/deep-filter.exe has been downloaded.
  const found = findDeepFilter(bogus, { skipRepoDefaults: true, searchPath: '' });
  assertEq(found, null, 'a missing explicit path yields null');
});

test('findDeepFilter never throws, whatever it is handed', () => {
  const opts = { skipRepoDefaults: true, searchPath: '' } as const;
  // The contract is "return null when not found", not "throw".
  assertEq(findDeepFilter('', opts), null, 'empty explicit path');
  assertEq(findDeepFilter(join(ROOT, 'no', 'such', 'dir'), opts), null, 'bogus nested path');
  assertEq(findDeepFilter(undefined, opts), null, 'nothing to find');
});

test('findDeepFilter finds a binary on the search path it is given', () => {
  const dir = scratch('dfn-searchpath');
  try {
    const fake = join(dir, 'deep-filter.exe');
    writeFileSync(fake, 'stub');
    assertEq(
      findDeepFilter(undefined, { skipRepoDefaults: true, searchPath: dir }),
      fake,
      'a PATH entry is searched',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findDeepFilter looks beside the installed app, not just in tools/', () => {
  // A packaged build ships `bin/deep-filter.exe` next to the executable, while a
  // source checkout keeps it under `tools/bin`. Missing the app-local location
  // made the packaged exe report available:false even with the binary right
  // there, so this pins the packaged layout.
  const prev = process.env[APP_ROOT_ENV];
  const root = scratch('dfn-approot');
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, 'deep-filter.exe');
    writeFileSync(fake, 'stub');
    process.env[APP_ROOT_ENV] = root;
    assertEq(findDeepFilter(), fake, 'bin/ beside the app root is searched first');
  } finally {
    if (prev === undefined) delete process.env[APP_ROOT_ENV];
    else process.env[APP_ROOT_ENV] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('findDeepFilter honours the AUS_DEEP_FILTER environment override', () => {
  const prev = process.env[DEEP_FILTER_ENV];
  const dir = scratch('dfn-env');
  try {
    const fake = join(dir, 'deep-filter.exe');
    // A non-empty file is enough for discovery (availability is checked apart).
    writeFileSync(fake, 'stub');
    process.env[DEEP_FILTER_ENV] = fake;
    assertEq(findDeepFilter(), fake, 'env override is used');

    // An explicit path must still win over the environment.
    const other = join(dir, 'explicit.exe');
    writeFileSync(other, 'stub');
    assertEq(findDeepFilter(other), other, 'explicit path beats the environment');
  } finally {
    if (prev === undefined) delete process.env[DEEP_FILTER_ENV];
    else process.env[DEEP_FILTER_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isAvailable rejects missing, empty and directory paths', () => {
  const dir = scratch('dfn-avail');
  try {
    assertEq(isAvailable({ exePath: join(dir, 'nope.exe') }), false, 'missing file is unavailable');

    const empty = join(dir, 'empty.exe');
    writeFileSync(empty, '');
    assertEq(isAvailable({ exePath: empty }), false, 'zero-byte file is unavailable');

    assertEq(isAvailable({ exePath: dir }), false, 'a directory is unavailable');

    const real = join(dir, 'real.exe');
    writeFileSync(real, 'MZ');
    assertEq(isAvailable({ exePath: real }), true, 'a non-empty file is available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Unit: denoiseFile never throws                                      */
/* ------------------------------------------------------------------ */

test('denoiseFile returns {ok:false} (does not throw) when the exe is missing', async () => {
  const dir = scratch('dfn-missing-exe');
  try {
    const input = join(dir, 'in.wav');
    writeFileSync(input, 'not really audio');

    const r = await denoiseFile(
      { exePath: join(dir, 'no-such-deep-filter.exe') },
      { ffmpeg: bins?.ffmpeg ?? 'ffmpeg', inputPath: input, outputPath: join(dir, 'out.wav'), scratch: dir },
    );

    assertEq(r.ok, false, 'reports failure');
    assertEq(r.outputPath, null, 'no output path on failure');
    assert(typeof r.message === 'string' && r.message.length > 0, 'carries a human-readable message');
    assert(/not available/i.test(r.message!), `message explains availability: ${r.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denoiseFile returns {ok:false} for a missing input file', async () => {
  if (skipNoDfn()) return;
  const dir = scratch('dfn-missing-input');
  try {
    const r = await denoiseFile(
      { exePath: dfnPath! },
      {
        ffmpeg: bins!.ffmpeg,
        inputPath: join(dir, 'does-not-exist.wav'),
        outputPath: join(dir, 'out.wav'),
        scratch: dir,
      },
    );
    assertEq(r.ok, false, 'reports failure');
    assertEq(r.outputPath, null, 'no output path');
    assert(/not found/i.test(r.message!), `message names the missing input: ${r.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denoiseFile returns {ok:false} when the source is not decodable audio', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;
  const dir = scratch('dfn-bad-audio');
  try {
    const bogus = join(dir, 'garbage.wav');
    writeFileSync(bogus, 'this is not a wave file');

    const r = await denoiseFile(
      { exePath: dfnPath! },
      { ffmpeg: bins!.ffmpeg, inputPath: bogus, outputPath: join(dir, 'out.wav'), scratch: dir },
    );
    assertEq(r.ok, false, 'reports failure instead of throwing');
    assertEq(r.outputPath, null, 'no output path');
    assert(typeof r.message === 'string' && r.message.length > 0, 'explains the failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Unit: the anti-misuse guard                                         */
/* ------------------------------------------------------------------ */

test('findAiDenoiseTraces detects every AI-denoise spelling', () => {
  assertEq(findAiDenoiseTraces('arnndn=m=rnnn/model.rnnn'), ['arnndn', '.rnnn'], 'arnndn + model file');
  assertEq(findAiDenoiseTraces('adeep-filter=1'), ['deep-filter'], 'deep-filter behind a prefix');
  assertEq(findAiDenoiseTraces('deep_filter_mono'), ['deep-filter'], 'underscored LADSPA name');
  // "DeepFilterNet" contains "DeepFilter" as well, so both tokens are reported;
  // over-reporting is the safe direction for a guard.
  assertEq(
    findAiDenoiseTraces('DeepFilterNet'),
    ['deep-filter', 'deepfilternet'],
    'product name, any case',
  );
  assertEq(findAiDenoiseTraces('aformat=sample_fmts=fltp'), [], 'ordinary filters are clean');
  assertEq(findAiDenoiseTraces(''), [], 'an empty graph is clean');
});

test('assertNotInBatchPipeline rejects a graph containing AI denoise', () => {
  let threw = false;
  try {
    assertNotInBatchPipeline('[0:a]arnndn=m=model.rnnn[out]');
  } catch (err) {
    threw = true;
    assert(/not allowed in the batch pipeline/i.test((err as Error).message), 'explains the rule');
    assert(/27\.9 dB/.test((err as Error).message), 'cites the measured damage figure');
  }
  assert(threw, 'the guard threw on an AI filter graph');
});

test('assertNotInBatchPipeline accepts the batch default chain', () => {
  assertNotInBatchPipeline(`[0:a]${BATCH_DENOISE_DEFAULT.declick},${BATCH_DENOISE_DEFAULT.afftdn},anull[out]`);
  assertNotInBatchPipeline('afftdn=nr=12:nf=-35:tn=1,adeclick=threshold=2,equalizer=f=1000:g=2');
});

test('describeDenoisePolicy names the batch default and keeps DFN out of it', () => {
  const p = describeDenoisePolicy();

  assert(/afftdn/.test(p.batchDefault), `batch default is the gentle afftdn chain: ${p.batchDefault}`);
  assert(/adeclick/.test(p.batchDefault), `batch default includes adeclick: ${p.batchDefault}`);
  assertEq(findAiDenoiseTraces(p.batchDefault), [], 'batch default mentions no AI denoiser');

  assert(/opt-in/i.test(p.singleTrackOnly), `DFN is described as an opt-in: ${p.singleTrackOnly}`);
  assert(/single|one|per-track/i.test(p.singleTrackOnly), 'and as per-track only');

  // The reason must carry the measured evidence, not just an opinion.
  assert(/-26\.9/.test(p.reason) && /-84\.3/.test(p.reason), `reason cites the measured dB figures: ${p.reason}`);
  assert(/57 dB/.test(p.reason), 'reason cites the 57 dB signal loss');
  assert(/speech/i.test(p.reason), 'reason explains that it is a speech model');
});

/* ------------------------------------------------------------------ */
/* The safety net: the compiled batch chain must never contain AI denoise  */
/* ------------------------------------------------------------------ */

function batchGraph(effects: Parameters<typeof EDL.makeClip>[0]['effects']): string {
  const preset = EDL.usbPreset();
  const timeline: Timeline = EDL.makeTimeline(
    [EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 5, effects: effects ?? [] })],
    preset.sampleRate,
    preset.channels,
  );
  return compile({
    timeline,
    preset,
    sourcePaths: { src0: 'C:\\music\\song.mp3' },
    outputPath: 'C:\\out\\song.mp3',
  }).filterComplex;
}

test('a compiled USB-preset chain with no effects contains no AI denoise', () => {
  const graph = batchGraph([]);
  assertEq(findAiDenoiseTraces(graph), [], `clean graph: ${graph}`);
  assertNotInBatchPipeline(graph);
});

test('a compiled USB-preset chain with the gentle denoise effect contains no AI denoise', () => {
  // This is the exact default the batch pipeline uses: `denoise: 'gentle'`.
  const graph = batchGraph([{ id: 'e1', enabled: true, type: 'denoise', strength: 'gentle' }]);
  assert(/afftdn/.test(graph), `uses afftdn: ${graph}`);
  assertEq(findAiDenoiseTraces(graph), [], 'no AI denoise trace');
  assertNotInBatchPipeline(graph);
});

test('no denoise strength can pull an AI denoiser into the compiled chain', () => {
  for (const strength of ['gentle', 'moderate', 'strong'] as const) {
    const graph = batchGraph([{ id: 'e1', enabled: true, type: 'denoise', strength }]);
    assertEq(findAiDenoiseTraces(graph), [], `strength ${strength} stays ffmpeg-native`);
    assert(/afftdn/.test(graph), `strength ${strength} uses afftdn`);
  }
});

test('the whole USB preset effect catalogue compiles without AI denoise', () => {
  // Every effect type at once: a broad net for a future effect that smuggles DFN in.
  const graph = batchGraph([
    { id: 'e1', enabled: true, type: 'denoise', strength: 'strong' },
    { id: 'e2', enabled: true, type: 'declick', threshold: 2 },
    { id: 'e3', enabled: true, type: 'declip' },
    { id: 'e4', enabled: true, type: 'highpass', freq: 80 },
    { id: 'e5', enabled: true, type: 'lowpass', freq: 16000 },
    { id: 'e6', enabled: true, type: 'eq', bands: [{ freq: 1000, gainDb: 2, widthOctaves: 1 }] },
    { id: 'e7', enabled: true, type: 'compressor', thresholdDb: -18, ratio: 3 },
    { id: 'e8', enabled: true, type: 'limiter', limitDb: -1 },
    { id: 'e9', enabled: true, type: 'echo', delayMs: 100, decay: 0.3 },
    { id: 'e10', enabled: true, type: 'gain', gainDb: 2 },
    { id: 'e11', enabled: true, type: 'speed', factor: 1.1 },
    { id: 'e12', enabled: true, type: 'normalize', targetPeakDb: -1 },
  ]);
  assertEq(findAiDenoiseTraces(graph), [], `no AI trace in the full catalogue: ${graph}`);
  assertNotInBatchPipeline(graph);
});

test('the batch denoise default is ffmpeg-native, not DeepFilterNet', () => {
  assert(/afftdn/.test(BATCH_DENOISE_DEFAULT.afftdn), 'default uses afftdn');
  assert(/nr=6/.test(BATCH_DENOISE_DEFAULT.afftdn), 'default is the gentle setting');
  assert(/adeclick/.test(BATCH_DENOISE_DEFAULT.declick), 'default uses adeclick');
  assertEq(findAiDenoiseTraces(JSON.stringify(BATCH_DENOISE_DEFAULT)), [], 'no AI token in the default');
});

test('the safety net catches AI denoise injected into a REAL compiled graph', () => {
  // Proves the guard has teeth on genuine compiler output, not just on a
  // hand-written string: take the real USB-preset graph and splice DFN in.
  const clean = batchGraph([{ id: 'e1', enabled: true, type: 'denoise', strength: 'gentle' }]);
  assertNotInBatchPipeline(clean); // baseline: the real graph is clean

  const mutated = clean.replace('afftdn', 'arnndn=m=model.rnnn,afftdn');
  assert(mutated !== clean, 'the mutation actually changed the graph');
  let threw = false;
  try {
    assertNotInBatchPipeline(mutated);
  } catch {
    threw = true;
  }
  assert(threw, 'the guard rejected the mutated real graph');
});

test('the safety net catches a DeepFilterNet stage spliced into a real graph', () => {
  const clean = batchGraph([{ id: 'e1', enabled: true, type: 'denoise', strength: 'gentle' }]);
  assert(clean.includes('afftdn'), 'the gentle chain really contains afftdn to splice against');
  for (const ai of ['deep_filter_mono', 'deep-filter=1', 'deepfilternet']) {
    const injected = clean.replace('afftdn', `${ai},afftdn`);
    assert(injected !== clean, `the ${ai} mutation actually changed the graph`);
    let threw = false;
    try {
      assertNotInBatchPipeline(injected);
    } catch {
      threw = true;
    }
    assert(threw, `the guard rejected ${ai}`);
  }
});

test('a real denoised render never writes an AI denoiser into the preset', () => {
  // Guard against a future ExportPreset gaining a `deepFilter` flag: the preset
  // object itself must stay free of AI-denoise instructions.
  const preset = EDL.usbPreset();
  assertEq(findAiDenoiseTraces(JSON.stringify(preset)), [], 'preset JSON is AI-free');
  assertEq(preset.denoise, 'gentle', 'preset asks for the gentle ffmpeg denoise');
});

/* ------------------------------------------------------------------ */
/* Integration: measure what DeepFilterNet does to music                  */
/* ------------------------------------------------------------------ */

/**
 * Measure `mean_volume` of a file through an ffmpeg filter, in dB.
 *
 * Each call gets its OWN directory: ffmpeg's `-report` log is named with
 * one-second granularity, so two runs sharing a directory within the same second
 * would collide and the second would read no fresh log at all (`report === null`,
 * which silently looks like "no measurement").
 */
let measureSeq = 0;
async function meanVolume(file: string, filter: string, parentDir: string): Promise<number | null> {
  measureSeq += 1;
  const dir = join(parentDir, `m${String(measureSeq).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  const r = await runFfmpeg(
    bins!.ffmpeg,
    ['-hide_banner', '-y', '-i', file, '-af', `${filter},volumedetect`, '-f', 'null', '-'],
    { cwd: dir },
  );
  const hits = [...(r.report ?? '').matchAll(/mean_volume:\s*(-?[\d.]+) dB/g)].map((m) => Number(m[1]));
  return hits.length > 0 ? hits[hits.length - 1]! : null;
}

async function makeMusicLike(dir: string, name: string): Promise<string> {
  const out = join(dir, name);
  const r = await runFfmpeg(
    bins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000',
      '-f', 'lavfi', '-i', 'anoisesrc=d=10:c=white:a=0.05:r=48000',
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0,aformat=sample_fmts=s16:channel_layouts=mono',
      '-ac', '1', out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`could not synthesise the test signal (exit ${r.code})`);
  return out;
}

test('MEASURED: DeepFilterNet destroys a music-like signal (440Hz + noise)', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;

  const dir = scratch('dfn-measure');
  try {
    // One scratch directory per ffmpeg call, for the -report naming reason above.
    const mDir = join(dir, 'measure');
    mkdirSync(mDir, { recursive: true });

    const src = await makeMusicLike(dir, 'music-like.wav');

    const inFull = await meanVolume(src, 'anull', mDir);
    const inTone = await meanVolume(src, 'bandpass=f=440:width_type=h:w=40', mDir);
    const inNoise = await meanVolume(src, 'highpass=f=4000', mDir);

    const r = await denoiseFile(
      { exePath: dfnPath! },
      {
        ffmpeg: bins!.ffmpeg,
        inputPath: src,
        outputPath: join(dir, 'denoised.wav'),
        scratch: dir,
      },
    );
    assert(r.ok, `denoiseFile succeeded: ${r.message ?? ''}`);
    assert(existsSync(r.outputPath!), 'denoised file exists');

    const outFull = await meanVolume(r.outputPath!, 'anull', mDir);
    const outTone = await meanVolume(r.outputPath!, 'bandpass=f=440:width_type=h:w=40', mDir);
    const outNoise = await meanVolume(r.outputPath!, 'highpass=f=4000', mDir);

    assert(inFull !== null && outFull !== null, 'measured full-band levels');
    assert(inTone !== null && outTone !== null, 'measured the 440 Hz band');
    assert(inNoise !== null && outNoise !== null, 'measured the noise band');

    const toneLoss = inTone! - outTone!;
    const noiseLoss = inNoise! - outNoise!;

    // Recorded in tools/README.md as the evidence for the policy. The exact
    // figures are ffmpeg/DFN build details; what must hold is the *shape*: the
    // music is attenuated severely, not merely cleaned up.
    process.stdout.write(
      `       music-like signal: full ${inFull!.toFixed(1)} -> ${outFull!.toFixed(1)} dB; ` +
        `440Hz ${inTone!.toFixed(1)} -> ${outTone!.toFixed(1)} dB (lost ${toneLoss.toFixed(1)} dB); ` +
        `4kHz+ ${inNoise!.toFixed(1)} -> ${outNoise!.toFixed(1)} dB (lost ${noiseLoss.toFixed(1)} dB)\n`,
    );

    assert(toneLoss > 20, `the 440 Hz "music" is heavily attenuated (lost ${toneLoss.toFixed(1)} dB)`);
    assert(noiseLoss > 20, `the noise is attenuated too (lost ${noiseLoss.toFixed(1)} dB)`);
    // If DFN ever stopped hurting music, this test would fail and the policy
    // wording in describeDenoisePolicy() would have to be revisited.
    assert(toneLoss > 15, 'the signal loss is large enough to justify keeping DFN out of batch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MEASURED: DeepFilterNet also removes a musical chord', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;

  const dir = scratch('dfn-chord');
  try {
    const mDir = join(dir, 'measure');
    mkdirSync(mDir, { recursive: true });

    // A musical A-major triad plus broadband noise: unambiguously "music".
    const out = join(dir, 'chord.wav');
    const tones = ['220', '277.18', '329.63', '440'];
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const f of tones) {
      args.push('-f', 'lavfi', '-i', `sine=frequency=${f}:duration=10:sample_rate=48000`);
    }
    args.push('-f', 'lavfi', '-i', 'anoisesrc=d=10:c=white:a=0.05:r=48000');
    args.push(
      '-filter_complex',
      '[0:a][1:a][2:a][3:a][4:a]amix=inputs=5:duration=shortest:normalize=0,aformat=sample_fmts=s16:channel_layouts=mono',
    );
    args.push('-ac', '1', out);

    const gen = await runFfmpeg(bins!.ffmpeg, args, { cwd: dir });
    assert(gen.code === 0 && existsSync(out), `synthesised the chord (exit ${gen.code})`);

    const inMusic = await meanVolume(out, 'lowpass=f=1200', mDir);
    const inNoise = await meanVolume(out, 'highpass=f=4000', mDir);

    const r = await denoiseFile(
      { exePath: dfnPath! },
      { ffmpeg: bins!.ffmpeg, inputPath: out, outputPath: join(dir, 'chord-denoised.wav'), scratch: dir },
    );
    assert(r.ok, `denoiseFile succeeded: ${r.message ?? ''}`);

    const outMusic = await meanVolume(r.outputPath!, 'lowpass=f=1200', mDir);
    const outNoise = await meanVolume(r.outputPath!, 'highpass=f=4000', mDir);
    assert(inMusic !== null && outMusic !== null && inNoise !== null && outNoise !== null, 'measured bands');

    const musicLoss = inMusic! - outMusic!;
    const noiseLoss = inNoise! - outNoise!;
    process.stdout.write(
      `       chord: music<1200Hz ${inMusic!.toFixed(1)} -> ${outMusic!.toFixed(1)} dB (lost ${musicLoss.toFixed(1)} dB); ` +
        `noise>4kHz ${inNoise!.toFixed(1)} -> ${outNoise!.toFixed(1)} dB (lost ${noiseLoss.toFixed(1)} dB)\n`,
    );

    assert(musicLoss > 15, `the music band is heavily attenuated (lost ${musicLoss.toFixed(1)} dB)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: denoiseFile produces a playable file for a real track', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;

  const dir = scratch('dfn-e2e');
  try {
    const src = await makeMusicLike(dir, 'track.wav');
    const outPath = join(dir, 'track-clean.mp3');

    const r = await denoiseFile(
      { exePath: dfnPath! },
      {
        ffmpeg: bins!.ffmpeg,
        inputPath: src,
        outputPath: outPath,
        scratch: dir,
        attenLimDb: 12,
        compensateDelay: true,
      },
    );
    assert(r.ok, `denoiseFile succeeded: ${r.message ?? ''}`);
    assertEq(r.outputPath, outPath, 'reports the requested output path');
    assert(existsSync(outPath), 'the output file exists');
    assert(statSync(outPath).size > 1000, 'the output is not empty');

    // The output must still be valid audio of the same duration.
    const p = await probe(bins!.ffprobe, outPath, dir);
    assert(p.audio !== null, 'has an audio stream');
    assert(p.audio!.codecName === 'mp3', `encoded to mp3: ${p.audio!.codecName}`);
    assert(Math.abs(p.format.durationSec - 10) < 0.5, `duration preserved: ${p.format.durationSec}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: denoiseFile leaves no scratch files behind', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;

  const dir = scratch('dfn-cleanup');
  try {
    const src = await makeMusicLike(dir, 'track.wav');
    const r = await denoiseFile(
      { exePath: dfnPath! },
      { ffmpeg: bins!.ffmpeg, inputPath: src, outputPath: join(dir, 'out.wav'), scratch: dir },
    );
    assert(r.ok, `denoiseFile succeeded: ${r.message ?? ''}`);

    // Every per-call work dir is `dfn-*`; none may survive the call.
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('dfn-'));
    assertEq(leftovers, [], 'no intermediate directories remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: a failing encode is reported, not thrown', async () => {
  if (skipNoDfn() || skipNoFfmpeg()) return;

  const dir = scratch('dfn-bad-out');
  try {
    const src = await makeMusicLike(dir, 'track.wav');
    // An output path inside a directory that cannot be created must fail cleanly.
    const r = await denoiseFile(
      { exePath: dfnPath! },
      {
        ffmpeg: bins!.ffmpeg,
        inputPath: src,
        outputPath: join(dir, 'no', 'such', 'deeply', 'nested', 'out.mp3'),
        scratch: dir,
      },
    );
    // Either it fails with a message, or (if mkdir happened to succeed) it
    // succeeds — what must never happen is a throw or a half-written result.
    if (!r.ok) {
      assertEq(r.outputPath, null, 'no output path on failure');
      assert(typeof r.message === 'string' && r.message.length > 0, 'carries a message');
    } else {
      assert(existsSync(r.outputPath!), 'a reported success really produced a file');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
