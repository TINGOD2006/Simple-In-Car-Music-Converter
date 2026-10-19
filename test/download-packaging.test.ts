/**
 * Packaging guards for the yt-dlp binary.
 *
 * Every other download test mocks the runner, because PyInstaller's
 * self-extraction is blocked in this project's sandbox — `yt-dlp.exe` simply
 * cannot execute here. That makes these guards the only automated check that the
 * binary reaches a user at all: if the build forgets to copy it, or the fetch
 * script's pin drifts, or someone commits a 17.8 MB artefact, nothing else fails.
 *
 * The rules being protected:
 *   1. a build with `--no-tools` ships no toolchain; a build with tools ships it;
 *   2. nothing in `tools/bin/` is ever tracked — binaries are fetched per machine,
 *      verified against a size and a sha256;
 *   3. the desktop release fails loudly when a required file is absent, so the
 *      binary belongs in that list;
 *   4. bumping the pin is a documented three-step procedure, not folklore.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEq, test } from './harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * The `if (withTools) { ... }` region of the engine build.
 *
 * The branch contains nested `if/else` pairs of its own, so the closing brace
 * cannot be found by looking for the first `} else {` — that one belongs to the
 * deep-filter check. The `--no-tools` log line is the unambiguous end marker the
 * branch is written around.
 */
function withToolsRegion(src: string): string {
  const open = src.indexOf('if (withTools) {');
  assert(open >= 0, 'tools/build-exe.mjs must keep its `if (withTools)` branch');
  const skip = src.indexOf('skipping toolchain copy');
  assert(skip > open, 'the `withTools` branch must keep its `--no-tools` counterpart');
  const close = src.lastIndexOf('} else {', skip);
  assert(close > open, 'the `withTools` branch must still close before the skip log');
  return src.slice(open, close);
}

test('the engine build copies yt-dlp.exe exactly when it copies the toolchain', () => {
  const src = read('tools/build-exe.mjs');
  const branch = withToolsRegion(src);
  assert(
    branch.includes('yt-dlp.exe'),
    'the withTools branch must ship yt-dlp.exe — without it the packaged app can never download from YouTube',
  );
  assert(
    /join\(outDir,\s*'bin'/.test(branch),
    'yt-dlp.exe belongs in bin/ beside ffmpeg.exe, which is the directory findYtDlp() searches',
  );

  const noTools = src.slice(src.indexOf('skipping toolchain copy'));
  assert(
    !noTools.includes('yt-dlp.exe'),
    '`--no-tools` must copy no binary at all, including this one',
  );
});

test('no binary in tools/bin is ever tracked', () => {
  const lines = read('tools/bin/.gitignore').split(/\r?\n/);
  assert(lines.includes('*'), 'tools/bin/.gitignore must keep its catch-all `*`');
  const unignored = lines.filter((l) => l.trim().startsWith('!') && l.trim() !== '!.gitignore');
  assertEq(
    unignored,
    [],
    'nothing may be un-ignored in tools/bin: a committed 17.8 MB yt-dlp.exe would land in every clone',
  );
});

test('the desktop release refuses to ship without yt-dlp.exe', () => {
  const src = read('tools/build-desktop-release.mjs');
  assert(
    /join\(\s*'engine',\s*'bin',\s*'yt-dlp\.exe'\s*\)/.test(src),
    'yt-dlp.exe must be in the release acceptance list, or an incomplete release passes silently',
  );
});

test('the maintenance doc names all three bump steps', () => {
  const doc = read('docs/download-maintenance.md');
  for (const needle of [
    'tools/fetch-ytdlp.mjs',
    'EXPECTED_SHA256',
    'EXPECTED_SIZE',
    'tools/smoke-download.mjs',
    '2026.08.19',
  ]) {
    assert(doc.includes(needle), `docs/download-maintenance.md must mention ${needle}`);
  }
});

test('the smoke script is manual-only and drives the route it claims', () => {
  const smoke = read('tools/smoke-download.mjs');
  for (const needle of ['--route', '--url', 'youtube-direct', 'ffprobe']) {
    assert(smoke.includes(needle), `tools/smoke-download.mjs must support ${needle}`);
  }
  assert(
    /manual/i.test(smoke),
    'the smoke script must say it is manual: it needs a real network and a real yt-dlp.exe, neither of which CI has',
  );
});

test('a built release carries the pinned binary, or the search is skipped loudly', () => {
  const candidates = [
    join(ROOT, 'release', 'bin', 'yt-dlp.exe'),
    join(ROOT, 'release', 'engine', 'bin', 'yt-dlp.exe'),
    join(ROOT, 'build', 'yt-dlp.exe'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    // The full build runs at release time, not once per suite run, so its
    // absence is expected here — but it must be visible, never silent.
    // eslint-disable-next-line no-console
    console.log(
      '  note  no release build on disk — the yt-dlp.exe byte check was SKIPPED (build at release time)',
    );
    return;
  }
  assertEq(statSync(found).size, 17840399, `the shipped binary at ${found} must be the pinned build`);
});
