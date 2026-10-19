/**
 * Task 2 — the pinned `yt-dlp.exe` fetch script and the binary policy around it.
 *
 * These tests never download anything. `tools/fetch-ytdlp.mjs` guards its
 * `main()` behind `import.meta.url === pathToFileURL(process.argv[1]).href`, so
 * importing it hands back the pins without touching the network.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEq, test } from './harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

interface FetchScript {
  VERSION: string;
  URL: string;
  EXPECTED_SIZE: number;
  EXPECTED_SHA256: string;
  parseArgs: (argv: string[]) => { out: string };
}

/** The script is plain `.mjs` with no declaration file, so it arrives untyped. */
async function loadFetchScript(): Promise<FetchScript> {
  return (await import('../tools/fetch-ytdlp.mjs')) as FetchScript;
}

test('fetch-ytdlp pins the release, the asset name and the size', async () => {
  const script = await loadFetchScript();
  assert(script.URL.includes(script.VERSION), 'URL must name the pinned version');
  assert(script.URL.endsWith('/yt-dlp.exe'), 'URL must point at yt-dlp.exe');
  assertEq(script.EXPECTED_SIZE, 17840399, 'pinned byte size');
});

test('the pinned sha256 is a real digest, not a placeholder', async () => {
  const script = await loadFetchScript();
  assert(
    /^[0-9a-f]{64}$/.test(script.EXPECTED_SHA256),
    `EXPECTED_SHA256 must be 64 lowercase hex, got "${script.EXPECTED_SHA256}"`,
  );
});

test('parseArgs honours --out and defaults next to the other tools', async () => {
  const script = await loadFetchScript();
  assertEq(script.parseArgs(['--out', 'x.exe']).out, 'x.exe', 'explicit --out wins');
  const fallback = script.parseArgs([]).out;
  assert(
    fallback.endsWith(path.join('bin', 'yt-dlp.exe')),
    `default target must be tools/bin/yt-dlp.exe, got "${fallback}"`,
  );
});

test('the binary policy records where yt-dlp.exe comes from', async () => {
  const script = await loadFetchScript();

  const ignore = readFileSync(path.join(ROOT, 'tools', 'bin', '.gitignore'), 'utf8');
  assert(
    ignore.includes('tools/fetch-ytdlp.mjs'),
    'tools/bin/.gitignore must name the fetch script',
  );

  const readme = readFileSync(path.join(ROOT, 'tools', 'README.md'), 'utf8');
  assert(
    readme.includes(script.EXPECTED_SHA256),
    'tools/README.md must record the pinned sha256',
  );
});
