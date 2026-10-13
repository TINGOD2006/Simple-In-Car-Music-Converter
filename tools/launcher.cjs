/**
 * Audio USB Studio — packaged executable entry point.
 *
 * This file is the Node single-executable (SEA) *main*. Node requires that main to
 * be CommonJS, which is why this is a `.cjs` file rather than a compiled module
 * from `src/`. It does three things:
 *
 *   1. Extracts the embedded application (`file:server/*.js`, `file:core/*.js`,
 *      `file:cli/*.js`) and the built web UI (`file:web/dist/**`) into a temp
 *      directory, and writes a `{"type":"module"}` marker there so the extracted
 *      `.js` files are loaded as ESM.
 *   2. Sets `AUS_APP_ROOT` (the executable's own directory) and
 *      `AUS_ASSET_ROOT` (the extraction directory). Every path the engine
 *      resolves relative to the installation goes through those two variables, so
 *      ffmpeg / ffprobe / deep-filter.exe are found *beside the exe* and the UI is
 *      found in the extraction directory — never relative to this file, which lives
 *      in a temp dir in a packaged build.
 *   3. Dispatches the command line: no arguments starts the GUI (server +
 *      browser), `serve` starts the server without opening a browser, and any known
 *      CLI verb is forwarded to the same `runCli()` the source checkout uses.
 */

'use strict';

const { getAsset, getAssetKeys } = require('node:sea');
const { existsSync, mkdirSync, readSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const VERSION = '0.1.0-m1';

/** CLI verbs forwarded verbatim; anything else opens the GUI. */
const CLI_COMMANDS = new Set([
  'doctor',
  'probe',
  'edit',
  'save-project',
  'render',
  'verify',
  'batch',
  'help',
  '--help',
  '-h',
]);

function exeDir() {
  return dirname(process.execPath);
}

/**
 * Unpack the embedded files into a temp directory and return its path.
 *
 * The directory name carries the app version and the executable's size/mtime, so
 * upgrading the exe extracts into a fresh directory instead of running a stale mix
 * of old and new modules. A `.ready` marker written last makes a half-finished
 * extraction (killed process) redo itself rather than run broken code.
 */
function extractEmbedded() {
  const exe = process.execPath;
  let stamp = VERSION;
  try {
    const st = require('node:fs').statSync(exe);
    stamp += `-${st.size}-${Math.floor(st.mtimeMs)}`;
  } catch {
    /* fall back to the version alone */
  }

  const root = join(tmpdir(), `aus-app-${stamp}`);
  const marker = join(root, '.ready');
  if (existsSync(marker)) return root;

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  // The embedded modules are ESM. Without this marker Node reads `.js` as CJS and
  // every import fails with "Cannot use import statement outside a module".
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');

  for (const key of getAssetKeys()) {
    // Asset keys are relative virtual paths. An earlier build prefixed them with
    // `file:`; accept both spellings so a blob built either way still extracts.
    const rel = key.startsWith('file:') ? key.slice('file:'.length) : key;
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(getAsset(key)));
  }

  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return root;
}

function usage() {
  process.stdout.write(
    [
      `Audio USB Studio ${VERSION}`,
      '',
      'Usage:',
      '  AudioUsbStudio                 open the editor in your browser',
      '  AudioUsbStudio serve [--port N]  start the local server only',
      '  AudioUsbStudio <command> ...    run a command-line task',
      '',
      'Commands:',
      '  doctor                          check ffmpeg, ffprobe and AI denoise',
      '  probe <file...> [--json]',
      '  edit <file> --out <out> [options]',
      '  render <project.json> --out <file>',
      '  verify <file> [--preset usb|flac|wav]',
      '  batch <dir...> --out <dir> [options]',
      '  help                            this text',
      '',
      'Options:',
      '  --port <n>            GUI/server port (default 4173)',
      '  --ffmpeg-dir <dir>    where ffmpeg.exe and ffprobe.exe live',
      '  --scratch <dir>       scratch directory for ffmpeg reports',
      '',
      'Files shipped next to this executable:',
      '  bin\\ffmpeg.exe  bin\\ffprobe.exe  bin\\deep-filter.exe',
    ].join('\n') + '\n',
  );
}

