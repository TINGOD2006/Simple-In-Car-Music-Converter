/**
 * ffbin.ts — a child that never exits must not wedge the caller.
 *
 * The batch runner awaits `runFfmpeg` twice per item inside `verify()`, and
 * `mapPool` awaits `Promise.all` over every item. `spawn` hands back a process,
 * not a deadline, so before this was fixed a single ffmpeg blocked on a damaged
 * FAT32 directory entry froze the entire job at `stage: 'verify'` with no error,
 * no progress and no way out.
 *
 * These tests use `process.execPath` as the child rather than ffmpeg: the bug is
 * about process lifetime, not about audio, and a real hang is the only honest
 * fixture. The hanging script is `setTimeout` with no callback body, so it stays
 * alive until it is killed.
 *
 * The control case matters as much as the timeout case: a test that only proves
 * "a killed child returns" would also pass if `runFfmpeg` were broken for every
 * child, so a normal child must still settle and still report exit code 0.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import { DEFAULT_RUN_TIMEOUT_MS, runFfmpeg } from '../src/core/ffbin.ts';

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aus-ffbin-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A child that runs forever, standing in for ffmpeg stuck on a dead device. */
const HANG = 'setTimeout(() => {}, 600000)';

test('runFfmpeg kills a child that outlives its timeout and resolves anyway', async () => {
  await withScratch(async (dir) => {
    const started = Date.now();
    const res = await runFfmpeg(process.execPath, ['-e', HANG], {
      cwd: dir,
      timeoutMs: 400,
    });
    const elapsed = Date.now() - started;

    // The whole point: it settles at all, and it settles near the deadline
    // rather than never. A generous upper bound keeps this from being flaky on a
    // loaded machine while still failing loudly if the kill is not wired up.
    assert(elapsed < 8000, `expected the timeout to fire quickly, took ${elapsed}ms`);
    assertEq(res.timedOut, true, 'a killed child must be reported as timedOut');
    assert(res.code !== 0, `a timed-out child must not report success (got ${res.code})`);
  });
});

test('runFfmpeg still resolves a normal child with its real exit code', async () => {
  await withScratch(async (dir) => {
    const ok = await runFfmpeg(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir });
    assertEq(ok.code, 0, 'a clean child must report exit code 0');
    assert(!ok.timedOut, 'a clean child must not be flagged as timed out');

    const bad = await runFfmpeg(process.execPath, ['-e', 'process.exit(3)'], { cwd: dir });
    assertEq(bad.code, 3, 'a failing child must report its real exit code');
  });
});

test('the default timeout is a ceiling, not a budget', () => {
  // A batch item averaged ~10 s in the real incident; ten minutes can only ever
  // fire on a genuinely stuck child.
  assert(
    DEFAULT_RUN_TIMEOUT_MS >= 60_000,
    `default timeout is too aggressive for a real encode: ${DEFAULT_RUN_TIMEOUT_MS}ms`,
  );
});
