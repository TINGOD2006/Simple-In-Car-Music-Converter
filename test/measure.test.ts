/**
 * Measuring one file's loudness without building a timeline.
 *
 * This is what the library table needs: a row per file showing how loud it is,
 * so the user can see which tracks need normalising before starting.
 *
 * These tests really run ffmpeg. The whole value of the function is the number
 * it returns, so a stubbed child process would assert nothing.
 *
 * The fixture is built with `aevalsrc` rather than `sine`, and that is not a
 * detail: lavfi's `sine` emits at amplitude 0.125, so "amplitude 0.5" written as
 * `sine` + `volume=0.5` is really -24 dBFS. Writing the amplitude into the
 * expression makes the expected level arithmetic instead of a guess, which is
 * what lets these tests assert absolute dB values at all.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertClose, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import { measureFileLoudness } from '../src/core/loudness.ts';

const bins = findBinaries();

/** Target set only to satisfy the signature; it does not affect what is measured. */
const TARGETS = { integratedLufs: -14, truePeakDb: -1, lra: 11 };

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aus-measure-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 1 kHz mono tone whose peak amplitude is exactly `amplitude`. */
function amplitudeToDb(amplitude: number): number {
  return 20 * Math.log10(amplitude);
}

async function makeTone(dir: string, name: string, amplitude: number): Promise<string> {
  const out = join(dir, name);
  const res = await runFfmpeg(
    bins.ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-f', 'lavfi',
      // No commas in the expression: a comma would be read as a filter separator.
      '-i', `aevalsrc=${amplitude}*sin(2*PI*t*1000):s=44100:d=3`,
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      out,
    ],
    { cwd: dir },
  );
  assert(res.code === 0, `could not build the ${name} fixture (ffmpeg exit ${res.code})`);
  return out;
}

test('measureFileLoudness reports a true peak that matches the fixture amplitude', async () => {
  await withScratch(async (dir) => {
    const tone = await makeTone(dir, 'half.wav', 0.5);
    const m = await measureFileLoudness(bins.ffmpeg, tone, dir, TARGETS);

    // amplitude 0.5 is -6.02 dBFS; a true-peak meter may sit a hair above it.
    assertClose(m.inputTp, amplitudeToDb(0.5), 0.5, 'true peak must match the fixture amplitude');
  });
});

test('measureFileLoudness reports integrated loudness below the true peak', async () => {
  await withScratch(async (dir) => {
    const tone = await makeTone(dir, 'half.wav', 0.5);
    const m = await measureFileLoudness(bins.ffmpeg, tone, dir, TARGETS);

    // A sine's RMS is 3.01 dB below its peak, so loudness must land under the peak
    // and within a few dB of it. Anything else means the wrong figure was parsed.
    assert(m.inputI < m.inputTp, `loudness (${m.inputI}) must sit below the true peak (${m.inputTp})`);
    assertClose(m.inputI, amplitudeToDb(0.5) - 3.01, 1.5, 'a sine measures its peak minus 3 dB');
  });
});

test('measureFileLoudness tracks a known gain change', async () => {
  await withScratch(async (dir) => {
    const quiet = await makeTone(dir, 'quiet.wav', 0.25);
    const loud = await makeTone(dir, 'loud.wav', 0.5);

    const a = await measureFileLoudness(bins.ffmpeg, quiet, dir, TARGETS);
    const b = await measureFileLoudness(bins.ffmpeg, loud, dir, TARGETS);

    // Doubling the amplitude is +6.02 dB, and loudness must follow it.
    assertClose(b.inputI - a.inputI, 6.02, 0.4, 'doubling the amplitude must add 6 dB of loudness');
  });
});

test('measureFileLoudness refuses a file with no audio stream', async () => {
  await withScratch(async (dir) => {
    const notAudio = join(dir, 'nothing.txt');
    writeFileSync(notAudio, 'this is not audio\n', 'utf8');

    let threw = false;
    try {
      await measureFileLoudness(bins.ffmpeg, notAudio, dir, TARGETS);
    } catch {
      threw = true;
    }
    assert(threw, 'a file ffmpeg cannot decode must be reported, never silently measured');
  });
});

test('measureFileLoudness measures a movie container from its audio stream', async () => {
  await withScratch(async (dir) => {
    const movie = join(dir, 'clip.mp4');
    const res = await runFfmpeg(
      bins.ffmpeg,
      [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=5:d=3',
        '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*t*1000):s=44100:d=3',
        '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        movie,
      ],
      { cwd: dir },
    );
    if (res.code !== 0) {
      // libx264 is not in every ffmpeg build; the point of this test is the
      // audio mapping, not the encoder, so treat a missing encoder as no signal.
      return;
    }

    const m = await measureFileLoudness(bins.ffmpeg, movie, dir, TARGETS);

    // Deliberately a wide band, not the fixture's own level. AAC of a pure tone
    // overshoots badly — measured true peak landed at -0.88 dB for a 0.5 source —
    // so asserting codec fidelity here would only encode an encoder artefact.
    // What this test is for is that the audio stream is measured at all rather
    // than the video stream shadowing it into an error or a silence reading.
    assert(Number.isFinite(m.inputI), `integrated loudness must be finite, got ${m.inputI}`);
    assert(m.inputI < m.inputTp, `loudness (${m.inputI}) must sit below the true peak (${m.inputTp})`);
    assert(m.inputI > -25, `a loud tone must not measure as near-silence, got ${m.inputI}`);
    assert(m.inputTp > -25, `a loud tone must not have a near-silent peak, got ${m.inputTp}`);
  });
});
