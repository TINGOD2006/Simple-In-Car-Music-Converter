/**
 * Loudness report parsing tests.
 *
 * This parsing is what makes two-pass normalization work, and it reads a format
 * ffmpeg does not promise to keep stable, so it is pinned with real captured
 * output rather than invented strings.
 */

import { assert, assertClose, assertEq, test } from './harness.ts';
import { parseLoudnormReport } from '../src/core/loudness.ts';

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
