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
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/** Per-process run counter, so two concurrent calls cannot pick one name. */
let reportSeq = 0;

function reportFileName(): string {
  reportSeq += 1;
  return `${REPORT_PREFIX}${process.pid}-${reportSeq}.log`;
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
 */
export function runYtDlp(
  bin: string,
  args: string[],
  opts: RunYtDlpOptions,
): Promise<RunYtDlpResult> {
  const reportPath = join(opts.cwd, reportFileName());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS;

  return new Promise<RunYtDlpResult>((resolve, reject) => {
    let fd: number;
    try {
      // 'w' truncates: this run's log must never contain the last run's error.
      fd = openSync(reportPath, 'w');
    } catch (err) {
      reject(new Error(`Failed to open ${reportPath}: ${(err as Error).message}`));
      return;
    }

    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'ignore', fd],
        windowsHide: true,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    } catch (err) {
      closeSync(fd);
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
  if (RATE_LIMIT_RE.test(text)) return 'rate-limit';
  if (VIDEO_UNAVAILABLE_RE.test(text)) return 'video-unavailable';
  if (LIVE_UNSUPPORTED_RE.test(text)) return 'live-unsupported';
  if (NO_AUDIO_FORMAT_RE.test(text)) return 'no-audio-format';
  return 'io-error';
}
