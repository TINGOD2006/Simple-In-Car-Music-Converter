/**
 * Locating and running the ffmpeg / ffprobe binaries.
 *
 * IMPORTANT ARCHITECTURAL CONSTRAINT (measured, not assumed):
 * this process may run under a sandbox that denies *piped* stdio to child
 * processes (`spawn EPERM`). Every child is therefore started with
 * `stdio: 'ignore'`, and all output is exchanged through files:
 *   - ffprobe  -> `-o <file>` (JSON written to disk)
 *   - ffmpeg   -> `FFREPORT` (log written to a name WE choose, see below)
 *
 * The report filename is the subtle part. `-report` writes
 * `ffmpeg-YYYYMMDD-HHMMSS.log` — second resolution only — so two ffmpeg calls
 * in the same directory within the same second collide: the second run
 * truncates the first one's log and a before/after directory diff sees no *new*
 * file at all, silently yielding `report: null`. Callers that parse the report
 * (loudnorm measurement, verification) then fail for no visible reason.
 *
 * Measured: 12 rapid `loudnorm ... print_format=json` runs in one cwd produced
 * only 2 log files; 10 of 12 runs returned a null report.
 *
 * We therefore pass an explicit, unique `FFREPORT=file=<name>:level=48`
 * instead of relying on the timestamped default. The loudnorm JSON block it
 * produces is byte-identical to the one `-report` writes (verified), so every
 * existing parser is unaffected.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { appRoot } from './approot.ts';

export interface BinPaths {
  ffmpeg: string;
  ffprobe: string;
  /** Where they were found, for diagnostics. */
  source: string;
}

const WELL_KNOWN_DIRS = [
  'C:\\ffmpeg-8.1-full_build\\bin',
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\Program Files (x86)\\ffmpeg\\bin',
];

/**
 * Directories next to the installed application.
 *
 * A packaged build ships ffmpeg beside the executable (or under `tools/bin`), so
 * these are checked before the machine-wide well-known locations. This keeps a
 * portable copy self-contained: it uses the ffmpeg it was shipped with rather
 * than whatever happens to be installed on the host.
 */
function appLocalDirs(): string[] {
  const root = appRoot();
  return [join(root, 'bin'), join(root, 'tools', 'bin'), join(root, 'ffmpeg', 'bin'), root];
}

