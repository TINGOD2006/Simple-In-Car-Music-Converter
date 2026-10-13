/**
 * CLI tests.
 *
 * `runCli()` had no coverage at all until the packaged `doctor` was found to be
 * silently ignoring the AI-denoise stage that both `release/README.txt` and the
 * launcher's usage text advertise. These tests pin the contract that was
 * documented but not implemented, and — more importantly — that AI denoise is
 * *reported* rather than *required*: it is an optional extra that is absent on a
 * clean machine, so its absence must never fail `doctor`.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { runCli } from '../src/cli/index.ts';
import { findBinaries } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';

let bins: BinPaths | null = null;
let unavailable = '';
try {
  bins = findBinaries();
} catch (err) {
  unavailable = (err as Error).message;
}

function skipUnlessAvailable(): boolean {
  if (!bins) {
    process.stdout.write(`  (skipping: ${unavailable.split('\n')[0]})\n`);
    return true;
  }
  return false;
}

/** Run the CLI while capturing everything it prints. */
async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const code = await runCli(argv);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

/**
 * Pull the JSON object out of captured output. The `--json` commands print human
 * lines first and the JSON blob last, so this starts at the first line that is
 * exactly `{` — matching on the first `{` anywhere would break on a Windows path
 * that happens to contain a brace.
 */
function jsonFrom(out: string): unknown {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.trim() === '{');
  assert(start >= 0, `output contains a JSON block:\n${out}`);
  return JSON.parse(lines.slice(start).join('\n'));
}

/**
 * Run `fn` with a set of environment overrides, restoring every variable
 * afterwards. Used to force the "AI denoise is not installed" branch.
 */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(over)) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ------------------------------------------------------------------ */

test('cli: doctor reports AI denoise availability, not just ffmpeg', async () => {
  if (skipUnlessAvailable()) return;
  const dir = join(tmpdir(), `aus-cli-doctor-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { code, out } = await capture(['doctor', '--json', '--ffmpeg-dir', bins!.source, '--scratch', dir]);

    assertEq(code, 0, 'doctor exits 0 when ffmpeg and ffprobe run');
    assert(/AI denoise:/.test(out), 'doctor prints an AI-denoise line');

    // The JSON form must carry the field machine-readably, which is what the
    // launcher and any future UI will consume.
    const parsed = jsonFrom(out) as {
      aiDenoise?: { available: boolean; exePath: string | null };
    };
    assert(parsed.aiDenoise !== undefined, 'doctor --json includes an aiDenoise field');
    assertEq(typeof parsed.aiDenoise!.available, 'boolean', 'aiDenoise.available is a boolean');

    // Availability must reflect reality rather than being hard-coded either way.
    const denoise = await import('../src/core/denoise.ts');
    assertEq(
      parsed.aiDenoise!.available,
      denoise.findDeepFilter() !== null,
      'aiDenoise.available matches what discovery actually finds',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: doctor still exits 0 when AI denoise is absent', async () => {
  if (skipUnlessAvailable()) return;
  const dir = join(tmpdir(), `aus-cli-nodfn-${Date.now().toString(36)}`);
  const emptyRoot = join(dir, 'empty-root');
  mkdirSync(emptyRoot, { recursive: true });
  try {
    // An app root with no bin/ or tools/, a bogus override and an empty PATH
    // remove every discovery path, so findDeepFilter() must return null.
    const { code, out } = await withEnv(
      { AUS_APP_ROOT: emptyRoot, AUS_DEEP_FILTER: join(dir, 'nope.exe'), PATH: '' },
      () => capture(['doctor', '--json', '--ffmpeg-dir', bins!.source, '--scratch', dir]),
    );

    assertEq(code, 0, 'a missing AI denoiser does not fail doctor');
    assert(/AI denoise: not installed/.test(out), 'doctor says the stage is not installed');

    const parsed = jsonFrom(out) as {
      aiDenoise: { available: boolean; exePath: string | null };
    };
    assertEq(parsed.aiDenoise.available, false, 'aiDenoise.available is false');
    assertEq(parsed.aiDenoise.exePath, null, 'aiDenoise.exePath is null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: help documents the doctor command', async () => {
  const { code, out } = await capture(['help']);
  assertEq(code, 0, 'help exits 0');
  assert(/doctor/.test(out), 'help lists doctor');
  assert(/AI denoise/.test(out), 'help mentions AI denoise for doctor');
});

test('cli: an unknown command is rejected instead of silently opening the GUI', async () => {
  const { code } = await capture(['definitely-not-a-command']);
  assertEq(code, 1, 'unknown command exits 1');
});

test('cli: doctor honours the documented binary-fallback order', async () => {
  // `findBinaries()` is documented to fall through explicit dir -> AUS_FFMPEG_DIR
  // -> app-local -> PATH -> well-known. A bogus explicit directory must therefore
  // NOT be fatal when ffmpeg is installed elsewhere on the machine.
  if (skipUnlessAvailable()) return;
  const dir = join(tmpdir(), `aus-cli-fallback-${Date.now().toString(36)}`);
  const empty = join(dir, 'no-binaries-here');
  mkdirSync(empty, { recursive: true });
  try {
    const { code, out } = await capture(['doctor', '--ffmpeg-dir', empty, '--scratch', dir]);
    assertEq(code, 0, 'doctor still succeeds when the explicit dir is bogus');
    assert(out.includes(bins!.ffmpeg), 'doctor reports the ffmpeg it actually fell back to');
    assert(!out.includes(join(empty, 'ffmpeg.exe')), 'doctor does not claim the empty dir supplied ffmpeg');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
