#!/usr/bin/env node
/**
 * Assemble the portable desktop release.
 *
 * The release is a folder, not an installer: copying it anywhere — a USB stick
 * included — is the whole install. It has exactly two layers, and the shape is
 * load-bearing:
 *
 *   AudioUsbStudio.exe                  the shell (its own window, no console)
 *   engine\AudioUsbStudio.Engine.exe    the unchanged Node engine
 *   engine\bin\...                      ffmpeg / ffprobe / deep-filter
 *
 * The engine finds its tools through `dirname(process.execPath)`, so putting the
 * engine and its `bin\` together under `engine\` keeps every path in
 * `src/core/ffbin.ts` and `src/core/denoise.ts` correct with no change at all.
 * Renaming the engine's executable is safe for the same reason: the launcher
 * reads the directory it sits in, never its own file name.
 *
 * Both halves are built by their own scripts (`tools/build-exe.mjs` for the
 * engine, `desktop/build-shell.mjs` for the window). This script only arranges
 * them and refuses to hand over an incomplete folder.
 *
 * Usage: node tools/build-desktop-release.mjs [--skip-engine] [--out <dir>] [--version <v>]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unblockTree } from './unblock-release.mjs';
import {
  EXPECTED_SHA256,
  EXPECTED_SIZE,
  VERSION as YTDLP_VERSION,
} from './fetch-ytdlp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Bumped when the desktop shell ships; the engine keeps its own version. */
const DEFAULT_VERSION = '0.2.0';