function isExe(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function fromDir(dir: string): BinPaths | null {
  const ffmpeg = join(dir, 'ffmpeg.exe');
  const ffprobe = join(dir, 'ffprobe.exe');
  if (isExe(ffmpeg) && isExe(ffprobe)) return { ffmpeg, ffprobe, source: dir };
  return null;
}

/**
 * Locate ffmpeg and ffprobe.
 *
 * Resolution order: explicit dir -> AUS_FFMPEG_DIR -> app-local dirs -> PATH ->
 * well-known dirs. App-local comes before PATH so a portable install uses the
 * ffmpeg it shipped with instead of a different one earlier on PATH.
 */
export function findBinaries(explicitDir?: string): BinPaths {
  const tried: string[] = [];

  const candidates: string[] = [];
  if (explicitDir) candidates.push(explicitDir);
  if (process.env.AUS_FFMPEG_DIR) candidates.push(process.env.AUS_FFMPEG_DIR);
  candidates.push(...appLocalDirs());
  for (const p of (process.env.PATH ?? '').split(delimiter)) {
    if (p.trim()) candidates.push(p);
  }
  candidates.push(...WELL_KNOWN_DIRS);

  for (const dir of candidates) {
    tried.push(dir);
    const found = fromDir(dir);
    if (found) return found;
  }

  throw new Error(
    'Could not locate ffmpeg.exe and ffprobe.exe.\n' +
      'Set AUS_FFMPEG_DIR to the directory containing them, or pass --ffmpeg-dir.\n' +
      `Searched ${tried.length} locations, including: ${tried.slice(0, 5).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hard ceiling on one child, so "wedged forever" degrades to "failed, with a reason".
 *
 * `spawn` hands back a process, not a promise with a deadline: if ffmpeg blocks on
 * a damaged directory entry or a stalled device read, `close` never fires and the
 * awaiting caller never settles. In a batch that is fatal rather than merely slow —
 * `verify()` awaits this twice per item and `mapPool` awaits `Promise.all` over every
 * item, so ONE wedged child freezes the whole job at `stage: 'verify'` with no error
 * and no progress. Measured: a child that never exits left `runFfmpeg` still pending
 * after 3 s while a normal child settled in 63 ms.
 *
 * Ten minutes is a ceiling, not a budget: the real batch averaged ~10 s per item, so
 * this can only ever fire on a child that is genuinely stuck.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * How long to wait for `close` after a kill before resolving anyway.
 *
 * A successful kill closes within milliseconds. This only matters when the kill was
 * refused or the handle is wedged, and even then the caller must be given an answer.
 */
const KILL_GRACE_MS = 5_000;

export interface RunOptions {
  /** Scratch directory the child runs in; its report log lands here. */
  cwd: string;
  /** Extra environment entries for the child. */
  env?: Record<string, string>;
  /**
   * Kill the child after this many ms and resolve with a non-zero code.
   * Defaults to `DEFAULT_RUN_TIMEOUT_MS`. Callers that know the operation is
   * short (a probe, a measurement of a file whose duration is known) pass less.
   */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  /** Full contents of the ffmpeg report log, or null when none was produced. */
  report: string | null;
  /** Path of the report log, when one was produced. */
  reportPath: string | null;
  /** True when the child was killed for exceeding `timeoutMs`. */
  timedOut?: boolean;
}

/** Report-log basename pattern, so cleanup and discovery stay in one place. */
const REPORT_RE = /^ffmpeg-.*\.log$/i;

/** Distinguishes concurrent/rapid reports within one directory. */
let reportSeq = 0;

function listReports(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((f) => REPORT_RE.test(f)));
  } catch {
    return new Set();
  }
}

/**
 * Run ffmpeg, capturing its log from the job scratch directory.
 *
 * Output is never piped: the caller reads `result.report` (or the artifact on
 * disk) instead of a stream.
 *
 * The log path is chosen by US, not by ffmpeg's second-resolution default
 * timestamp, because two calls in the same directory within the same second
 * would otherwise collide and one would silently return a null report. We ask
 * for `ffmpeg-<unique>.log` through `FFREPORT`, so the file is new by
 * construction and the before/after diff is only a safety net.
 */
export function runFfmpeg(
  bin: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const before = listReports(opts.cwd);
  const argv = args.filter((a) => a !== '-report');

  reportSeq = (reportSeq + 1) % 1_000_000;
  const stamp = `${process.pid.toString(36)}-${Date.now().toString(36)}-${reportSeq.toString(36)}`;
  const reportName = `ffmpeg-aus-${stamp}.log`;
  const reportPath = join(opts.cwd, reportName);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        // A unique target per run: no collisions, and ffmpeg truncates rather
        // than appends, so a stale file can never be mistaken for this run's.
        FFREPORT: `file=${reportName}:level=48`,
        ...(opts.env ?? {}),
      },
    });

    let settled = false;
    let timedOut = false;
    let killGrace: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killGrace !== null) clearTimeout(killGrace);
    };

    /**
     * Read whatever report this run left behind.
     *
     * Called on `close`, and again on the timeout path: a killed child may still
     * have flushed part of its log, and that tail is the only diagnostic the user
     * gets for a stuck file.
     */
    const collect = (code: number): RunResult => {
      let resolvedPath: string | null = null;
      if (existsSync(reportPath)) {
        resolvedPath = reportPath;
      } else {
        // Safety net: if FFREPORT was overridden by opts.env, fall back to
        // whatever the run actually created.
        const after = listReports(opts.cwd);
        const fresh: string[] = [];
        for (const f of after) if (!before.has(f)) fresh.push(f);
        if (fresh.length > 0) {
          fresh.sort((a, b) => {
            try {
              return statSync(join(opts.cwd, b)).mtimeMs - statSync(join(opts.cwd, a)).mtimeMs;
            } catch {
              return 0;
            }
          });
          resolvedPath = join(opts.cwd, fresh[0]!);
        }
      }

      let report: string | null = null;
      if (resolvedPath) {
        try {
          report = readFileSync(resolvedPath, 'utf8');
        } catch {
          report = null;
        }
      }

      return { code, report, reportPath: resolvedPath, ...(timedOut ? { timedOut } : {}) };
    };

    /**
     * The deadline. A child that has not closed by now is not slow, it is stuck —
     * so kill it and resolve rather than leaving the batch frozen forever.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      // Ask first: a normal child exits on SIGTERM.
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      // Escalate, and resolve regardless — the caller must not wait on a process
      // that has already refused one signal.
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
      }, KILL_GRACE_MS);
    }, timeoutMs);

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
      // A killed child reports whatever the platform gives; `timedOut` is the flag
      // callers should branch on, not the numeric code.
      resolve(collect(code ?? -1));
    });
  });
}

/** Delete the report logs a run produced. Keeps scratch dirs from growing. */
export function cleanupReports(cwd: string): void {
  try {
    for (const f of readdirSync(cwd)) {
      if (REPORT_RE.test(f)) rmSync(join(cwd, f), { force: true });
    }
  } catch {
    /* best effort */
  }
}

/**
 * A human-readable reason for a killed child.
 *
 * "ffmpeg exited -1" tells the user nothing, and the files this fires on are
 * exactly the ones the incident report describes: a damaged FAT32 directory entry
 * or a stalled device read that never returns. The advice has to be actionable,
 * because the app cannot fix the device.
 */
export function timeoutMessage(target: string, timeoutMs: number): string {
  const mins = Math.round(timeoutMs / 60_000);
  return (
    `${target} 超過 ${mins} 分鐘沒有回應，已中止（檔案本身或隨身碟可能有問題）。` +
    '建議：用磁碟檢查工具（chkdsk E: /f）修復這支隨身碟，' +
    '或先把檔案複製到電腦上再轉換。原始檔案沒有被更動。'
  );
}
