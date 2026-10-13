/**
 * DeepFilterNet as an *external process stage* — and the guard rails that keep it
 * out of the batch pipeline.
 *
 * WHY THIS IS NOT AN FFMPEG FILTER (measured, see docs/ENVIRONMENT.md 4.1)
 * ----------------------------------------------------------------------
 * ffmpeg's `arnndn` filter is present but no `.rnnn` model ships with the build,
 * and DeepFilterNet's LADSPA plugin fails to load (`Failed to load
 * '=deep_filter_mono'`). There is therefore no in-graph filter for AI denoise.
 * The only working path is:
 *
 *     source --ffmpeg--> canonical WAV --deep-filter.exe--> WAV --ffmpeg--> target
 *
 * WHY IT IS NOT THE BATCH DEFAULT (measured, docs/ENVIRONMENT.md 4.2)
 * -----------------------------------------------------------------
 * DeepFilterNet is a *speech* model. It does not merely fail to help music, it
 * actively destroys it. Re-measured for this module on a synthetic
 * "440 Hz sine + white noise" signal (10 s, 48 kHz mono):
 *
 *     full band   : -20.6 dB -> -62.7 dB   (-42.1 dB)
 *     440 Hz sig  : -21.1 dB -> -67.4 dB   (-46.3 dB)   <-- the "music"
 *     4 kHz+ noise: -31.6 dB -> -90.3 dB   (-58.7 dB)   <-- the noise
 *
 * and on a musical A-major triad (A3 C#4 E4 A4) plus noise:
 *
 *     music band (<1200 Hz): -15.1 dB -> -43.0 dB   (-27.9 dB)
 *     noise band (>4 kHz)  : -31.6 dB -> -81.3 dB   (-49.7 dB)
 *
 * The noise goes away, and so does the music. Run over a whole library that is
 * a near-silent USB stick, which is why `describeDenoisePolicy()` states the
 * batch default explicitly and `assertNotInBatchPipeline()` exists to make a
 * future regression fail loudly in tests rather than silently in a car stereo.
 *
 * SANDBOX NOTE: every child process here is started with `stdio: 'ignore'`.
 * Piped stdio is denied in this environment (`spawn EPERM`, docs/ENVIRONMENT.md
 * 2.1), so all data crosses the boundary through files on disk.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join } from 'node:path';

import { denoiseParams } from './effects.ts';
import { appRoot } from './approot.ts';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface DeepFilterConfig {
  /** Absolute path to `deep-filter.exe`. */
  exePath: string;
}

/** Environment variable that overrides discovery, mirroring AUS_FFMPEG_DIR. */
export const DEEP_FILTER_ENV = 'AUS_DEEP_FILTER';

/** Version this integration was developed and measured against. */
export const DEEP_FILTER_VERSION = '0.5.6';

/** Expected byte size of the official v0.5.6 Windows asset. */
export const DEEP_FILTER_ASSET_BYTES = 26912256;

/**
 * Repo/install root, used to find the bundled `tools/` defaults. In a packaged
 * executable the code lives in a temp extraction dir, so this must come from
 * `appRoot()` (which honours `AUS_APP_ROOT`) rather than from this file's own
 * location.
 */
