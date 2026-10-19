/**
 * ytdlp.ts — the runner around the shipped `yt-dlp.exe`.
 *
 * This process may run under a sandbox that denies *piped* stdio to children
 * (`spawn EPERM`), so `runYtDlp` never reads a stream: stderr goes to a file
 * descriptor the caller opened and the file is read back afterwards. These
 * tests pin that channel with `process.execPath` as the "binary", the same
 * trick `ffbin-timeout.test.ts` uses — no real yt-dlp can run in this sandbox
 * at all (PyInstaller self-extraction is blocked), so a real fixture is not an
 * option and a fake one must prove the wiring instead.
 *
 * The stale-log test is the load-bearing one: a report file that is appended to
 * rather than truncated turns the *previous* run's failure into this run's
 * reason, which would mislabel a healthy download as `video-unavailable`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import {
  classifyYtDlpFailure,
  findYtDlp,
  runYtDlp,
  YTDLP_DIR_ENV,
  YTDLP_EXE,
} from '../src/core/ytdlp.ts';

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aus-ytdlp-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Set an env var for the duration of a test, restoring the prior value. */
function setEnv(name: string, value: string | undefined): () => void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

/** A child that runs forever, standing in for a stalled yt-dlp. */
const HANG = 'setTimeout(() => {}, 600000)';

const UNAVAILABLE =
  "process.stderr.write('ERROR: [youtube] x: This video is unavailable'); process.exit(1)";

test('runYtDlp reads the child stderr back from the report file', async () => {
  await withScratch(async (dir) => {
    const res = await runYtDlp(process.execPath, ['-e', UNAVAILABLE], { cwd: dir });

    assertEq(res.code, 1, 'a failing child must report its real exit code');
    assert(
      res.stderr.includes('This video is unavailable'),
      `stderr must carry the child's message, got: ${JSON.stringify(res.stderr)}`,
    );
  });
});

test('runYtDlp reports an empty stderr for a silent successful child', async () => {
  await withScratch(async (dir) => {
    const res = await runYtDlp(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir });

    assertEq(res.code, 0, 'a clean child must report exit code 0');
    assertEq(res.stderr, '', 'a silent child must leave an empty report');
    assert(!res.timedOut, 'a clean child must not be flagged as timed out');
  });
});

test('runYtDlp kills a child that outlives its timeout and resolves anyway', async () => {
  await withScratch(async (dir) => {
    const started = Date.now();
    const res = await runYtDlp(process.execPath, ['-e', HANG], { cwd: dir, timeoutMs: 400 });
    const elapsed = Date.now() - started;

    assert(elapsed < 8000, `expected the timeout to fire quickly, took ${elapsed}ms`);
    assertEq(res.timedOut, true, 'a killed child must be reported as timedOut');
    assert(res.code !== 0, `a timed-out child must not report success (got ${res.code})`);
  });
});

test('the report file is truncated per run, never appended to', async () => {
  await withScratch(async (dir) => {
    // A previous run left its failure behind. Reading it back would turn a
    // healthy run into a phantom `video-unavailable`.
    writeFileSync(join(dir, 'ytdlp-report.log'), 'ERROR: stale failure');

    const res = await runYtDlp(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir });

    assertEq(res.code, 0, 'the clean child must still succeed');
    assertEq(res.stderr, '', 'the stale report must not be read as this run stderr');
  });
});

test('classifyYtDlpFailure maps yt-dlp stderr onto our reason vocabulary', () => {
  const table: [number, string, string][] = [
    [1, 'ERROR: [youtube] x: This video is unavailable', 'video-unavailable'],
    [1, 'ERROR: Sign in to confirm you\u2019re not a bot', 'rate-limit'],
    [1, 'ERROR: HTTP Error 429: Too Many Requests', 'rate-limit'],
    [1, 'ERROR: This live event will begin in 3 hours', 'live-unsupported'],
    [1, 'ERROR: Requested format is not available', 'no-audio-format'],
    [1, 'ERROR: something else entirely', 'io-error'],
    [0, '', 'io-error'],
  ];

  for (const [code, stderr, expected] of table) {
    assertEq(
      classifyYtDlpFailure(code, stderr),
      expected,
      `classify(${code}, ${JSON.stringify(stderr)})`,
    );
  }
});

test('findYtDlp prefers an explicit dir over the environment', async () => {
  await withScratch(async (dir) => {
    const explicit = join(dir, 'explicit');
    const fromEnv = join(dir, 'env');
    for (const d of [explicit, fromEnv]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, YTDLP_EXE), '');
    }

    const restore = setEnv(YTDLP_DIR_ENV, fromEnv);
    try {
      assertEq(
        findYtDlp(explicit),
        join(explicit, YTDLP_EXE),
        'the explicit dir must win over AUS_YTDLP_DIR',
      );
    } finally {
      restore();
    }
  });
});

test('findYtDlp skips a dir that holds no yt-dlp.exe', async () => {
  await withScratch(async (dir) => {
    const empty = join(dir, 'empty');
    const fromEnv = join(dir, 'env');
    mkdirSync(empty, { recursive: true });
    mkdirSync(fromEnv, { recursive: true });
    writeFileSync(join(fromEnv, YTDLP_EXE), '');

    const restore = setEnv(YTDLP_DIR_ENV, fromEnv);
    try {
      assertEq(
        findYtDlp(empty),
        join(fromEnv, YTDLP_EXE),
        'a dir with no yt-dlp.exe must fall through to the next location',
      );
    } finally {
      restore();
    }
  });
});

test('findYtDlp names the fetch script when the binary is nowhere', async () => {
  await withScratch(async (dir) => {
    const empty = join(dir, 'empty');
    mkdirSync(empty, { recursive: true });

    // Point every search root at an empty dir, so this cannot depend on what
    // happens to be installed on the machine running the suite.
    const restoreApp = setEnv('AUS_APP_ROOT', empty);
    const restoreDir = setEnv(YTDLP_DIR_ENV, undefined);
    const restorePath = setEnv('PATH', empty);
    try {
      let message = '';
      try {
        findYtDlp();
      } catch (err) {
        message = (err as Error).message;
      }
      assert(
        message.includes('tools/fetch-ytdlp.mjs'),
        `the error must tell the user how to fetch the binary, got: ${JSON.stringify(message)}`,
      );
    } finally {
      restorePath();
      restoreDir();
      restoreApp();
    }
  });
});
