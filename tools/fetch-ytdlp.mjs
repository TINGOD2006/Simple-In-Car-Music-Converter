#!/usr/bin/env node
/**
 * Download the pinned `yt-dlp.exe` release and verify it.
 *
 * WHY A NODE SCRIPT AND NOT curl / Invoke-WebRequest
 * --------------------------------------------------
 * Measured in this project's sandbox: PowerShell's `curl`, `Invoke-WebRequest`
 * and .NET `HttpClient` all fail against GitHub release redirects, while Node's
 * global `fetch` succeeds. So the one download path that works is this script.
 *
 * The 17.8 MB binary is deliberately NOT committed. Run this once per machine:
 *
 *   node tools/fetch-ytdlp.mjs
 *   node tools/fetch-ytdlp.mjs --out C:\some\dir\yt-dlp.exe
 *
 * NOTE ON RUNNING IT HERE: the official asset is a PyInstaller one-file
 * executable, and this project's sandbox denies it the temp-directory
 * self-extraction it needs (`Failed to create parent directory structure`), so
 * the downloaded `.exe` cannot be executed on this machine. Verification below
 * is therefore size + sha256, which is what makes a swapped or truncated asset
 * detectable without running it. The packaged release ships this file as a
 * direct child of `bin/`, beside ffmpeg.
 *
 * Exits non-zero (and removes the partial file) when the download is incomplete
 * or fails the size / sha256 check.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '2026.08.19';
export const ASSET = 'yt-dlp.exe';
export const URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${ASSET}`;

/**
 * Expected byte size of the official asset.
 *
 * Measured 2026-10-19 from the real artifact — do not re-derive from a doc.
 */
export const EXPECTED_SIZE = 17840399;
/**
 * sha256 of the official asset, measured on this machine for 2026.08.19.
 * The release publishes no checksum file, so this pin is what makes a swapped
 * or truncated asset detectable. Set to '' to skip the check.
 */
export const EXPECTED_SHA256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `--out` is returned as written (not resolved) so callers can assert the
 * literal value; `main()` resolves it before touching the filesystem. The
 * default is already absolute.
 */
export function parseArgs(argv) {
  let out = join(here, 'bin', ASSET);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[i + 1];
  }
  return { out };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const target = resolve(out);

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (err) {
    // Some sandboxes deny mkdir even for the owner; the caller may pre-create it.
    if (!statSync(dirname(target), { throwIfNoEntry: false })) {
      console.error(`Cannot create ${dirname(target)}: ${err.message}`);
      console.error('Create the directory with pwsh first, then re-run this script.');
      process.exit(2);
    }
  }

  console.log(`asset:    ${ASSET}`);
  console.log(`url:      ${URL}`);
  console.log(`target:   ${target}`);

  let res;
  try {
    res = await fetch(URL, { redirect: 'follow' });
  } catch (err) {
    console.error(`fetch failed: ${err.message}`);
    process.exit(3);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    process.exit(3);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`received: ${buf.length} bytes`);

  if (buf.length !== EXPECTED_SIZE) {
    console.error(`size mismatch: expected ${EXPECTED_SIZE}, got ${buf.length}`);
    process.exit(4);
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  console.log(`sha256:   ${sha256}`);
  if (EXPECTED_SHA256 && sha256 !== EXPECTED_SHA256) {
    console.error(`sha256 mismatch: expected ${EXPECTED_SHA256}`);
    process.exit(5);
  }

  // Write to a temp name first so a crash never leaves a half-written "valid" exe.
  const tmp = `${target}.part`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, buf);
    rmSync(target, { force: true });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`could not write ${target}: ${err.message}`);
    process.exit(6);
  }

  console.log(`ok:       ${target} (${statSync(target).size} bytes)`);
  console.log(`verify:   "${target}" --version   # expect: ${VERSION}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
