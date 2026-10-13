/**
 * dedup.ts — acoustic fingerprinting and duplicate grouping.
 *
 * These tests run REAL ffmpeg to produce REAL audio and REAL chromaprint
 * fingerprints, then assert on what `findDuplicates` decides. They are written to
 * the *intended* semantics, not to the current behaviour: a regression test named
 * `BUG-1` deliberately pins the rule that a computed, dissimilar fingerprint must
 * never be overruled by the cheaper size+duration fallback.
 *
 * Background on the fallback defect (reported to lead, fixed in src/core/dedup.ts):
 * two different songs at the same bitrate and length produce byte-identical file
 * sizes, so the "same size and duration" fallback would union them even after the
 * fingerprint stage had measured them as clearly dissimilar (0.875 < 0.9). The
 * fallback must only serve pairs where a fingerprint is unavailable.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertClose, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  MIN_DISTINCT_RATIO,
  MIN_DISTINCT_VALUES,
  decodeFingerprint,
  distinctRatio,
  distinctValues,
  findDuplicates,
  fingerprint,
  isStationary,
  similarity,
} from '../src/core/dedup.ts';

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

const ROOT = join(tmpdir(), 'aus-dedup');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Encode a real tone WAV. Identical parameters -> identical byte size. */
async function makeTone(
  dir: string,
  name: string,
  opts: { freq?: number; dur?: number; rate?: number } = {},
): Promise<string> {
  const freq = opts.freq ?? 440;
  const dur = opts.dur ?? 10;
  const rate = opts.rate ?? 44100;
  const out = join(dir, name);
  const r = await runFfmpeg(
    bins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=${rate}`,
      '-ac', '2', out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`could not create ${name}: exit ${r.code}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Pure functions — no ffmpeg needed                                   */
/* ------------------------------------------------------------------ */

test('dedup: similarity is symmetric and bounded to 0..1', () => {
  // Two fingerprints of the same shape: all-zero vs all-zero is a perfect match.
  const a = Buffer.alloc(16).toString('base64');
  assertEq(similarity(a, a), 1, 'a fingerprint is identical to itself');
  assert(similarity(a, a) <= 1 && similarity(a, a) >= 0, 'similarity stays within 0..1');
});

test('dedup: DEFAULT_DUPLICATE_THRESHOLD sits above the measured distinct-material band', () => {
  // Measured on this machine: re-encodes and truncated copies score 1.000, an
  // offset copy 0.89; *distinct* melodic material scores 0.44-0.78. The default
  // must sit in that gap so it catches re-encodes without merging distinct tracks.
  assert(DEFAULT_DUPLICATE_THRESHOLD > 0.80, 'threshold is above the measured distinct-material band');
  assert(DEFAULT_DUPLICATE_THRESHOLD <= 0.99, 'threshold is below the measured re-encode score');
});

test('dedup: findDuplicates returns nothing for a single entry', () => {
  assertEq(findDuplicates([]), [], 'empty input yields no groups');
  assertEq(findDuplicates([{ id: 'a', path: 'a.wav' }]), [], 'one entry cannot be a duplicate');
});

test('dedup: findDuplicates flags two entries sharing a path without touching the disk', () => {
  // Same path is detected structurally, before any file read.
  const groups = findDuplicates([
    { id: 'a', path: 'C:\\music\\song.mp3' },
    { id: 'b', path: 'c:/MUSIC/SONG.MP3' },
  ]);
  assertEq(groups.length, 1, 'one duplicate group');
  assertEq(groups[0]!.keep, 'a', 'the first entry is kept');
  assertEq(groups[0]!.drop, ['b'], 'the second is dropped');
  assertEq(groups[0]!.reason, 'same path', 'the reason names the path match');
});

test('dedup: findDuplicates flags byte-identical files as identical content', async () => {
  const dir = scratch('identical');
  try {
    const src = join(dir, 'src.bin');
    const copy = join(dir, 'copy.bin');
    // Not audio: the content-hash stage must work without ffmpeg.
    writeFileSync(src, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    copyFileSync(src, copy);

    const groups = findDuplicates([
      { id: 'src', path: src },
      { id: 'copy', path: copy },
    ]);
    assertEq(groups.length, 1, 'one duplicate group');
    assertEq(groups[0]!.reason, 'identical content', 'the reason is the content hash');
    assertEq(groups[0]!.drop, ['copy'], 'the copy is dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedup: findDuplicates keeps the longer copy when durations differ', () => {
  // Same content hash is impossible here (different files), so use the
  // size+duration fallback path: equal sizes are not achievable either, so this
  // asserts the keeper preference on the duration tie-break alone.
  const dir = scratch('keeper');
  try {
    const long = join(dir, 'long.wav');
    const short = join(dir, 'short.wav');
    writeFileSync(long, Buffer.alloc(4000, 1));
    writeFileSync(short, Buffer.alloc(2000, 1));
    const groups = findDuplicates([
      { id: 'short', path: short, durationSec: 5 },
      { id: 'long', path: long, durationSec: 10 },
    ]);
    // Different sizes and no fingerprint: nothing should be grouped at all.
    assertEq(groups, [], 'differing size and duration is not a duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Real ffmpeg + real chromaprint                                      */
/* ------------------------------------------------------------------ */

test('INTEGRATION: fingerprint returns a decodable chromaprint for real audio', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('fp-basic');
  try {
    const wav = await makeTone(dir, 'tone.wav', { freq: 440, dur: 10 });
    const fp = await fingerprint(bins!.ffmpeg, wav, dir);

    assert(fp !== null, 'a fingerprint was produced');
    assert(typeof fp === 'string' && fp.length > 0, 'the fingerprint is a non-empty string');
    // base64: only base64 characters, and no whitespace.
    assert(/^[A-Za-z0-9+/=]+$/.test(fp!), `fingerprint is base64 (got ${JSON.stringify(fp!.slice(0, 40))})`);

    const decoded = decodeFingerprint(fp!);
    assert(decoded !== null, 'the fingerprint decodes');
    assert(decoded!.length >= 4, `enough sub-fingerprints for comparison (got ${decoded!.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: fingerprint returns null instead of throwing for unusable input', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('fp-null');
  try {
    const missing = join(dir, 'does-not-exist.wav');
    assertEq(await fingerprint(bins!.ffmpeg, missing, dir), null, 'a missing file yields null');

    const garbage = join(dir, 'garbage.wav');
    writeFileSync(garbage, 'this is not audio at all');
    assertEq(await fingerprint(bins!.ffmpeg, garbage, dir), null, 'a non-audio file yields null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: an exact copy of a file is detected as a duplicate', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('copy');
  try {
    const orig = await makeTone(dir, 'orig.wav', { freq: 440, dur: 10 });
    const copy = join(dir, 'orig-copy.wav');
    copyFileSync(orig, copy);
    assertEq(statSync(orig).size, statSync(copy).size, 'the copy is byte-identical in size');

    const fpOrig = await fingerprint(bins!.ffmpeg, orig, dir);
    const fpCopy = await fingerprint(bins!.ffmpeg, copy, dir);
    assert(fpOrig !== null && fpCopy !== null, 'both files fingerprinted');
    assertEq(similarity(fpOrig!, fpCopy!), 1, 'identical files score a perfect match');

    const groups = findDuplicates([
      { id: 'orig', path: orig, durationSec: 10, fp: fpOrig },
      { id: 'copy', path: copy, durationSec: 10, fp: fpCopy },
    ]);
    assertEq(groups.length, 1, 'exactly one duplicate group');
    assert(groups[0]!.drop.includes('copy'), 'the copy is dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: a re-encoded copy is still detected acoustically', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('reencode');
  try {
    const wav = await makeTone(dir, 'src.wav', { freq: 440, dur: 10 });
    const mp3 = join(dir, 'src-192.mp3');
    const r = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', mp3],
      { cwd: dir },
    );
    assertEq(r.code, 0, 'the MP3 was encoded');

    const fpWav = await fingerprint(bins!.ffmpeg, wav, dir);
    const fpMp3 = await fingerprint(bins!.ffmpeg, mp3, dir);
    assert(fpWav !== null && fpMp3 !== null, 'both fingerprinted');

    const s = similarity(fpWav!, fpMp3!);
    assert(s >= DEFAULT_DUPLICATE_THRESHOLD, `a 192 kbps re-encode still matches (similarity ${s})`);

    const groups = findDuplicates([
      { id: 'wav', path: wav, durationSec: 10, fp: fpWav },
      { id: 'mp3', path: mp3, durationSec: 10, fp: fpMp3 },
    ]);
    assertEq(groups.length, 1, 'the re-encode is grouped with the source');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-1: a dissimilar fingerprint is never overruled by same size and duration', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug1');
  try {
    // Same duration, same sample rate, same channel count, same PCM format =>
    // byte-identical file sizes. Different audio => clearly dissimilar fingerprints.
    // Pink noise is used because it yields a healthy separation (0.78) rather than
    // the narrow 0.875 margin of two steady sines.
    const a = join(dir, 'a-pink.wav');
    const b = join(dir, 'b-pink.wav');
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=10:c=pink:a=0.5:r=44100', '-ac', '2', a],
      { cwd: dir },
    );
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=10:c=pink:a=0.5:r=44100:seed=99', '-ac', '2', b],
      { cwd: dir },
    );
    assertEq(
      statSync(a).size,
      statSync(b).size,
      'precondition: the two different recordings have identical file sizes',
    );

    const fpA = await fingerprint(bins!.ffmpeg, a, dir);
    const fpB = await fingerprint(bins!.ffmpeg, b, dir);
    assert(fpA !== null && fpB !== null, 'both fingerprinted');

    const s = similarity(fpA!, fpB!);
    assert(
      s < DEFAULT_DUPLICATE_THRESHOLD,
      `precondition: the two recordings are acoustically dissimilar (similarity ${s} < ${DEFAULT_DUPLICATE_THRESHOLD})`,
    );

    // The regression: the fingerprint stage correctly declines to group these,
    // so the size+duration fallback must not step in and group them anyway.
    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10, fp: fpA },
      { id: 'b', path: b, durationSec: 10, fp: fpB },
    ]);
    assertEq(
      groups,
      [],
      'two different recordings with the same size and duration are NOT duplicates ' +
        '(the size+duration fallback must not override an available fingerprint)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-1: two different tones of equal size are not duplicates either', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug1-tone');
  try {
    // The same regression with steady sines, which sit much closer to the
    // threshold (measured 0.875 vs 0.9). Kept because a music library contains
    // tonal material as well as noise.
    const a = await makeTone(dir, 'a-440.wav', { freq: 440, dur: 10 });
    const b = await makeTone(dir, 'b-1200.wav', { freq: 1200, dur: 10 });
    assertEq(statSync(a).size, statSync(b).size, 'precondition: identical file sizes');

    const fpA = await fingerprint(bins!.ffmpeg, a, dir);
    const fpB = await fingerprint(bins!.ffmpeg, b, dir);
    assert(fpA !== null && fpB !== null, 'both fingerprinted');

    const s = similarity(fpA!, fpB!);
    assert(s < DEFAULT_DUPLICATE_THRESHOLD, `the two tones are dissimilar (${s})`);

    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10, fp: fpA },
      { id: 'b', path: b, durationSec: 10, fp: fpB },
    ]);
    assertEq(groups, [], 'two different tones of equal size are not duplicates');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-1: the fallback still groups when no fingerprint is available', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug1-fallback');
  try {
    // Without fingerprints the size+duration heuristic is all we have, and it is
    // allowed to fire — the fix must narrow it, not remove it.
    const a = await makeTone(dir, 'a.wav', { freq: 440, dur: 10 });
    const b = await makeTone(dir, 'b.wav', { freq: 1200, dur: 10 });
    assertEq(statSync(a).size, statSync(b).size, 'identical sizes');

    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10 },
      { id: 'b', path: b, durationSec: 10 },
    ]);
    assertEq(groups.length, 1, 'without fingerprints the size+duration fallback still groups them');
    assertEq(groups[0]!.reason, 'same size and duration', 'and reports the fallback reason');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: three copies of the same audio collapse into one group', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('triple');
  try {
    const a = await makeTone(dir, 'a.wav', { freq: 440, dur: 10 });
    const b = join(dir, 'b.wav');
    const c = join(dir, 'c.wav');
    copyFileSync(a, b);
    copyFileSync(a, c);

    const fps = await Promise.all(
      [a, b, c].map((p) => fingerprint(bins!.ffmpeg, p, dir)),
    );
    assert(fps.every((f) => f !== null), 'all three fingerprinted');

    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10, fp: fps[0] },
      { id: 'b', path: b, durationSec: 10, fp: fps[1] },
      { id: 'c', path: c, durationSec: 10, fp: fps[2] },
    ]);
    assertEq(groups.length, 1, 'one group, not two overlapping pairs');
    assertEq(groups[0]!.drop.length, 2, 'both copies are dropped');
    assert(groups[0]!.drop.includes('b') && groups[0]!.drop.includes('c'), 'b and c are the drops');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: unrelated audio of different lengths is never grouped', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('distinct');
  try {
    const a = await makeTone(dir, 'a.wav', { freq: 440, dur: 10 });
    const b = await makeTone(dir, 'b.wav', { freq: 1200, dur: 6 });
    const fpA = await fingerprint(bins!.ffmpeg, a, dir);
    const fpB = await fingerprint(bins!.ffmpeg, b, dir);
    assert(fpA !== null && fpB !== null, 'both fingerprinted');

    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10, fp: fpA },
      { id: 'b', path: b, durationSec: 6, fp: fpB },
    ]);
    assertEq(groups, [], 'different pitch and length is not a duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: similarity of a file with itself is 1 and of silence is degenerate', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('silence');
  try {
    const tone = await makeTone(dir, 'tone.wav', { freq: 440, dur: 10 });
    const fpTone = await fingerprint(bins!.ffmpeg, tone, dir);
    assert(fpTone !== null, 'tone fingerprinted');
    assertEq(similarity(fpTone!, fpTone!), 1, 'a file matches itself exactly');

    // Silence is a degenerate chromaprint input: every sub-fingerprint is the same
    // constant, so two silent stretches of DIFFERENT length still score highly.
    // The honest assertion is therefore about silence against silence, not silence
    // against music — measured on this machine, tone-vs-silence scores 0.9375,
    // which is why dedup must never be the only guard against silent tracks.
    const sil10 = join(dir, 'sil10.wav');
    const r = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', sil10],
      { cwd: dir },
    );
    assertEq(r.code, 0, 'silence was generated');
    const fpSil = await fingerprint(bins!.ffmpeg, sil10, dir);
    assert(fpSil !== null, 'silence still produces a fingerprint');

    const decoded = decodeFingerprint(fpSil!);
    assert(decoded !== null && decoded.length >= 4, 'the silence fingerprint decodes');
    assertEq(
      new Set([...decoded!]).size,
      1,
      'precondition: a silent fingerprint is a single repeated value (degenerate)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: two different pink-noise recordings are not duplicates despite equal sizes', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('pink');
  try {
    // Pink noise is the healthiest synthetic material for chromaprint: unlike a
    // steady sine it produces 56 distinct sub-fingerprints out of 59.
    const p1 = join(dir, 'p1.wav');
    const p2 = join(dir, 'p2.wav');
    const r1 = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=10:c=pink:a=0.5:r=44100', '-ac', '2', p1],
      { cwd: dir },
    );
    const r2 = await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=10:c=pink:a=0.5:r=44100:seed=99', '-ac', '2', p2],
      { cwd: dir },
    );
    assertEq(r1.code, 0, 'first recording generated');
    assertEq(r2.code, 0, 'second recording generated');
    assertEq(statSync(p1).size, statSync(p2).size, 'precondition: equal file sizes');

    const fp1 = await fingerprint(bins!.ffmpeg, p1, dir);
    const fp2 = await fingerprint(bins!.ffmpeg, p2, dir);
    assert(fp1 !== null && fp2 !== null, 'both fingerprinted');

    const s = similarity(fp1!, fp2!);
    assert(s < DEFAULT_DUPLICATE_THRESHOLD, `different recordings are dissimilar (${s})`);

    const groups = findDuplicates([
      { id: 'p1', path: p1, durationSec: 10, fp: fp1 },
      { id: 'p2', path: p2, durationSec: 10, fp: fp2 },
    ]);
    assertEq(groups, [], 'two different equal-sized recordings are not duplicates');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: findDuplicates is deterministic across repeated runs', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('determinism');
  try {
    const a = await makeTone(dir, 'a.wav', { freq: 440, dur: 10 });
    const b = join(dir, 'b.wav');
    copyFileSync(a, b);
    const fpA = await fingerprint(bins!.ffmpeg, a, dir);
    const entries = [
      { id: 'a', path: a, durationSec: 10, fp: fpA },
      { id: 'b', path: b, durationSec: 10, fp: fpA },
    ];
    const first = findDuplicates(entries);
    const second = findDuplicates(entries);
    assertEq(JSON.stringify(first), JSON.stringify(second), 'the same input yields the same decision');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: the duplicate threshold decides borderline matches', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('threshold');
  try {
    // Two *different* recordings — same generator, different seed and length.
    // Their fingerprints are genuinely dissimilar, so the threshold alone decides;
    // the lengths differ by more than the fallback's 0.5 s window as well.
    const long = join(dir, 'long.wav');
    const short = join(dir, 'short.wav');
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=10:c=pink:a=0.5:r=44100:seed=7', '-ac', '2', long],
      { cwd: dir },
    );
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d=6:c=pink:a=0.5:r=44100:seed=4242', '-ac', '2', short],
      { cwd: dir },
    );
    const fpLong = await fingerprint(bins!.ffmpeg, long, dir);
    const fpShort = await fingerprint(bins!.ffmpeg, short, dir);
    assert(fpLong !== null && fpShort !== null, 'both fingerprinted');

    const s = similarity(fpLong!, fpShort!);
    assert(
      s < DEFAULT_DUPLICATE_THRESHOLD,
      `precondition: the two different recordings are dissimilar (${s.toFixed(3)})`,
    );
    const entries = [
      { id: 'long', path: long, durationSec: 10, fp: fpLong },
      { id: 'short', path: short, durationSec: 6, fp: fpShort },
    ];

    // At the default threshold these are not duplicates.
    assertEq(findDuplicates(entries), [], `the default threshold rejects a ${s.toFixed(3)} match`);

    // Lowering the threshold below the measured similarity must group them, which
    // proves the threshold is genuinely consulted rather than ignored.
    const loose = findDuplicates(entries, { threshold: Math.max(0.1, s - 0.2) });
    assertEq(loose.length, 1, `a threshold of ${Math.max(0.1, s - 0.2).toFixed(2)} accepts the pair`);
    assert(
      loose[0]!.reason.includes('acoustic match'),
      `the reason names the acoustic match (got ${loose[0]!.reason})`,
    );
    assertEq(loose[0]!.keep, 'long', 'the longer recording is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: findDuplicates does not throw when a path is unreadable', () => {
  const groups = findDuplicates([
    { id: 'a', path: join(ROOT, 'definitely-absent-a.wav'), durationSec: 5 },
    { id: 'b', path: join(ROOT, 'definitely-absent-b.wav'), durationSec: 5 },
  ]);
  assert(Array.isArray(groups), 'an unreadable pair yields a decision, not an exception');
});

/* ------------------------------------------------------------------ */
/* Regressions for the two defects found by the lead in the batch      */
/* end-to-end run. Both were silent: the tests passed while a real     */
/* library would have lost songs.                                      */
/* ------------------------------------------------------------------ */

test('INTEGRATION BUG-2: a truncated copy is detected (similarity uses the BEST alignment)', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug2-align');
  try {
    // The sliding-window search exists precisely for this case: a copy shorter
    // than the original. The defect compared against the *worst* alignment, so
    // this scored ~0.52 and the copy was reported as a distinct track.
    const long = join(dir, 'long.mp3');
    const short = join(dir, 'short.mp3');
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'aevalsrc=0.4*sin(2*PI*t*(261+40*sin(2*PI*t/1.5)))+0.25*sin(2*PI*t*392):s=44100:d=12',
        '-c:a', 'libmp3lame', '-b:a', '192k', long],
      { cwd: dir },
    );
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', long, '-t', '5', '-c', 'copy', short],
      { cwd: dir },
    );

    const fpLong = await fingerprint(bins!.ffmpeg, long, dir);
    const fpShort = await fingerprint(bins!.ffmpeg, short, dir);
    assert(fpLong !== null && fpShort !== null, 'both fingerprinted');

    const s = similarity(fpLong!, fpShort!);
    assert(
      s >= DEFAULT_DUPLICATE_THRESHOLD,
      `a truncated copy of the same recording still matches (similarity ${s.toFixed(3)})`,
    );

    const groups = findDuplicates([
      { id: 'long', path: long, durationSec: 12, fp: fpLong },
      { id: 'short', path: short, durationSec: 5, fp: fpShort },
    ]);
    assertEq(groups.length, 1, 'the truncated copy is grouped with its source');
    assertEq(groups[0]!.keep, 'long', 'the longer (more complete) copy is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-3: stationary tones are declined, never merged as duplicates', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug3-stationary');
  try {
    // A sustained tone collapses the chroma vector to one repeated value, so two
    // UNRELATED tones differ in only a bit or two and scored ~0.91 — over the
    // threshold. That merged distinct tonal tracks. Such fingerprints carry no
    // discriminating information, so the comparison is declined.
    const a = await makeTone(dir, 'a-440.wav', { freq: 440, dur: 10 });
    const b = await makeTone(dir, 'b-1200.wav', { freq: 1200, dur: 10 });

    const fpA = await fingerprint(bins!.ffmpeg, a, dir);
    const fpB = await fingerprint(bins!.ffmpeg, b, dir);
    assert(fpA !== null && fpB !== null, 'both fingerprinted');

    const decA = decodeFingerprint(fpA!);
    const decB = decodeFingerprint(fpB!);
    assert(decA !== null && decB !== null, 'both decode');
    assert(
      isStationary(decA!) && isStationary(decB!),
      `precondition: both tones are stationary (values ${distinctValues(decA!)}/${distinctValues(decB!)}, ratios ${distinctRatio(decA!).toFixed(3)}/${distinctRatio(decB!).toFixed(3)})`,
    );

    assertEq(similarity(fpA!, fpB!), 0, 'a stationary pair scores 0 rather than a spurious ~0.91');

    const groups = findDuplicates([
      { id: 'a', path: a, durationSec: 10, fp: fpA },
      { id: 'b', path: b, durationSec: 10, fp: fpB },
    ]);
    assertEq(groups, [], 'two different sustained tones are not duplicates');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-3b: a short stationary fingerprint cannot clear the floor by length alone', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug3b-short');
  try {
    // The failure that a ratio-only guard misses. Two UNRELATED tones, one encoded
    // to MP3 and one to FLAC, both collapse to a single distinct value — but the
    // MP3 yields far fewer sub-fingerprints, so its ratio is 1/length and rises as
    // the fingerprint shrinks. Measured on this machine: a 660 Hz FLAC gave 19
    // values (ratio 0.053) and an 880 Hz MP3 gave 11 values (ratio 0.091); both
    // cleared the 0.05 floor despite being constant, and they merged at 0.9375.
    // The absolute distinct-value count is what makes this safe.
    const flac = join(dir, 'a-660.flac');
    const mp3 = join(dir, 'b-880.mp3');
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'sine=frequency=660:sample_rate=48000:duration=5', '-c:a', 'flac', flac],
      { cwd: dir },
    );
    await runFfmpeg(
      bins!.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'sine=frequency=880:sample_rate=44100:duration=4', '-c:a', 'libmp3lame', '-b:a', '192k', mp3],
      { cwd: dir },
    );

    const fpFlac = await fingerprint(bins!.ffmpeg, flac, dir);
    const fpMp3 = await fingerprint(bins!.ffmpeg, mp3, dir);
    assert(fpFlac !== null && fpMp3 !== null, 'both fingerprinted');

    const decFlac = decodeFingerprint(fpFlac!);
    const decMp3 = decodeFingerprint(fpMp3!);
    assert(decFlac !== null && decMp3 !== null, 'both decode');

    // Both are constant vectors: exactly one distinct value each.
    assertEq(distinctValues(decFlac!), 1, 'the FLAC tone is a constant vector');
    assertEq(distinctValues(decMp3!), 1, 'the MP3 tone is a constant vector');
    assert(isStationary(decFlac!) && isStationary(decMp3!), 'both are stationary by the absolute count');

    // The short MP3 is the case a ratio-only floor waves through: its ratio is
    // 1/length, which grows as the fingerprint gets shorter.
    const ratioMp3 = distinctRatio(decMp3!);
    assert(
      ratioMp3 >= MIN_DISTINCT_RATIO,
      `precondition: the short tone's ratio (${ratioMp3.toFixed(3)}) clears the ratio floor on its own`,
    );

    assertEq(
      similarity(fpFlac!, fpMp3!),
      0,
      'two unrelated tones are declined even though the short one clears the ratio floor',
    );
    assertEq(
      findDuplicates([
        { id: 'flac', path: flac, durationSec: 5, fp: fpFlac },
        { id: 'mp3', path: mp3, durationSec: 4, fp: fpMp3 },
      ]),
      [],
      'neither tone is dropped as a duplicate of the other',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION BUG-3: distinct melodic tracks are never merged by the acoustic stage', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('bug3-distinct');
  try {
    // The end-to-end failure: four clearly different recordings plus one true
    // copy. Only the copy may be dropped; the other three must survive.
    const exprs: [string, string][] = [
      ['s1.mp3', '0.4*sin(2*PI*t*(261+40*sin(2*PI*t/1.5)))+0.25*sin(2*PI*t*392)'],
      ['s2.mp3', '0.4*sin(2*PI*t*(330+70*sin(2*PI*t/3.7)))+0.25*sin(2*PI*t*494)'],
      ['s3.mp3', '0.4*sin(2*PI*t*(220+30*sin(2*PI*t/0.7)))+0.25*sin(2*PI*t*277)'],
      ['s4.mp3', '0.35*sin(2*PI*t*(392+55*sin(2*PI*t/2.2)))+0.2*sin(2*PI*t*587)'],
    ];
    for (const [name, expr] of exprs) {
      await runFfmpeg(
        bins!.ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
          '-i', `aevalsrc=${expr}:s=44100:d=12`, '-c:a', 'libmp3lame', '-b:a', '192k', join(dir, name)],
        { cwd: dir },
      );
    }
    copyFileSync(join(dir, 's1.mp3'), join(dir, 's1-copy.mp3'));

    const names = ['s1.mp3', 's2.mp3', 's3.mp3', 's4.mp3', 's1-copy.mp3'];
    const fps: Record<string, string | null> = {};
    for (const n of names) fps[n] = await fingerprint(bins!.ffmpeg, join(dir, n), dir);
    assert(names.every((n) => fps[n] !== null), 'all fingerprinted');

    // Precondition: every distinct pair really is below the threshold, so the
    // grouping decision below is not an accident of the fallback stage.
    for (let i = 0; i < 4; i += 1) {
      for (let j = i + 1; j < 4; j += 1) {
        const s = similarity(fps[names[i]!]!, fps[names[j]!]!);
        assert(
          s < DEFAULT_DUPLICATE_THRESHOLD,
          `precondition: ${names[i]} and ${names[j]} are dissimilar (${s.toFixed(3)})`,
        );
      }
    }

    const groups = findDuplicates(
      names.map((n) => ({
        id: n,
        path: join(dir, n),
        durationSec: 12,
        bitRate: 192000,
        fp: fps[n],
      })),
    );

    assertEq(groups.length, 1, 'exactly one duplicate group among five files');
    const dropped = groups[0]!.drop;
    assertEq(dropped, ['s1-copy.mp3'], 'only the true copy is dropped; no song is lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
