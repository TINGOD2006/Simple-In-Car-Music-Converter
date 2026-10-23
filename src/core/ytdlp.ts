/**
 * Locating and running the shipped `yt-dlp.exe`.
 *
 * IMPORTANT ARCHITECTURAL CONSTRAINT (measured, not assumed):
 * this process may run under a sandbox that denies *piped* stdio to child
 * processes (`spawn EPERM`). `yt-dlp` is therefore never read through a pipe.
 * Its stdout is discarded and its stderr is redirected to a **file descriptor
 * we open ourselves** — `stdio: ['ignore', 'ignore', <fd>]` — because a file
 * descriptor is not a pipe and the sandbox permits it. Measured on this machine:
 * a child spawned with an opened fd on stderr exits 0 with an empty file on
 * success, exits 1 with `ERROR: [youtube] …: This video is unavailable` on a
 * dead video, and exits 2 with a usage error on a bad option.
 *
 * Data never comes back on stdout either. `yt-dlp -J` prints to stdout, which we
 * discard, so the callers that need structured data use `--print-to-file`, which
 * still writes its file when stdout goes nowhere. That distinction is why this
 * module deliberately does not return a stdout field: a `stdout: string` here
 * would invite exactly the call that silently returns nothing.
 *
 * The report file is truncated per run (`openSync(path, 'w')`), never appended
 * to. Appending would let the *previous* run's error become this run's failure
 * reason, mislabelling a healthy download as `video-unavailable`.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { appRoot } from './approot.ts';

/** The binary name this module looks for, in every search location. */
export const YTDLP_EXE = 'yt-dlp.exe';

/** Overrides the search order entirely, for tests and portable installs. */
export const YTDLP_DIR_ENV = 'AUS_YTDLP_DIR';

/**
 * Prefix of the per-run stderr file, inside `cwd`.
 *
 * The name carries a process id and a counter because the file MUST NOT be
 * shared: the queue downloads two tracks at a time and both run in the same
 * scratch directory, so one fixed name lets a second track truncate and then
 * overwrite the first track's log. The first track would then be told its
 * failure was whatever the second one hit — a bogus `rate-limit` stalls the
 * whole queue for its 30-second cooldown, and a bogus `video-unavailable`
 * blames the wrong thing entirely. `sources/youtube.ts` and `ffbin.ts` already
 * name their per-run files this way.
 */
const REPORT_PREFIX = 'ytdlp-report-';

/**
 * Prefix of the per-run directory the child unpacks itself into.
 *
 * `yt-dlp.exe` is a PyInstaller ONE-FILE build: before it parses a single
 * argument it unpacks its payload into a directory under `%TEMP%`. That makes
 * the ambient `%TEMP%` a hard dependency of every download, and it is not one we
 * control — it may be read-only, on a network share, on a full disk, or missing
 * from a launcher's environment. When it is, the bootloader dies with
 * "Could not create temporary directory!" and the user gets a 502 on a link that
 * is perfectly good.
 *
 * So each run gets a directory inside our own scratch instead, which is
 * writable by construction (the report file already lands there), and it is
 * removed as soon as the child exits rather than being left behind like
 * PyInstaller's `_MEI*` directories.
 */
const TEMP_PREFIX = 'ytdlp-temp-';

/** Per-process run counter, so two concurrent calls cannot pick one name. */
let reportSeq = 0;

/**
 * The two per-run paths inside `cwd`: the stderr file and the child's temp dir.
 *
 * They share one counter so a run's log and its extraction directory always pair
 * up, and so no two runs can pick the same name.
 */
function nextRunPaths(cwd: string, tempBase: string): { reportPath: string; tempDir: string } {
  reportSeq += 1;
  const stem = `${process.pid}-${reportSeq}`;
  return {
    reportPath: join(cwd, `${REPORT_PREFIX}${stem}.log`),
    tempDir: join(tempBase, `${TEMP_PREFIX}${stem}`),
  };
}

