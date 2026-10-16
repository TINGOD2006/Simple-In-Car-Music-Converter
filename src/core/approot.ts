/**
 * Resolving the application root directory.
 *
 * In development the code runs from `<repo>/src/core/...`, so the root is two
 * levels up from this file. A packaged single-file executable is different: the
 * JavaScript is extracted to a temporary directory, which makes `import.meta.url`
 * point somewhere meaningless for finding sibling data such as
 * `tools/bin/deep-filter.exe` or a bundled `web/dist`.
 *
 * The packaged launcher therefore exports the executable's own directory as
 * `AUS_APP_ROOT`, and we prefer that whenever it is set. Everything that needs
 * to find files relative to the installation (not relative to the code) goes
 * through `appRoot()`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variable the packaged launcher sets to the executable's directory. */
export const APP_ROOT_ENV = 'AUS_APP_ROOT';

/** Environment variable the packaged launcher sets to the extracted-asset directory. */
export const ASSET_ROOT_ENV = 'AUS_ASSET_ROOT';

/**
 * Directory the application should treat as its installation root.
 *
 * Order: `AUS_APP_ROOT` (set by the packaged launcher) -> the repo root
 * derived from this module's location.
 */
export function appRoot(): string {
  const fromEnv = process.env[APP_ROOT_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Directory holding files that were bundled into the executable and extracted at
 * startup (the built web UI, for example).
 *
 * A source checkout has no such directory, so this falls back to `appRoot()` —
 * callers look for `web/dist` under whichever root they get, and only the
 * checkout has it on disk.
 */
export function assetRoot(): string {
  const fromEnv = process.env[ASSET_ROOT_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return appRoot();
}

/** True when running from a packaged executable rather than a source checkout. */
export function isPackaged(): boolean {
  return Boolean(process.env[APP_ROOT_ENV]?.trim());
}

/**
 * Candidate scratch directories, best first.
 *
 * `os.tmpdir()` is the conventional answer and stays first, but it is not always
 * usable: Windows policy, antivirus, a locked-down or roaming profile, or a temp
 * directory another process is holding open can all make `mkdir` there fail with
 * `EPERM`. A packaged build refused exactly that way — so the application fell over
 * before it ran a single command, while every other location on the machine was
 * perfectly writable.
 */
function scratchCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  add(join(tmpdir(), 'audio-usb-studio'));
  if (process.env.LOCALAPPDATA) add(join(process.env.LOCALAPPDATA, 'AudioUsbStudio', 'scratch'));
  if (process.env.APPDATA) add(join(process.env.APPDATA, 'AudioUsbStudio', 'scratch'));
  add(join(appRoot(), '.aus-scratch'));

  return out;
}

/** One candidate location, and whether this process can actually create and write in it. */
export interface WritableProbe {
  dir: string;
  ok: boolean;
  detail: string;
}

function describe(err: unknown): string {
  return `${(err as NodeJS.ErrnoException).code ?? 'ERROR'}: ${(err as Error).message}`;
}

/**
 * Create `dir`, write a file in it, then remove the file.
 *
 * Creating a directory is not the same as being allowed to write inside it, and
 * Windows reports the two differently — creating a probe file is the only way to
 * answer the question the callers actually care about. It is also the only way to
 * tell a permissions problem apart from a directory that something else is holding.
 */
export function probeWritable(dir: string): WritableProbe {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { dir, ok: false, detail: describe(err) };
  }

  const probe = join(dir, `.aus-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { dir, ok: true, detail: 'writable' };
  } catch (err) {
    return { dir, ok: false, detail: `the directory was created, but writing in it failed — ${describe(err)}` };
  }
}

/** Every scratch candidate, each probed. Exported so `doctor` can report them. */
export function probeScratchCandidates(): WritableProbe[] {
  return scratchCandidates().map(probeWritable);
}

/**
 * The first candidate — the conventional location, whether or not it is writable.
 *
 * For callers that must produce *some* path so the process can start and then explain
 * itself, rather than failing before it can say anything.
 */
export function preferredScratchPath(): string {
  return scratchCandidates()[0]!;
}

/**
 * Resolve a scratch directory without ever throwing.
 *
 * Callers that merely report the environment — and callers that must come up even on
 * a machine where nothing is writable — need the refusals as data, not as an
 * exception. That distinction matters: when this threw, `doctor` could not run at
 * all, so the one command that would have explained the machine died with it.
 */
export function tryResolveScratchRoot(
  requested?: string | null,
): { root: string | null; refusals: string[] } {
  if (requested && requested.trim()) {
    const probe = probeWritable(resolve(requested));
    return {
      root: probe.ok ? probe.dir : null,
      refusals: probe.ok ? [] : [`  ${probe.dir}\n    ${probe.detail}`],
    };
  }

  const refusals: string[] = [];
  for (const candidate of scratchCandidates()) {
    const probe = probeWritable(candidate);
    if (probe.ok) return { root: candidate, refusals };
    refusals.push(`  ${probe.dir}\n    ${probe.detail}`);
  }
  return { root: null, refusals };
}

/**
 * Create and return a scratch directory this process can actually write to.
 *
 * An explicitly requested path is used as given and never silently replaced: when
 * the caller named a directory, failing loudly beats quietly working somewhere
 * else. Otherwise the candidates are tried in order, and every refusal is reported
 * so the failure names the locations and the reasons instead of one arbitrary path.
 */
export function resolveScratchRoot(requested?: string | null): string {
  const { root, refusals } = tryResolveScratchRoot(requested);
  if (root) return root;

  throw new Error(
    `could not create a scratch directory in any of ${refusals.length} location(s):\n` +
      `${refusals.join('\n')}\n` +
      'If every one failed with EPERM/EACCES, Windows policy or antivirus is blocking\n' +
      'this program from creating its working directory.',
  );
}
