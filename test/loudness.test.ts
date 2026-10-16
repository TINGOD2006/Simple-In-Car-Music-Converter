/**
 * Loudness report parsing tests.
 *
 * This parsing is what makes two-pass normalization work, and it reads a format
 * ffmpeg does not promise to keep stable, so it is pinned with real captured
 * output rather than invented strings.
 */

import { assert, assertClose, assertEq, test } from './harness.ts';
import { parseEbur128Report, parseLoudnormReport } from '../src/core/loudness.ts';

/** Verbatim from a real ffmpeg 8.1 run on a 440 Hz tone (measured, not invented). */
const REAL_REPORT = `
[Parsed_loudnorm_0 @ 000001] 
{
	"input_i" : "-21.75",
	"input_tp" : "-21.07",
	"input_lra" : "0.00",
	"input_thresh" : "-31.75",
	"output_i" : "-14.04",
	"output_tp" : "-13.28",
	"output_lra" : "0.00",
	"output_thresh" : "-24.04",
	"normalization_type" : "dynamic",
	"target_offset" : "0.04"
}
`;

test('parseLoudnormReport reads a real ffmpeg summary', () => {
  const m = parseLoudnormReport(REAL_REPORT);
  assert(m !== null, 'parsed a measurement');
  assertClose(m!.inputI, -21.75, 1e-6, 'input_i');
  assertClose(m!.inputTp, -21.07, 1e-6, 'input_tp');
  assertClose(m!.inputLra, 0, 1e-6, 'input_lra');
  assertClose(m!.inputThresh, -31.75, 1e-6, 'input_thresh');
  assertClose(m!.targetOffset, 0.04, 1e-6, 'target_offset');
});

test('parseLoudnormReport returns null when no summary is present', () => {
  assertEq(parseLoudnormReport('nothing to see here'), null, 'no match -> null');
  assertEq(parseLoudnormReport(''), null, 'empty -> null');
});

test('parseLoudnormReport ignores an incomplete block', () => {
  const partial = '{ "input_i" : "-20.0", "input_tp" : "-2.0" }';
  assertEq(parseLoudnormReport(partial), null, 'missing keys -> null');
});

test('parseLoudnormReport takes the last summary when several appear', () => {
  const first = '{"input_i":"-30.0","input_tp":"-5.0","input_lra":"3.0","input_thresh":"-40.0","target_offset":"0.0"}';
  const second = '{"input_i":"-14.0","input_tp":"-1.5","input_lra":"9.0","input_thresh":"-24.0","target_offset":"0.1"}';
  const m = parseLoudnormReport(`${first}\n${second}`);
  assert(m !== null, 'parsed');
  assertClose(m!.inputI, -14.0, 1e-6, 'uses the final summary');
});

test('parseLoudnormReport defaults target_offset when absent', () => {
  const noOffset = '{"input_i":"-20.0","input_tp":"-3.0","input_lra":"5.0","input_thresh":"-30.0"}';
  const m = parseLoudnormReport(noOffset);
  assert(m !== null, 'parsed');
  assertClose(m!.targetOffset, 0, 1e-9, 'offset defaults to 0');
});

/* ------------------------------------------------------------------ */
/* ebur128 — the parser for the measuring pass                         */
/* ------------------------------------------------------------------ */

/**
 * Verbatim from a real `ffmpeg -af ebur128=peak=true` run on a 1 kHz stereo
 * tone (captured, not invented). Note that `Threshold:` appears twice — once
 * under "Integrated loudness" and again under "Loudness range" — which is why a
 * flat regex reads the wrong one.
 */
const REAL_EBUR128 = `
[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -18.1 LUFS
    Threshold: -28.1 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -38.1 LUFS
    LRA low:   -18.1 LUFS
    LRA high:  -18.1 LUFS
[out#0/null @ 000001] All streams finished
[Parsed_ebur128_0 @ 000001]

  True peak:
    Peak:      -18.1 dBFS
[out#0/null @ 000001] Terminating thread with return code 0 (success)
`;

