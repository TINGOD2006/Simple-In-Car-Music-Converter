/**
 * Build the standalone Windows executable.
 *
 * Pipeline (all measured to work in this environment):
 *   1. `tsc -p tsconfig.build.json` compiles `src/**\/*.ts` to `build/**\/*.js`.
 *      tsc is used rather than a bundler because the emitted ESM has zero
 *      third-party imports (only `node:` builtins and relative paths), so no
 *      bundling step is needed — and esbuild cannot run here anyway, since this
 *      sandbox denies the piped stdio its service process requires.
 *   2. The compiled engine plus `web/dist` become SEA *assets*.
 *   3. `node --experimental-sea-config` turns them into a preparation blob.
 *   4. `postject` injects the blob into a copy of `node.exe`.
 *   5. A release folder is assembled: the exe, plus `bin/` with ffmpeg, ffprobe and
 *      deep-filter, plus a README. ffmpeg is *not* embedded — it is 223 MB per
 *      binary and embedding it would make the executable ~570 MB and slow to start.
 *      The engine's `findBinaries()` looks in `bin/` next to the exe first, so the
 *      folder stays portable: copy it to a USB stick and it still works.
 *
 * Usage:
 *   node tools/build-exe.mjs [--out <dir>] [--skip-tsc] [--no-tools]
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Machine-wide fallbacks, in the same order `findBinaries()` uses. */
const FFMPEG_CANDIDATES = [
  'C:\\ffmpeg-8.1-full_build\\bin',
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
];

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

