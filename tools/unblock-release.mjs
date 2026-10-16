#!/usr/bin/env node
/**
 * Strip the Mark-of-the-Web from a release folder.
 *
 * Windows tags every file that arrived from the internet with an NTFS alternate
 * data stream called `Zone.Identifier`. A tagged executable is what Microsoft
 * Defender SmartScreen shows "Windows protected your PC" for, and the tag
 * survives being copied, zipped and unzipped — so a release can be assembled
 * entirely on this machine and still be flagged, as long as one of its pieces was
 * downloaded here. That is exactly what happened to `engine/bin/ffmpeg.exe` and
 * `engine/bin/ffprobe.exe`, which the build fetches from gyan.dev.
 *
 * Removing the stream is what "Unblock" in a file's Properties dialog does, and
 * it needs no certificate and no administrator. `DeleteFileW` removes an
 * alternate data stream when the path carries a colon-suffixed stream name, and
 * Node passes the path straight through, so `unlinkSync` is enough.
 *
 * Usage:
 *   node tools/unblock-release.mjs <dir> [--quiet]
 *
 * Exits 0 whether or not anything was tagged: a clean folder is the goal, not an
 * error.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The stream Windows writes the download zone into. */
const MOTW_STREAM = ':Zone.Identifier';

/** Every file under `root`, recursively, without following symlinks. */
function walk(root) {
  const out = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

/**
 * Removes the download tag from every file under `root`.
 *
 * Returns the counts rather than throwing on the first refusal: a file that is
 * open in another process cannot be unblocked, and that must not abort a release
 * build that is otherwise fine.
 */
export function unblockTree(root) {
  const files = walk(root);
  const refused = [];
  let cleared = 0;

  for (const file of files) {
    try {
      unlinkSync(file + MOTW_STREAM);
      cleared += 1;
    } catch (err) {
      // ENOENT means the file carried no tag, which is the normal case.
      if (err.code !== 'ENOENT') refused.push({ file, message: err.message });
    }
  }

  return { scanned: files.length, cleared, refused };
}

function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  const target = argv.find((a) => !a.startsWith('--'));

  if (!target) {
    process.stderr.write('usage: node tools/unblock-release.mjs <dir> [--quiet]\n');
    process.exit(1);
  }

  if (!statSync(target).isDirectory()) {
    process.stderr.write(`not a directory: ${target}\n`);
    process.exit(1);
  }

  const { scanned, cleared, refused } = unblockTree(target);

  if (!quiet) {
    process.stdout.write(`  unblock  ${scanned} file(s) scanned, ${cleared} tag(s) removed\n`);
    for (const r of refused) {
      process.stdout.write(`  warn     could not untag ${r.file}: ${r.message}\n`);
    }
  }

  // A refusal is reported but not fatal: the app still runs, Windows just asks
  // once more about that particular file.
  return refused.length > 0 ? 0 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
