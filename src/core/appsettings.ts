/**
 * Persistent app settings for the download module.
 *
 * One JSON file, `config.json`, holds every setting the engine remembers
 * between runs. It lives under the first writable candidate of:
 *
 *   1. %LOCALAPPDATA%/AudioUsbStudio   (per-user, the normal place)
 *   2. %APPDATA%/AudioUsbStudio        (roaming fallback)
 *
 * The same candidate-order philosophy as `approot.ts`: try candidates in
 * order, first one that works wins, and every function accepts an explicit
 * `baseDirs` override so tests never touch the real profile.
 *
 * The download settings carry the Spotify `sp_dc` cookie — a secret. It is
 * stored here because the download providers need it on every run, but it is
 * never logged and never returned over HTTP: the API answers with
 * `maskCookie()`'s hint (`sp_dc=****3456`) only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DownloadSettings {
  spotifyCookie: string | null;
  destination: string | null;
}

const CONFIG_DIR_NAME = 'AudioUsbStudio';
const CONFIG_FILE = 'config.json';

/** Candidate directories that may hold config.json, in preference order. */
export function configBaseDirs(): string[] {
  const dirs: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (localAppData) dirs.push(join(localAppData, CONFIG_DIR_NAME));
  if (appData && appData !== localAppData) dirs.push(join(appData, CONFIG_DIR_NAME));
  return dirs;
}

/** Parse one candidate's config.json; null when missing or corrupt. */
function readConfigFile(baseDir: string): Record<string, unknown> | null {
  const file = join(baseDir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt file — treat as absent; the next write replaces it wholesale */
  }
  return null;
}

/** Extract the `download` section of a config object, tolerating junk. */
function downloadSection(cfg: Record<string, unknown>): Record<string, unknown> {
  const section = cfg.download;
  if (section && typeof section === 'object' && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function asCleanString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Read the download settings.
 *
 * Candidates are consulted in order and the first one that HAS a readable
 * config.json wins entirely — later candidates are fallbacks for installs
 * where the preferred directory does not exist yet, not merge sources.
 */
export function readDownloadSettings(baseDirs?: string[]): DownloadSettings {
  for (const dir of baseDirs ?? configBaseDirs()) {
    const cfg = readConfigFile(dir);
    if (!cfg) continue;
    const section = downloadSection(cfg);
    return {
      spotifyCookie: asCleanString(section.spotifyCookie),
      destination: asCleanString(section.destination),
    };
  }
  return { spotifyCookie: null, destination: null };
}

/**
 * Merge `patch` into the stored download settings and write them.
 *
 * Writes go to the first candidate (created if needed). Values already stored
 * — including unknown sibling sections another feature may keep in the same
 * file — survive untouched unless the patch explicitly names them; a patch
 * field of `null` clears that value.
 */
export function writeDownloadSettings(
  patch: { spotifyCookie?: string | null; destination?: string | null },
  baseDirs?: string[],
): void {
  const dirs = baseDirs ?? configBaseDirs();
  const target = dirs[0] ?? join(CONFIG_DIR_NAME);
  mkdirSync(target, { recursive: true });

  // Seed the merge from whatever config already exists (any candidate), so a
  // write does not silently drop a section that lived in the fallback file.
  let existing: Record<string, unknown> = {};
  for (const dir of dirs) {
    const cfg = readConfigFile(dir);
    if (cfg) {
      existing = cfg;
      break;
    }
  }

  const section: Record<string, unknown> = { ...downloadSection(existing) };
  if ('spotifyCookie' in patch) {
    if (patch.spotifyCookie === null) delete section.spotifyCookie;
    else section.spotifyCookie = patch.spotifyCookie;
  }
  if ('destination' in patch) {
    if (patch.destination === null) delete section.destination;
    else section.destination = patch.destination;
  }

  const next: Record<string, unknown> = { ...existing, download: section };
  writeFileSync(join(target, CONFIG_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/**
 * A safe display hint for a stored secret: keep the scheme prefix and the
 * last four characters, mask the rest. Anything too short to safely hint
 * collapses to a bare mask.
 */
export function maskCookie(cookie: string): string {
  if (!cookie) return '****';
  const eq = cookie.indexOf('=');
  if (eq > 0 && eq <= 10) {
    const rest = cookie.slice(eq + 1);
    if (rest.length >= 4) return `${cookie.slice(0, eq + 1)}****${rest.slice(-4)}`;
  }
  return '****';
}