const log = (msg) => process.stdout.write(`${msg}\n`);

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function run(cmd, args) {
  // stdio must be inherited, not piped: this sandbox refuses piped child stdio.
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Every file under `dir`, relative to it, with its size. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of walk(full)) out.push([join(entry.name, nested[0]), nested[1]]);
    } else if (entry.isFile()) {
      out.push([entry.name, statSync(full).size]);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const version = flag(argv, 'version') ?? DEFAULT_VERSION;
const skipEngine = argv.includes('--skip-engine');
const outDir = resolve(
  ROOT,
  flag(argv, 'out') ?? join('dist', `AudioUsbStudio-${version}-win-x64`),
);

const engineRelease = join(ROOT, 'release');
const shellBuild = join(ROOT, 'build', 'shell');

if (!skipEngine) {
  log('[1/4] building the engine (tools/build-exe.mjs)');
  run(process.execPath, [join(HERE, 'build-exe.mjs')]);
} else {
  log('[1/4] reusing the existing engine (--skip-engine)');
}

log('[2/4] building the desktop shell (desktop/build-shell.mjs)');
run(process.execPath, [join(ROOT, 'desktop', 'build-shell.mjs')]);

for (const [label, path] of [
  ['engine release', engineRelease],
  ['shell build', shellBuild],
]) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

log(`[3/4] assembling ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'engine', 'bin'), { recursive: true });

// The shell decides which named files it needs; copy the directory wholesale so a
// new runtime asset cannot be forgotten here.
cpSync(shellBuild, outDir, { recursive: true });

// The engine keeps its own name on disk only inside release\; from here on it is
// the engine, and the shell looks for precisely this name.
cpSync(
  join(engineRelease, 'AudioUsbStudio.exe'),
  join(outDir, 'engine', 'AudioUsbStudio.Engine.exe'),
);
cpSync(join(engineRelease, 'bin'), join(outDir, 'engine', 'bin'), { recursive: true });

const readme = `Audio USB Studio ${version} — portable
========================================

Double-click AudioUsbStudio.exe. Its own window opens; the editor appears in it
as soon as the engine behind it answers. No console window, no browser.

WHAT IS IN HERE
  AudioUsbStudio.exe                 the desktop window
  engine\\AudioUsbStudio.Engine.exe   the audio engine (Node, single executable)
  engine\\bin\\ffmpeg.exe             decode / encode for 50+ formats
  engine\\bin\\ffprobe.exe            format and tag inspection
  engine\\bin\\deep-filter.exe        optional AI denoise (single tracks, manual only)

NOTHING TO INSTALL
Copy this whole folder wherever you like — a USB stick works. Keep its shape:
the engine\\ folder must stay beside AudioUsbStudio.exe.

FIRST RUN: WINDOWS MAY WARN
This build is not code-signed, so SmartScreen may say "Windows protected your PC".
Choose "More info", then "Run anyway". That warning is about the missing
signature, not about anything the program does.

If you would rather not click through it, this build ships with nothing carrying
Windows' "downloaded from the internet" tag — but a copy that travelled through a
browser, a chat app or a zip can pick that tag up again. Clear it with:

    unblock.cmd

or, from a PowerShell window in this folder:

    Get-ChildItem -Recurse | Unblock-File

That is the same as right-clicking a file, choosing Properties and ticking
"Unblock". No administrator needed, and it changes nothing but the tag.

IF NO WINDOW APPEARS
Double-click diagnose.cmd. It keeps its window open and prints where every file
is, whether the engine can write a working directory, and whether ffmpeg runs —
which is the whole picture for a machine that refuses to start the program.

The same check from a command prompt in this folder:

    engine\\AudioUsbStudio.Engine.exe doctor

That checks ffmpeg, ffprobe and AI denoise, and prints exactly what it found.
The shell also writes its own failures to:

    %LOCALAPPDATA%\\AudioUsbStudio\\shell-error.log
    %LOCALAPPDATA%\\AudioUsbStudio\\engine.log

THE ENGINE WITHOUT THE WINDOW
The engine is a full command-line tool on its own — useful for scripting a
music USB without opening anything:

    engine\\AudioUsbStudio.Engine.exe doctor
    engine\\AudioUsbStudio.Engine.exe probe  "C:\\Music\\song.flac"
    engine\\AudioUsbStudio.Engine.exe batch  "C:\\Music" --out E:\\ --preset usb --dedup
    engine\\AudioUsbStudio.Engine.exe help

BATCH USES SPEECH-SAFE DENOISE ONLY
Batch normalisation applies gentle afftdn plus adeclick. DeepFilterNet is a
speech model: measured on music it removes about 28 dB of the music along with
about 49 dB of the noise, so it is never part of a batch. It is available per
track, by hand, from the engine CLI.

Format support: over 50 containers, 6 kHz to 192 kHz sample rates. Sample-rate
conversion and MP3 encoding happen only where the target preset requires them.
`;

// Repair tool for a copy that picked the download tag back up in transit. Kept
// deliberately dumb: it must work on a machine where nothing else has been set up.
const unblockCmd = `@echo off
rem Clear the "downloaded from the internet" tag Windows puts on files.
rem While it is set, SmartScreen shows "Windows protected your PC" for each one.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File | Unblock-File"
echo.
echo Done. You can double-click AudioUsbStudio.exe now.
pause
`;

log('[4/5] writing README.txt and checking the layout');
writeFileSync(join(outDir, 'README.txt'), readme, 'utf8');

// A double-clickable report. The point is that a machine which refuses to start the
// program can still describe itself in one step, without the user having to find a
// command prompt — and that the window stays open long enough to copy the output.
const diagnoseCmd = `@echo off
rem Reads only. Prints everything needed to explain a startup failure, then waits.
setlocal
cd /d "%~dp0"

echo === Audio USB Studio diagnostics ===
echo    %DATE% %TIME%
echo.

echo --- required files ---
for %%F in (
  "AudioUsbStudio.exe"
  "engine\\AudioUsbStudio.Engine.exe"
  "engine\\bin\\ffmpeg.exe"
  "engine\\bin\\ffprobe.exe"
  "engine\\bin\\deep-filter.exe"
) do (
  if exist %%F (echo   OK      %%~F) else (echo   MISSING %%~F)
)

echo.
echo --- downloaded-file tags (these are what make SmartScreen complain) ---
powershell -NoProfile -Command "$t = @(Get-ChildItem -LiteralPath '.' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }); if ($t.Count -eq 0) { 'none' } else { $t | ForEach-Object { $_.FullName } }"

echo.
echo --- engine doctor ---
"engine\\AudioUsbStudio.Engine.exe" doctor
echo   (doctor exit code: %ERRORLEVEL%)

echo.
echo --- logs, if any were written ---
if exist "engine\\AudioUsbStudio-error.log" type "engine\\AudioUsbStudio-error.log"
if exist "%LOCALAPPDATA%\\AudioUsbStudio\\shell-error.log" type "%LOCALAPPDATA%\\AudioUsbStudio\\shell-error.log"
if exist "%LOCALAPPDATA%\\AudioUsbStudio\\engine.log" type "%LOCALAPPDATA%\\AudioUsbStudio\\engine.log"

echo.
echo Copy everything above and send it back.
echo.
pause
`;
writeFileSync(join(outDir, 'diagnose.cmd'), diagnoseCmd, 'utf8');
writeFileSync(join(outDir, 'unblock.cmd'), unblockCmd, 'utf8');

const required = [
  'AudioUsbStudio.exe',
  'README.txt',
  'diagnose.cmd',
  join('engine', 'AudioUsbStudio.Engine.exe'),
  join('engine', 'bin', 'ffmpeg.exe'),
  join('engine', 'bin', 'ffprobe.exe'),
  join('engine', 'bin', 'deep-filter.exe'),
  join('engine', 'bin', 'yt-dlp.exe'),
];

const missing = required.filter((rel) => !existsSync(join(outDir, rel)));
if (missing.length > 0) {
  for (const rel of missing) log(`MISSING ${rel}`);
  log(`\nthe release is incomplete: ${missing.length} required file(s) missing`);
  process.exit(1);
}

// The downloader is the one shipped binary that is fetched rather than built, so
// a copy could silently be the wrong build — a stale pin, a partial download, or
// a file someone replaced by hand. Verify the bytes against the same pin
// tools/fetch-ytdlp.mjs enforces, and refuse to ship a mismatch.
{
  const shipped = join(outDir, 'engine', 'bin', 'yt-dlp.exe');
  const bytes = readFileSync(shipped);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sizeOk = bytes.length === EXPECTED_SIZE;
  const hashOk = EXPECTED_SHA256 === '' || sha256 === EXPECTED_SHA256;
  log(`\nyt-dlp.exe  ${YTDLP_VERSION}  ${human(bytes.length)}`);
  log(`  FOUND  engine\\bin\\yt-dlp.exe`);
  log(`  size   ${sizeOk ? 'match' : `MISMATCH — the pin says ${EXPECTED_SIZE}`}`);
  log(`  sha256 ${EXPECTED_SHA256 === '' ? '(unpinned)' : hashOk ? 'match' : 'MISMATCH'}`);
  if (!sizeOk || !hashOk) {
    log('\nthe downloader does not match the pin in tools/fetch-ytdlp.mjs');
    log('re-run `node tools/fetch-ytdlp.mjs`, or update the pin if the bump was intentional');
    process.exit(1);
  }
}

log('[5/5] clearing the download tag so SmartScreen stays quiet');
const unblocked = unblockTree(outDir);

const files = walk(outDir).sort((a, b) => b[1] - a[1]);
const total = files.reduce((sum, [, size]) => sum + size, 0);

log(`\n${outDir}`);
log(`${files.length} files, ${human(total)} total\n`);
log('  size        file');
for (const [rel, size] of files.slice(0, 14)) {
  log(`  ${human(size).padStart(10)}  ${rel}`);
}
if (files.length > 14) log(`  ${'...'.padStart(10)}  (+${files.length - 14} more)`);

log(`\nunblocked ${unblocked.cleared} of ${unblocked.scanned} file(s)`);
for (const r of unblocked.refused) {
  log(`  warn: could not untag ${r.file}: ${r.message}`);
}

const expectedMb = 611;
const actualMb = total / (1024 * 1024);
log(`\ntotal ${actualMb.toFixed(1)} MB (spec expects about ${expectedMb} MB)`);
if (Math.abs(actualMb - expectedMb) > 20) {
  log(`WARNING: size is more than 20 MB away from the estimate`);
}
