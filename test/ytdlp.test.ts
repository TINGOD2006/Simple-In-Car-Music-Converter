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
 * The report file is per-invocation and is deleted once read: two tracks
 * downloading at the same time share one working directory, so a single fixed
 * filename would let one track's failure text become the other's reason — a
 * healthy download mislabelled `video-unavailable`, or a bogus `rate-limit`
 * that stalls the whole queue for 30 seconds.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

test('a failing run cannot poison the next run in the same directory', async () => {
  await withScratch(async (dir) => {
    // The ordering the queue creates: one track fails, the next one succeeds.
    // If the failure text were still readable, a healthy download would be
    // mislabelled `video-unavailable`.
    const failed = await runYtDlp(process.execPath, ['-e', UNAVAILABLE], { cwd: dir });
    assertEq(failed.code, 1, 'the noisy child must report its failure');

    const clean = await runYtDlp(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir });

    assertEq(clean.code, 0, 'the clean child must still succeed');
    assertEq(clean.stderr, '', 'the earlier failure must not be read as this run stderr');
  });
});

test('concurrent runs keep their own stderr, even sharing one working directory', async () => {
  await withScratch(async (dir) => {
    // A reports its failure up front and only then lingers, so its read-back is
    // the LAST thing that happens. B starts inside that window. A fixed report
    // name means B's spawn truncates A's log and B's write replaces it, and A
    // then reports a failure that was never its own.
    const slow = 'process.stderr.write("ERROR: ALPHA-OWN-FAILURE"); setTimeout(() => process.exit(1), 700)';
    const quick = 'setTimeout(() => { process.stderr.write("ERROR: BRAVO-OWN-FAILURE"); process.exit(1); }, 0)';

    const first = runYtDlp(process.execPath, ['-e', slow], { cwd: dir });
    await sleep(200);
    const second = runYtDlp(process.execPath, ['-e', quick], { cwd: dir });

    const [a, b] = await Promise.all([first, second]);

    assert(
      a.stderr.includes('ALPHA-OWN-FAILURE'),
      `the longer run must report its own failure, got ${JSON.stringify(a.stderr)}`,
    );
    assert(
      !a.stderr.includes('BRAVO-OWN-FAILURE'),
      `the longer run read the other run's log: ${JSON.stringify(a.stderr)}`,
    );
    assert(
      b.stderr.includes('BRAVO-OWN-FAILURE'),
      `the shorter run must report its own failure, got ${JSON.stringify(b.stderr)}`,
    );
  });
});

test('a finished run leaves no report file behind', async () => {
  await withScratch(async (dir) => {
    await runYtDlp(process.execPath, ['-e', UNAVAILABLE], { cwd: dir });

    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.log'));

    assertEq(leftovers.length, 0, `the scratch must not fill with logs, found ${leftovers.join(', ')}`);
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