/**
 * Never settles. `runServer()` resolves as soon as the socket is *listening* — it
 * does not block — so returning from `main()` would let the trailing
 * `process.exit()` tear the server down the instant it printed its banner. The
 * process is meant to stay up until the user stops it (SIGINT/SIGTERM), so the
 * GUI and `serve` paths park here instead of returning.
 */
function forever() {
  return new Promise(() => {});
}

async function main() {
  const args = process.argv.slice(2);

  // `--version` / `-v` answer without extracting anything.
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    process.stdout.write(`Audio USB Studio ${VERSION}\n`);
    return 0;
  }

  if (!args.length || args[0] === '--gui' || args[0] === 'gui') {
    const root = extractEmbedded();
    process.env.AUS_APP_ROOT = exeDir();
    process.env.AUS_ASSET_ROOT = root;
    const mod = await import(pathToFileURL(join(root, 'server', 'main.js')).href);
    await mod.runServer(args.filter((a) => a !== '--gui' && a !== 'gui'), { openBrowser: true });
    return await forever();
  }

  if (args[0] === 'serve') {
    const root = extractEmbedded();
    process.env.AUS_APP_ROOT = exeDir();
    process.env.AUS_ASSET_ROOT = root;
    const mod = await import(pathToFileURL(join(root, 'server', 'main.js')).href);
    await mod.runServer(args.slice(1));
    return await forever();
  }

  if (CLI_COMMANDS.has(args[0])) {
    const root = extractEmbedded();
    process.env.AUS_APP_ROOT = exeDir();
    process.env.AUS_ASSET_ROOT = root;
    const mod = await import(pathToFileURL(join(root, 'cli', 'index.js')).href);
    return await mod.runCli(args);
  }

  process.stderr.write(`ERROR: unknown command "${args[0]}"\n\n`);
  usage();
  return 1;
}

/**
 * Wait for a keypress so a startup error stays on screen.
 *
 * A packaged build is a console application: double-clicking it opens a console,
 * and a process that throws exits at once — the console vanishes and the user sees
 * "nothing happened". Waiting turns an invisible crash into a readable one. Only
 * done when a console is actually attached, so a redirected or scripted run never
 * blocks.
 */
function pauseSoTheErrorCanBeRead() {
  process.stderr.write('\nPress Enter to close this window...');
  try {
    readSync(0, Buffer.alloc(1), 0, 1, null);
  } catch {
    // No readable console: hold the text on screen for a moment instead.
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
    } catch {
      /* nothing further we can do */
    }
  }
}

/**
 * Report a fatal startup error so that it survives a vanishing console.
 *
 * Three channels, because the failure this exists for is exactly the one where the
 * user sees nothing at all: stderr when it is visible, a log file beside the
 * executable so the reason is still recoverable afterwards, and a pause so the text
 * can actually be read.
 */
function reportFatal(err) {
  const detail = err && err.stack ? err.stack : String(err);
  process.stderr.write('\nAudio USB Studio could not start.\n\n');
  process.stderr.write(`${detail}\n`);

  let logPath = null;
  try {
    logPath = join(exeDir(), 'AudioUsbStudio-error.log');
    writeFileSync(logPath, `${new Date().toISOString()}\n${detail}\n`);
  } catch {
    logPath = null;
  }
  if (logPath) process.stderr.write(`\nDetails written to ${logPath}\n`);

  // The one cause a user can actually act on, named in plain words.
  if (/EACCES|EPERM|permission|ENOTDIR/i.test(detail)) {
    process.stderr.write(
      '\nHint: the program could not write to its temporary folder. Check that\n' +
        'your temp directory is writable, or point TMP at one that is.\n',
    );
  }

  if (process.stdout.isTTY) pauseSoTheErrorCanBeRead();
}

main()
  .then((code) => {
    // `serve` and the GUI keep running; only one-shot CLI commands return here.
    if (typeof code === 'number') process.exit(code);
  })
  .catch((err) => {
    reportFatal(err);
    process.exit(1);
  });
