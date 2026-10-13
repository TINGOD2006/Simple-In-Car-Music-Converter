#!/usr/bin/env node
/**
 * Download the DeepFilterNet CLI binary (`deep-filter.exe`) from the official
 * GitHub release and verify it.
 *
 * WHY A NODE SCRIPT AND NOT curl / Invoke-WebRequest
 * --------------------------------------------------
 * Measured in this project's sandbox: PowerShell's `curl`, `Invoke-WebRequest`
 * and .NET `HttpClient` all fail against GitHub release redirects, while Node's
 * global `fetch` succeeds. So the one download path that works is this script.
 *
 * The 27 MB binary is deliberately NOT committed. Run this once per machine:
 *
 *   node tools/fetch-deep-filter.mjs
 *   node tools/fetch-deep-filter.mjs --out C:\some\dir\deep-filter.exe
 *
 * Exits non-zero (and removes the partial file) when the download is incomplete
 * or fails the size / sha256 check.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.5.6';
const ASSET = `deep-filter-${VERSION}-x86_64-pc-windows-msvc.exe`;
const URL = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${VERSION}/${ASSET}`;

/** Expected byte size of the official asset. */
const EXPECTED_SIZE = 26912256;
/**
 * sha256 of the official asset, verified on this machine for v0.5.6.
 * The release publishes no checksum file, so this pin is what makes a swapped or
 * truncated asset detectable. Set to '' to skip the check.
 */
const EXPECTED_SHA256 = '75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let out = join(here, 'bin', 'deep-filter.exe');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[i + 1];
    else if (argv[i] === '--version' && argv[i + 1]) out = out; // documented no-op
  }
  return { out: resolve(out) };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));

  try {
    mkdirSync(dirname(out), { recursive: true });
  } catch (err) {
    // Some sandboxes deny mkdir even for the owner; the caller may pre-create it.
    if (!statSync(dirname(out), { throwIfNoEntry: false })) {
      console.error(`Cannot create ${dirname(out)}: ${err.message}`);
      console.error('Create the directory with pwsh first, then re-run this script.');
      process.exit(2);
    }
  }

  console.log(`asset:    ${ASSET}`);
  console.log(`url:      ${URL}`);
  console.log(`target:   ${out}`);

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
  const tmp = `${out}.part`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, buf);
    rmSync(out, { force: true });
    renameSync(tmp, out);
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`could not write ${out}: ${err.message}`);
    process.exit(6);
  }

  console.log(`ok:       ${out} (${statSync(out).size} bytes)`);
  console.log(`verify:   "${out}" --version   # expect: deep_filter ${VERSION}`);
}

await main();
