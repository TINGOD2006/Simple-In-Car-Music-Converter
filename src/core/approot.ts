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

import { dirname, join } from 'node:path';
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