/**
 * Remove a run's extraction directory.
 *
 * Best effort on purpose: a leftover temp directory is cosmetic, while a throw
 * here would replace the failure reason the caller is about to be told.
 */
function discardTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reclaims its own temp space */
  }
}

/**
 * Where the bootloader is allowed to unpack, in preference order.
 *
 * The scratch directory comes first because it is the run's own space and is
 * writable by construction. That is not the whole answer: a confined launcher
 * can let us CREATE a directory and still refuse the extraction inside it,
 * which is exactly what `runYtDlp` retries around.
 */
export function ytDlpTempDirCandidates(cwd: string): string[] {
  const out: string[] = [cwd, join(appRoot(), TEMP_PREFIX)];
  const local = process.env.LOCALAPPDATA;
  if (local) out.push(join(local, 'AudioUsbStudio', TEMP_PREFIX));
  return out;
}

/**
 * Index of the candidate that last worked, so only the first run on a given
 * machine pays for discovering it.
 */
let preferredTempIndex = 0;

/**
 * Test hook: forget which location worked, so a suite can exercise the fallback
 * without depending on whether another test already warmed it.
 */
export function resetYtDlpTempDirForTests(): void {
  preferredTempIndex = 0;
}

/**
 * Directories next to the installed application.
 *
 * A packaged build ships `yt-dlp.exe` beside the executable's `bin/`, the same
 * place ffmpeg lands, so a portable copy uses the binary it shipped with rather
 * than whatever happens to be installed on the host.
 */