function repoRoot(): string {
  return appRoot();
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Accept a directory as well as a file path, so callers can pass either. */
function asExePath(p: string): string {
  try {
    if (existsSync(p) && statSync(p).isDirectory()) return join(p, 'deep-filter.exe');
  } catch {
    /* fall through and treat it as a file path */
  }
  return p;
}

/**
 * Extra knobs for discovery, used by tests to prove the "not found" path without
 * having to uninstall the binary. The primary signature stays
 * `findDeepFilter(explicitPath?)`.
 */
export interface FindDeepFilterOptions {
  /** Directory list to use instead of `PATH` (defaults to `process.env.PATH`). */
  searchPath?: string;
  /** Skip the repo-local `tools/` defaults. */
  skipRepoDefaults?: boolean;
}

/**
 * Locate `deep-filter.exe`.
 *
 * Resolution order: explicit path -> `AUS_DEEP_FILTER` -> `tools/bin` ->
 * `tools/` -> every `PATH` entry. Returns `null` when nothing is found; it never
 * throws, so callers can treat "not installed" as an ordinary condition.
 */
export function findDeepFilter(
  explicitPath?: string,
  opts?: FindDeepFilterOptions,
): string | null {
  const candidates: string[] = [];

  if (explicitPath) candidates.push(asExePath(explicitPath));
  const envPath = process.env[DEEP_FILTER_ENV];
  if (envPath) candidates.push(asExePath(envPath));

  if (!opts?.skipRepoDefaults) {
    // Next to the installed application first, mirroring `findBinaries()`: a
    // packaged build ships `bin/deep-filter.exe` beside the executable, while a
    // source checkout keeps it under `tools/bin`. Checking the app-local
    // locations first keeps a portable copy self-contained instead of picking up
    // a binary that happens to be on the host.
    const root = repoRoot();
    candidates.push(join(root, 'bin', 'deep-filter.exe'));
    candidates.push(join(root, 'tools', 'bin', 'deep-filter.exe'));
    candidates.push(join(root, 'tools', 'deep-filter.exe'));
    candidates.push(join(root, 'deep-filter.exe'));
  }

  const searchPath = opts?.searchPath ?? process.env.PATH ?? '';
  for (const p of searchPath.split(delimiter)) {
    if (p.trim()) candidates.push(join(p, 'deep-filter.exe'));
  }

  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

/**
 * Is the configured binary actually usable? A zero-byte or missing file counts
 * as unavailable, so a truncated download is never mistaken for an install.
 */
export function isAvailable(cfg: DeepFilterConfig): boolean {
  try {
    if (!cfg || typeof cfg.exePath !== 'string' || cfg.exePath === '') return false;
    if (!existsSync(cfg.exePath)) return false;
    const st = statSync(cfg.exePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Anti-misuse guard                                                   */
/* ------------------------------------------------------------------ */

/**
 * Tokens that would betray an AI denoiser inside an ffmpeg filter graph.
 *
 * The leading boundary is deliberately omitted for the DeepFilterNet spellings:
 * the LADSPA plugin is referenced as `deep_filter_mono` / `=deep_filter_mono`, and
 * a caller may also write `adeep-filter`. No ffmpeg filter contains the substring
 * "deep", so this cannot produce a false positive, whereas a missed detection
 * would let a speech model into the batch pipeline.
 */
const AI_DENOISE_PATTERNS: { token: string; re: RegExp }[] = [
  { token: 'arnndn', re: /(^|[^a-z0-9_])arnndn([^a-z0-9_]|$)/i },
  { token: 'deep-filter', re: /deep[-_ ]?filter/i },
  { token: 'deepfilternet', re: /deepfilternet/i },
  { token: 'dfn', re: /(^|[^a-z0-9_])dfn([^a-z0-9_]|$)/i },
  { token: '.rnnn', re: /\.rnnn([^a-z0-9_]|$)/i },
];

/**
 * The denoise chain the batch pipeline is allowed to use: ffmpeg-native, gentle,
 * and audibly transparent on music. `adeclick` cleans repair-stage clicks and
 * `afftdn` (gentle) is a broadband spectral gate.
 */
export const BATCH_DENOISE_DEFAULT = {
  label: 'gentle afftdn + adeclick',
  declick: 'adeclick',
  afftdn: denoiseParams('gentle'),
} as const;

/** Return the AI-denoise tokens present in a filter graph (empty = clean). */
export function findAiDenoiseTraces(filterGraph: string): string[] {
  const text = String(filterGraph ?? '');
  const found: string[] = [];
  for (const { token, re } of AI_DENOISE_PATTERNS) {
    if (re.test(text)) found.push(token);
  }
  return found;
}

/**
 * Throw when a filter graph contains any AI-denoise trace.
 *
 * This is the safety net for the rule "DeepFilterNet is never a batch default".
 * The batch path is `compile()` (src/core/compiler.ts), whose only denoise input
 * is the `denoise` effect in src/core/effects.ts; a test asserts the compiled
 * USB-preset graph passes this check, so re-introducing DFN into the default
 * fails the suite instead of silently flattening a whole library.
 */
export function assertNotInBatchPipeline(filterGraph: string): void {
  const traces = findAiDenoiseTraces(filterGraph);
  if (traces.length > 0) {
    throw new Error(
      `AI denoise is not allowed in the batch pipeline (found: ${traces.join(', ')}).\n` +
        'DeepFilterNet is a speech model: measured on a musical chord it attenuated ' +
        'the music band by 27.9 dB (see tools/README.md). Use the batch default ' +
        `(${BATCH_DENOISE_DEFAULT.label}) instead, or call denoiseFile() explicitly ` +
        'for a single manually chosen track.',
    );
  }
}

/**
 * The project's denoise policy, as data so callers (CLI, HTTP API, UI) can show
 * the same wording instead of inventing their own.
 */
export function describeDenoisePolicy(): {
  batchDefault: string;
  singleTrackOnly: string;
  reason: string;
} {
  return {
    batchDefault: `gentle afftdn + adeclick (ffmpeg-native, no AI). afftdn=${BATCH_DENOISE_DEFAULT.afftdn}, declick=${BATCH_DENOISE_DEFAULT.declick}.`,
    singleTrackOnly:
      'DeepFilterNet (deep-filter.exe) is a manual per-track opt-in only: call denoiseFile() for one explicitly chosen file. It is never applied by planBatch()/runBatch() or by any ExportPreset.',
    reason:
      'DeepFilterNet is a speech model, so it removes music along with the noise. ' +
      'Measured on "440 Hz sine + white noise" (docs/ENVIRONMENT.md 4.2): the 440 Hz ' +
      'signal fell from -26.9 dB to -84.3 dB, i.e. the music was attenuated by 57 dB ' +
      'while the noise fell 68 dB. Re-measured for this module on the same synthetic ' +
      'signal: signal -21.1 -> -67.4 dB (-46.3 dB), noise -31.6 -> -90.3 dB (-58.7 dB); ' +
      'on a musical A-major triad: music band -15.1 -> -43.0 dB (-27.9 dB). Applied to ' +
      'a whole batch, every track would come out near-silent.',
  };
}

/* ------------------------------------------------------------------ */
/* The external-process stage                                          */
/* ------------------------------------------------------------------ */

export interface DenoiseOptions {
  ffmpeg: string;
  inputPath: string;
  outputPath: string;
  /** Scratch directory; a unique subdirectory is created inside it. */
  scratch: string;
  /** Pass `--pf` to DeepFilterNet (stronger, more musical artefacts). */
  postFilter?: boolean;
  /** Pass `-a <n>`: attenuation limit in dB (0 = no reduction). */
  attenLimDb?: number;
  /** Pass `-D` to compensate the STFT/model lookahead delay. */
  compensateDelay?: boolean;
}

export interface DenoiseResult {
  ok: boolean;
  outputPath: string | null;
  message?: string;
}

function ensureDir(dir: string): boolean {
  try {
    if (existsSync(dir)) return statSync(dir).isDirectory();
  } catch {
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    // Some sandboxes deny mkdir even for the owner; the caller may have
    // pre-created the directory, which the existsSync check above already
    // accepted. Report failure only when it is genuinely absent.
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }
}

function token(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run one child process with `stdio: 'ignore'` and resolve with its exit code.
 *
 * Piped stdio is impossible here (`spawn EPERM`), so nothing is captured: the
 * exit code plus the presence of the expected artifact is the whole contract.
 */
function runQuiet(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { code: number; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(bin, args, {
        cwd,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => done({ code: -1, error: err.message }));
      child.on('close', (code) => done({ code: code ?? -1 }));
    } catch (err) {
      done({ code: -1, error: (err as Error).message });
    }
  });
}

/**
 * Denoise one file through DeepFilterNet.
 *
 * Pipeline: ffmpeg decode -> canonical 48 kHz WAV -> deep-filter.exe -> ffmpeg
 * encode to `outputPath`. All I/O is file-based; every child runs with
 * `stdio: 'ignore'`.
 *
 * This function NEVER throws and never rejects: a missing binary, a failed
 * process, an absent output file and a bad output directory all come back as
 * `{ ok: false, outputPath: null, message }`. Callers can therefore offer it as
 * an optional single-track action without wrapping it in try/catch.
 */
export async function denoiseFile(
  cfg: DeepFilterConfig,
  opts: DenoiseOptions,
): Promise<DenoiseResult> {
  let workDir: string | null = null;

  try {
    if (!isAvailable(cfg)) {
      return {
        ok: false,
        outputPath: null,
        message:
          `DeepFilterNet is not available (looked for "${cfg?.exePath ?? ''}"). ` +
          'Run `node tools/fetch-deep-filter.mjs` or set AUS_DEEP_FILTER.',
      };
    }
    if (!opts || typeof opts.inputPath !== 'string' || !isFile(opts.inputPath)) {
      return { ok: false, outputPath: null, message: `Input file not found: ${opts?.inputPath}` };
    }
    if (typeof opts.outputPath !== 'string' || opts.outputPath === '') {
      return { ok: false, outputPath: null, message: 'No output path was given' };
    }
    if (typeof opts.ffmpeg !== 'string' || opts.ffmpeg === '') {
      return { ok: false, outputPath: null, message: 'No ffmpeg path was given' };
    }

    const outDir = dirname(opts.outputPath);
    if (!ensureDir(outDir)) {
      return {
        ok: false,
        outputPath: null,
        message: `Output directory is not writable or does not exist: ${outDir}`,
      };
    }
    if (!ensureDir(opts.scratch)) {
      return {
        ok: false,
        outputPath: null,
        message: `Scratch directory is not usable: ${opts.scratch}`,
      };
    }

    // A private working directory per call: deep-filter writes its result under
    // the input's own basename, so a shared directory could cross wires.
    workDir = join(opts.scratch, `dfn-${token()}`);
    const dfnOutDir = join(workDir, 'out');
    if (!ensureDir(workDir) || !ensureDir(dfnOutDir)) {
      return { ok: false, outputPath: null, message: `Could not create scratch dir ${workDir}` };
    }

    // Step 1: decode anything -> a canonical WAV that deep-filter accepts.
    // 48 kHz is the model's native rate; channels are preserved (mono stays
    // mono, stereo stays stereo). Anything exotic is left for deep-filter to
    // reject, which surfaces as a structured failure below.
    const stage1 = join(workDir, 'stage1.wav');
    const dec = await runQuiet(
      opts.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', opts.inputPath, '-ar', '48000', stage1],
      workDir,
    );
    if (dec.code !== 0 || !isFile(stage1)) {
      return {
        ok: false,
        outputPath: null,
        message: `ffmpeg could not decode ${opts.inputPath} to WAV (exit ${dec.code})${dec.error ? `: ${dec.error}` : ''}`,
      };
    }

    // Step 2: the AI stage itself. stdio MUST be 'ignore' (piped -> spawn EPERM).
    const dfArgs: string[] = [];
    if (opts.postFilter) dfArgs.push('--pf');
    if (typeof opts.attenLimDb === 'number' && Number.isFinite(opts.attenLimDb)) {
      dfArgs.push('-a', String(opts.attenLimDb));
    }
    if (opts.compensateDelay) dfArgs.push('-D');
    dfArgs.push('-o', dfnOutDir, stage1);

    const dfn = await runQuiet(cfg.exePath, dfArgs, workDir);
    const dfnOut = join(dfnOutDir, basename(stage1));
    if (dfn.code !== 0) {
      return {
        ok: false,
        outputPath: null,
        message:
          `deep-filter exited with code ${dfn.code}` +
          `${dfn.error ? ` (${dfn.error})` : ''} for ${opts.inputPath}`,
      };
    }
    if (!isFile(dfnOut)) {
      let listing = '';
      try {
        listing = readdirSync(dfnOutDir).join(', ');
      } catch {
        listing = '(unreadable)';
      }
      return {
        ok: false,
        outputPath: null,
        message: `deep-filter produced no output for ${opts.inputPath} (found: ${listing || 'nothing'})`,
      };
    }

    // Step 3: encode the enhanced WAV to the requested target format.
    const enc = await runQuiet(
      opts.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', dfnOut, ...encodeArgs(opts.outputPath), opts.outputPath],
      workDir,
    );
    if (enc.code !== 0 || !isFile(opts.outputPath)) {
      return {
        ok: false,
        outputPath: null,
        message: `ffmpeg could not write ${opts.outputPath} (exit ${enc.code})${enc.error ? `: ${enc.error}` : ''}`,
      };
    }

    return { ok: true, outputPath: opts.outputPath };
  } catch (err) {
    // Defensive: the contract is "never throws", including for unexpected
    // filesystem errors raised by the helpers above.
    return {
      ok: false,
      outputPath: null,
      message: `Unexpected failure in denoiseFile: ${(err as Error)?.message ?? String(err)}`,
    };
  } finally {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Encoder settings for the final re-encode, chosen from the output extension.
 *
 * MP3 gets the project's CBR 320 kbps convention (docs/ENVIRONMENT.md 4.3):
 * `-b:a` alone selects CBR for libmp3lame, but `-minrate/-maxrate/-bufsize` pin
 * it so the stream really is 320 kbps rather than an ABR ~158 kbps.
 */
function encodeArgs(outputPath: string): string[] {
  const ext = extname(outputPath).toLowerCase();
  if (ext === '.mp3') {
    return ['-c:a', 'libmp3lame', '-b:a', '320k', '-minrate', '320k', '-maxrate', '320k', '-bufsize', '640k'];
  }
  if (ext === '.wav') return ['-c:a', 'pcm_s16le'];
  if (ext === '.flac') return ['-c:a', 'flac'];
  if (ext === '.m4a' || ext === '.aac') return ['-c:a', 'aac', '-b:a', '256k'];
  if (ext === '.opus') return ['-c:a', 'libopus', '-b:a', '192k'];
  if (ext === '.ogg' || ext === '.oga') return ['-c:a', 'libvorbis', '-q:a', '6'];
  return [];
}
