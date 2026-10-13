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

export interface RunOptions {
  /** Scratch directory the child runs in; its report log lands here. */
  cwd: string;
  /** Extra environment entries for the child. */
  env?: Record<string, string>;
}

export interface RunResult {
  code: number;
  /** Full contents of the ffmpeg report log, or null when none was produced. */
  report: string | null;
  /** Path of the report log, when one was produced. */
  reportPath: string | null;
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

    child.on('error', (err) => {
      reject(new Error(`Failed to start ${bin}: ${err.message}`));
    });

    child.on('close', (code) => {
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

      resolve({ code: code ?? -1, report, reportPath: resolvedPath });
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
