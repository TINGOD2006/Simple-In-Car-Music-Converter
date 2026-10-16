#!/usr/bin/env node
/**
 * Builds the desktop shell (C# WinForms + WebView2) into build/shell.
 *
 * Two things about this environment shape the whole script:
 *
 * 1. NuGet cannot reach nuget.org. The .NET HTTP stack fails with
 *    `NU1301 The SSL connection could not be established`, while node's fetch works
 *    fine. So every package is pre-fetched into desktop/nuget-local and NuGet is
 *    pointed at that folder as its ONLY source. The build is then reproducible and
 *    works with no network at all once the cache is warm.
 *
 * 2. Child-process stdio must not be piped (this sandbox rejects it with EPERM), so
 *    dotnet's output is routed through a file descriptor we open ourselves and then
 *    read back.
 *
 * Usage: node desktop/build-shell.mjs [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../AudioUsbStudio/desktop
const ROOT = resolve(HERE, '..');

function flagValue(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = resolve(flagValue('out', join(ROOT, 'build', 'shell')));
const nugetDir = join(HERE, 'nuget-local');
const packagesCache = join(ROOT, 'build', 'nuget-packages');
const logPath = join(ROOT, 'build', 'shell-build.log');

// ---------------------------------------------------------------- NuGet packages

const { packages } = JSON.parse(readFileSync(join(HERE, 'nuget-packages.json'), 'utf8'));
mkdirSync(nugetDir, { recursive: true });

for (const pkg of packages) {
  const file = join(nugetDir, `${pkg.id.toLowerCase()}.${pkg.version}.nupkg`);
  if (existsSync(file)) {
    console.log(`  cached  ${pkg.id} ${pkg.version}`);
    continue;
  }
  const url = `https://www.nuget.org/api/v2/package/${pkg.id}/${pkg.version}`;
  console.log(`  fetch   ${pkg.id} ${pkg.version}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`FAILED  ${url} -> HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  console.log(`  saved   ${pkg.id} ${pkg.version} (${(buf.length / 1048576).toFixed(2)} MB)`);
}

// Local-only source. <clear /> matters: without it NuGet keeps nuget.org in the list and
// the restore fails on the unreachable source even though every package is present here.
writeFileSync(
  join(HERE, 'NuGet.config'),
  `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="${nugetDir}" />
  </packageSources>
</configuration>
`,
);

// ---------------------------------------------------------------- publish

mkdirSync(dirname(logPath), { recursive: true });
rmSync(outDir, { recursive: true, force: true });

const args = [
  'publish', join(HERE, 'AudioUsbStudio.Shell.csproj'),
  '-c', 'Release',
  '-r', 'win-x64',
  '--self-contained', 'true',
  '-p:PublishSingleFile=false',
  '--nologo',
  '-o', outDir,
];

console.log(`  dotnet  dotnet ${args.join(' ')}`);

const fd = openSync(logPath, 'w');
const code = await new Promise((done) => {
  const child = spawn('dotnet', args, {
    cwd: HERE,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      NUGET_PACKAGES: packagesCache,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    },
  });
  child.on('error', (err) => {
    writeFileSync(logPath, `\nspawn error: ${err.message}`, { flag: 'a' });
    done(-1);
  });
  child.on('close', (c) => done(c));
});
closeSync(fd);

console.log(`  dotnet exit ${code}`);

if (code !== 0) {
  const log = readFileSync(logPath, 'utf8');
  console.error('--- dotnet output (tail) ---');
  console.error(log.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n'));
  console.error(`--- full log: ${logPath} ---`);
  process.exit(1);
}

if (!existsSync(join(outDir, 'AudioUsbStudio.exe'))) {
  console.error(`FAILED  publish succeeded but ${join(outDir, 'AudioUsbStudio.exe')} is missing`);
  process.exit(1);
}

console.log(`  out     ${outDir}`);
console.log(`  log     ${logPath}`);