function appLocalDirs(): string[] {
  const root = appRoot();
  return [join(root, 'bin'), join(root, 'tools', 'bin')];
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function fromDir(dir: string): string | null {
  const candidate = join(dir, YTDLP_EXE);
  return isFile(candidate) ? candidate : null;
}

/**
 * Locate `yt-dlp.exe`.
 *
 * Resolution order: explicit dir -> AUS_YTDLP_DIR -> app-local dirs -> PATH.
 * App-local comes before PATH so a portable install uses the binary it shipped
 * with.
 */
export function findYtDlp(explicitDir?: string): string {
  const candidates: string[] = [];
  if (explicitDir) candidates.push(explicitDir);
  if (process.env[YTDLP_DIR_ENV]) candidates.push(process.env[YTDLP_DIR_ENV] as string);
  candidates.push(...appLocalDirs());
  for (const p of (process.env.PATH ?? '').split(delimiter)) {
    if (p.trim()) candidates.push(p);
  }

  for (const dir of candidates) {
    const found = fromDir(dir);
    if (found) return found;
  }

  throw new Error(
    `Could not locate ${YTDLP_EXE}.\n` +
      'Run: node tools/fetch-ytdlp.mjs\n' +
      `Or set ${YTDLP_DIR_ENV}.`,
  );
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hard ceiling on one child, so "wedged forever" degrades to "failed, with a
 * reason". Ten minutes is a ceiling, not a budget: a single audio track is a
 * few megabytes and completes in seconds, so this can only ever fire on a
 * genuinely stuck child.
 */
export const DEFAULT_YTDLP_TIMEOUT_MS = 10 * 60_000;

/**
 * How long to wait for `close` after a kill before resolving anyway.
 *
 * A successful kill closes within milliseconds. This only matters when the kill
 * was refused or the handle is wedged, and even then the caller must be given an
 * answer rather than waiting forever.
 */
export const YTDLP_KILL_GRACE_MS = 5_000;

/**
 * Why a yt-dlp run failed, in the vocabulary the download queue already speaks.
 *
 * The queue resolves any thrown value's `reason` property by duck-typing, so
 * these strings travel from here to the UI without a shared import.
 */
export type YtDlpFailureReason =
  | 'ytdlp-missing'
  | 'ytdlp-extract-failed'
  | 'video-unavailable'
  | 'live-unsupported'
  | 'no-audio-format'
  | 'rate-limit'
  | 'io-error';

export interface RunYtDlpOptions {
  /** Scratch directory the child runs in; its report file lands here. */
  cwd: string;
  /** Kill the child after this many ms and resolve with `timedOut`. */
  timeoutMs?: number;
  /** Extra environment entries for the child. */
  env?: Record<string, string>;
  /** Abort the child and resolve with `cancelled`. */
  signal?: AbortSignal;
}

export interface RunYtDlpResult {
  code: number;
  /** True when the child was killed for exceeding `timeoutMs`. */
  timedOut?: boolean;
  /** True when the child was killed because `opts.signal` aborted. */
  cancelled?: boolean;
  /** Contents of this run's report file, always read back. */
  stderr: string;
}

/**
 * Run `yt-dlp`, capturing its stderr from a file in the job scratch directory.
 *
 * Output is never piped. Each call gets its OWN report file, opened with `'w'`
 * and removed once read: no other run can write into it, and no finished run
 * leaves it behind.
 *
 * `tempBase` is where the bootloader is told to unpack. It is a parameter
 * because the right answer is machine-dependent — see `ytDlpTempDirCandidates`.
 */
function runOnce(
  bin: string,
  args: string[],
  opts: RunYtDlpOptions,
  tempBase: string,
): Promise<RunYtDlpResult> {
  const { reportPath, tempDir } = nextRunPaths(opts.cwd, tempBase);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS;

  return new Promise<RunYtDlpResult>((resolve, reject) => {
    try {
      mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      reject(new Error(`Failed to create ${tempDir}: ${(err as Error).message}`));
      return;
    }

    let fd: number;
    try {
      // 'w' truncates: this run's log must never contain the last run's error.
      fd = openSync(reportPath, 'w');
    } catch (err) {
      discardTemp(tempDir);
      reject(new Error(`Failed to open ${reportPath}: ${(err as Error).message}`));
      return;
    }

    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'ignore', fd],
        windowsHide: true,
        env: {
          ...process.env,
          // The one-file bootloader unpacks into `%TEMP%`, so hand it a
          // directory we own instead of whatever the launcher left behind —
          // see TEMP_PREFIX. Windows reads TMP before TEMP, so both are set.
          TEMP: tempDir,
          TMP: tempDir,
          TMPDIR: tempDir,
          ...(opts.env ?? {}),
        },
      });
    } catch (err) {
      closeSync(fd);
      discardTemp(tempDir);
      reject(new Error(`Failed to start ${bin}: ${(err as Error).message}`));
      return;
    }
    // The child holds its own descriptor; ours would otherwise leak.
    closeSync(fd);

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killGrace: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killGrace !== null) clearTimeout(killGrace);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    /**
     * Read whatever this run left behind.
     *
     * Called on `close` and on every kill path: a killed child may still have
     * flushed part of its log, and that tail is the only diagnostic the user
     * gets.
     */
    const collect = (code: number): RunYtDlpResult => {
      let stderr = '';
      try {
        stderr = readFileSync(reportPath, 'utf8');
      } catch {
        stderr = '';
      }
      // Removed as soon as it is read: the scratch directory is long-lived and
      // every download would otherwise leave a log behind it.
      try {
        rmSync(reportPath, { force: true });
      } catch {
        /* the report is already read; a leftover is cosmetic */
      }
      // The extracted PyInstaller payload goes with it, for the same reason.
      discardTemp(tempDir);
      return {
        code,
        stderr,
        ...(timedOut ? { timedOut } : {}),
        ...(cancelled ? { cancelled } : {}),
      };
    };

    /** Kill, then escalate and resolve regardless — the caller must not wait. */
    const killAndSettle = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      killGrace = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        if (!settled) {
          settled = true;
          clearTimers();
          resolve(collect(-1));
        }
      }, YTDLP_KILL_GRACE_MS);
    };

    function onAbort(): void {
      if (settled) return;
      cancelled = true;
      killAndSettle();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killAndSettle();
    }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) {
        cancelled = true;
        killAndSettle();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new Error(`Failed to start ${bin}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // A killed child reports whatever the platform gives; `timedOut` and
      // `cancelled` are the flags callers branch on, not the numeric code.
      resolve(collect(code ?? -1));
    });
  });
}

/**
 * Run `yt-dlp`, moving to the next extraction location when the bootloader
 * cannot create its own temporary directory.
 *
 * Measured on the machine this app was built for: a directory beside the
 * executable unpacks fine, while `%LOCALAPPDATA%`, the system temp, and even
 * other folders in the same user profile all fail with
 * `[PYI-nnnn:ERROR] Could not create temporary directory!` — although a plain
 * process can write to every one of them. The cause is the launcher confining
 * the child, not a property of yt-dlp, so no single static location is right on
 * every machine. Trying in order costs one extra spawn the first time and
 * nothing afterwards.
 */
export async function runYtDlp(
  bin: string,
  args: string[],
  opts: RunYtDlpOptions,
): Promise<RunYtDlpResult> {
  const candidates = ytDlpTempDirCandidates(opts.cwd);
  let result: RunYtDlpResult | null = null;
  let lastError: unknown = null;

  for (let i = preferredTempIndex; i < candidates.length; i += 1) {
    const dir = candidates[i];
    if (dir === undefined) continue;

    try {
      result = await runOnce(bin, args, opts, dir);
    } catch (err) {
      // The location itself is unusable (a read-only install directory).
      lastError = err;
      continue;
    }

    // A cancelled or timed-out run says nothing about the location.
    if (result.cancelled || result.timedOut) return result;
    if (!EXTRACT_FAILED_RE.test(result.stderr)) {
      preferredTempIndex = i;
      return result;
    }
  }

  if (result !== null) return result;
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not start yt-dlp: no usable extraction directory');
}

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

/**
 * `yt-dlp` exits 0 on success and 1 for "the download failed", so the exit code
 * alone cannot say *why*. The message on stderr is the discriminator, and it is
 * stable prose rather than a code, so this is a pattern match — ordered, because
 * the families overlap (a format error literally contains "not available").
 */
const RATE_LIMIT_RE = /sign in to confirm|not a bot|\b429\b|too many requests/i;

/**
 * The PyInstaller one-file bootloader failing to unpack itself.
 *
 * Checked FIRST and on its own: when it fires, yt-dlp never started, so nothing
 * else in the log describes the video. Without this the user is told
 * "yt-dlp 執行失敗：" followed by a bootloader line they cannot act on, when the
 * real advice is about the extraction directory or antivirus.
 */
const EXTRACT_FAILED_RE =
  /\[PYI-\d+:ERROR\]|could not create temporary directory|failed to create parent directory structure|cannot create a file when that file already exists/i;

const VIDEO_UNAVAILABLE_RE =
  /this video is unavailable|video unavailable|private video|not available in your country|age.?restricted|premieres|removed by the uploader|terminated/i;

const LIVE_UNSUPPORTED_RE = /live event will begin|is live|live stream|live event/i;

const NO_AUDIO_FORMAT_RE =
  /requested format is not available|no suitable format|no audio format|no video formats found/i;

/**
 * Map an exit code plus stderr onto a reason the queue and UI understand.
 *
 * Order matters: bot/429 is checked first because the same response can carry
 * other words, and the unavailable family is checked before the format family
 * because "not available in your country" and "Requested format is not
 * available" share a phrase but need different advice.
 */
export function classifyYtDlpFailure(code: number, stderr: string): YtDlpFailureReason {
  const text = stderr ?? '';
  // First: if the bootloader never unpacked, the rest of the log is noise.
  if (EXTRACT_FAILED_RE.test(text)) return 'ytdlp-extract-failed';
  if (RATE_LIMIT_RE.test(text)) return 'rate-limit';
  if (VIDEO_UNAVAILABLE_RE.test(text)) return 'video-unavailable';
  if (LIVE_UNSUPPORTED_RE.test(text)) return 'live-unsupported';
  if (NO_AUDIO_FORMAT_RE.test(text)) return 'no-audio-format';
  return 'io-error';
}