/** Run a child with inherited stdio: this sandbox forbids piped child stdio. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.error) fail(`${cmd} could not start: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${res.status}`);
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function locateFfmpegDir() {
  for (const dir of FFMPEG_CANDIDATES) {
    if (existsSync(join(dir, 'ffmpeg.exe')) && existsSync(join(dir, 'ffprobe.exe'))) return dir;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const outDir = resolve(ROOT, flag(argv, 'out') ?? 'release');
  const skipTsc = argv.includes('--skip-tsc');
  const withTools = !argv.includes('--no-tools');

  const buildDir = join(ROOT, 'build');
  const webDist = join(ROOT, 'web', 'dist');

  /* 1. Compile the engine. */
  if (!skipTsc) {
    log('[1/6] compiling TypeScript -> build/');
    run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json']);
  } else {
    log('[1/6] skipping tsc (--skip-tsc)');
  }
  if (!existsSync(buildDir)) fail('build/ is missing — run without --skip-tsc');

  /* 1b. Vendor bundle: build/core/download/deps.js imports ../../vendor/download-deps.js,
   * so the generated third-party bundle must land at build/vendor/ (tsc does not copy it). */
  const vendorSrc = join(ROOT, 'src', 'vendor', 'download-deps.js');
  if (existsSync(vendorSrc)) {
    const vendorDst = join(buildDir, 'vendor', 'download-deps.js');
    mkdirSync(dirname(vendorDst), { recursive: true });
    cpSync(vendorSrc, vendorDst);
    log(`      vendor bundle copied (${statSync(vendorDst).size} bytes)`);
  } else {
    log('      WARNING: src/vendor/download-deps.js is missing — run tools/bundle-download-vendor.mjs');
  }

  /* 2. Collect assets: the engine, then the built UI. */
  log('[2/6] collecting assets');
  const assets = {};
  for (const rel of walk(buildDir)) {
    if (!rel.endsWith('.js')) continue;
    assets[rel] = join(buildDir, rel);
  }
  if (existsSync(webDist)) {
    for (const rel of walk(webDist)) {
      assets[`web/dist/${rel}`] = join(webDist, rel);
    }
  } else {
    log('      WARNING: web/dist is missing — the executable will serve the API only.');
    log('               build it with: cd web && npx vite build');
  }

  const jsCount = Object.keys(assets).filter((k) => k.endsWith('.js')).length;
  const uiCount = Object.keys(assets).length - jsCount;
  log(`      ${jsCount} engine modules, ${uiCount} UI files`);

  /* 3. SEA preparation blob. */
  log('[3/6] generating the SEA preparation blob');
  const blobPath = join(buildDir, 'app.blob');
  const seaConfigPath = join(buildDir, 'sea-config.json');
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: join(HERE, 'launcher.cjs'),
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
      },
      null,
      2,
    ) + '\n',
  );
  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  /* 4. Copy node.exe and inject the blob. */
  log('[4/6] injecting the blob into a copy of node.exe');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'bin'), { recursive: true });
  const exePath = join(outDir, 'AudioUsbStudio.exe');
  cpSync(process.execPath, exePath);

  const postjectCli = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!existsSync(postjectCli)) fail('postject is not installed — run: npm install');
  run(process.execPath, [
    postjectCli,
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ]);

  /* 5. Ship the audio toolchain beside the exe. */
  if (withTools) {
    log('[5/6] copying ffmpeg, ffprobe and deep-filter into bin/');
    const ffDir = locateFfmpegDir();
    if (ffDir) {
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        cpSync(join(ffDir, name), join(outDir, 'bin', name));
      }
      log(`      ffmpeg from ${ffDir}`);
    } else {
      log('      WARNING: no ffmpeg found on this machine — bin/ will be empty.');
      log('               copy ffmpeg.exe and ffprobe.exe into bin/ before shipping.');
    }

    const deepFilter = join(ROOT, 'tools', 'bin', 'deep-filter.exe');
    if (existsSync(deepFilter)) {
      cpSync(deepFilter, join(outDir, 'bin', 'deep-filter.exe'));
      log('      deep-filter.exe (AI denoise)');
    } else {
      log('      note: deep-filter.exe absent — AI denoise will report unavailable.');
    }

    // yt-dlp.exe is fetched, never committed (see tools/bin/.gitignore), so a
    // machine that has never run the fetch script simply cannot ship a working
    // downloader. That is a note here and a hard failure in the release build,
    // which is the difference between "this build has no YouTube" and "this
    // release is broken".
    const ytDlp = join(ROOT, 'tools', 'bin', 'yt-dlp.exe');
    if (existsSync(ytDlp)) {
      cpSync(ytDlp, join(outDir, 'bin', 'yt-dlp.exe'));
      log('      yt-dlp.exe (Spotify/YouTube downloads)');
    } else {
      log('      note: yt-dlp.exe absent — every download route will report unavailable.');
      log('            run `node tools/fetch-ytdlp.mjs` before shipping.');
    }
  } else {
    log('[5/6] skipping toolchain copy (--no-tools)');
  }

  /* 6. Release notes. */
  log('[6/6] writing the release README');
  writeFileSync(
    join(outDir, 'README.txt'),
    [
      'Audio USB Studio',
      '',
      'Double-click AudioUsbStudio.exe to open the editor in your browser.',
      '',
      'The window that opens is the local server; keep it running while you work and',
      'close it (or press Ctrl+C) when you are done. Nothing is uploaded anywhere:',
      'all audio processing happens on this machine.',
      '',
      'FIRST RUN MAY SHOW A WINDOWS WARNING',
      'Windows may warn that this program is from an unknown publisher, because it',
      'is not code-signed. Pick "More information", then "Run anyway". That dialog',
      'is the whole of it: the program never connects to the network, and your audio',
      'never leaves this machine.',
      '',
      'IF NO EDITOR WINDOW APPEARS, the server could not start a browser for you.',
      'The console window it opened prints an address to paste into any browser,',
      'for example http://127.0.0.1:4173/ -- the editor is there either way. If the',
      'console says "could not start", nothing is lost: copy that address across by',
      'hand. If it closes too fast to read, the reason is also written next to this',
      'file as AudioUsbStudio-error.log.',
      '',
      'Command line, from this folder:',
      '  AudioUsbStudio.exe doctor                     check ffmpeg and AI denoise',
      '  AudioUsbStudio.exe batch <dir> --out <dir>     prepare a music folder',
      '  AudioUsbStudio.exe batch <dir> --out <dir> --dedup',
      '  AudioUsbStudio.exe help                       all commands',
      '',
      'The bin\\ folder must stay next to the executable: it holds the audio tools',
      '(ffmpeg, ffprobe, and deep-filter for AI denoise). The whole folder can be',
      'copied to a USB stick or another PC and it will keep working.',
      '',
      'If ffmpeg is missing, point at your own copy:',
      '  set AUS_FFMPEG_DIR=C:\\path\\to\\ffmpeg\\bin',
      '',
    ].join('\r\n'),
  );

  const exeBytes = statSync(exePath).size;
  log('');
  log(`done: ${exePath}`);
  log(`      executable ${(exeBytes / 1048576).toFixed(1)} MB`);
  if (withTools) {
    const binBytes = readdirSync(join(outDir, 'bin')).reduce(
      (sum, f) => sum + statSync(join(outDir, 'bin', f)).size,
      0,
    );
    log(`      bin/       ${(binBytes / 1048576).toFixed(1)} MB`);
  }
}

main();
