/**
 * Test entry point. Runs every `*.test.ts` suite in this directory in one
 * process and exits non-zero on failure.
 *
 * Suites are discovered automatically rather than imported by name, so adding a
 * test file never requires editing this file (and parallel authors never
 * conflict here). `node --test` is unusable in this environment because it
 * spawns child processes, which the sandbox denies with EPERM.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAll } from './harness.ts';

const here = dirname(fileURLToPath(import.meta.url));

const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in ' + here);
  process.exit(1);
}

for (const suite of suites) {
  // A bare Windows path ("C:\...") is read as a URL scheme, so convert it.
  await import(pathToFileURL(join(here, suite)).href);
}

const code = await runAll();
process.exit(code);