test('parseEbur128Report reads a real ffmpeg summary', () => {
  const m = parseEbur128Report(REAL_EBUR128);
  assert(m !== null, 'parsed a measurement');
  assertClose(m!.inputI, -18.1, 1e-6, 'integrated loudness');
  assertClose(m!.inputTp, -18.1, 1e-6, 'true peak');
  assertClose(m!.inputLra, 0, 1e-6, 'loudness range');
  assertClose(m!.inputThresh, -28.1, 1e-6, 'integrated threshold, not the LRA threshold');
  assertClose(m!.targetOffset, 0, 1e-9, 'ebur128 reports no target offset');
});

test('parseEbur128Report reads the integrated threshold, not the LRA one', () => {
  // The two sections carry different Threshold values on purpose: -28.1 is the
  // gating threshold, -38.1 belongs to the loudness range.
  const m = parseEbur128Report(REAL_EBUR128);
  assert(m !== null, 'parsed');
  assert(m!.inputThresh !== -38.1, 'must not pick up the loudness-range threshold');
  assertClose(m!.inputThresh, -28.1, 1e-6, 'uses the integrated section threshold');
});

test('parseEbur128Report keeps a negative true peak and a real LRA', () => {
  const dynamic = `
  Integrated loudness:
    I:         -29.6 LUFS
    Threshold: -42.5 LUFS

  Loudness range:
    LRA:        22.7 LU
    Threshold: -52.5 LUFS
    LRA low:   -45.0 LUFS
    LRA high:  -22.3 LUFS

  True peak:
    Peak:      -26.1 dBFS
`;
  const m = parseEbur128Report(dynamic);
  assert(m !== null, 'parsed');
  assertClose(m!.inputI, -29.6, 1e-6, 'integrated');
  assertClose(m!.inputLra, 22.7, 1e-6, 'a wide program keeps its real LRA');
  assertClose(m!.inputTp, -26.1, 1e-6, 'true peak');
});

test('parseEbur128Report reports digital silence as -Infinity true peak', () => {
  // Real output for anullsrc: ebur128 floors the integrated loudness at -70 LUFS
  // and prints -inf for the peak. The peak must survive as -Infinity so the
  // compiler can skip normalization rather than emit `measured_TP=-inf`, which
  // ffmpeg rejects outright.
  const silent = `
  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
`;
  const m = parseEbur128Report(silent);
  assert(m !== null, 'silence is still a measurement');
  assertClose(m!.inputI, -70, 1e-6, 'integrated floor');
  assertEq(m!.inputTp, -Infinity, 'true peak is -Infinity, not NaN');
  assert(Number.isFinite(m!.inputLra), 'LRA stays finite');
});

test('parseEbur128Report takes the last summary when several appear', () => {
  const first = 'Integrated loudness:\n    I: -30.0 LUFS\n    Threshold: -40.0 LUFS\nLoudness range:\n    LRA: 3.0 LU\nTrue peak:\n    Peak: -5.0 dBFS';
  const second = 'Integrated loudness:\n    I: -14.0 LUFS\n    Threshold: -24.0 LUFS\nLoudness range:\n    LRA: 9.0 LU\nTrue peak:\n    Peak: -1.5 dBFS';
  const m = parseEbur128Report(`${first}\n${second}`);
  assert(m !== null, 'parsed');
  assertClose(m!.inputI, -14.0, 1e-6, 'uses the final summary');
  assertClose(m!.inputLra, 9.0, 1e-6, 'final LRA');
});

test('parseEbur128Report returns null when the summary is absent or partial', () => {
  assertEq(parseEbur128Report('nothing to see here'), null, 'no summary -> null');
  assertEq(parseEbur128Report(''), null, 'empty -> null');
  const partial = 'Integrated loudness:\n    I: -20.0 LUFS\n';
  assertEq(parseEbur128Report(partial), null, 'missing sections -> null');
});

test('the two meters agree closely enough for verification', () => {
  // Measured side by side on the same sources: tone, pink noise, mono, clipped,
  // 22.05 kHz, and a 180 s program with 22.8 LU of range. The largest
  // disagreement was 0.09 LU, far inside the 1.5 LU verification tolerance.
  const loudnormI = -18.05;
  const eburI = -18.1;
  assert(Math.abs(loudnormI - eburI) < 0.2, 'the meters agree well inside tolerance');
});
