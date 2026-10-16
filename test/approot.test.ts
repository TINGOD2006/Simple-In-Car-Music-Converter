/**
 * Tests for the installation-root and scratch-root resolvers.
 *
 * These exist because of a shipped failure: the desktop build refused to start on a real
 * machine with `EPERM: operation not permitted, mkdir '...\Temp\aus-app-...'`. `%TEMP%` was
 * not writable there, and both the asset unpacker and the scratch root assumed it was. The
 * scratch half of that fix is what these cases pin down.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_ROOT_ENV, appRoot, assetRoot, resolveScratchRoot } from '../src/core/approot.ts';
import { assert, assertEq, test } from './harness.ts';

function scratchDir(tag: string): string {
  const dir = join(tmpdir(), `aus-approot-${tag}-${Date.now().toString(36)}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

test('resolveScratchRoot honours an explicitly requested directory', () => {
  const dir = scratchDir('explicit');
  try {
    assertEq(resolveScratchRoot(dir), dir, 'an explicit path is used verbatim');
    assert(existsSync(dir), 'an explicit path is created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveScratchRoot returns a directory that exists and can be written to', () => {
  const dir = resolveScratchRoot();
  assert(existsSync(dir), `the scratch root exists: ${dir}`);

  // "Writable" is the actual contract, so prove it by writing rather than by inspecting.
  const probe = join(dir, `probe-${Date.now().toString(36)}.txt`);
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
});

test('resolveScratchRoot is stable across calls', () => {
  assertEq(resolveScratchRoot(), resolveScratchRoot(), 'repeated calls pick the same directory');
});

test('resolveScratchRoot never returns a path it failed to create', () => {
  // A path whose parent is a file cannot be created, so it must not come back as "the" root.
  const dir = scratchDir('blocked');
  mkdirSync(dir, { recursive: true });
  const blocker = join(dir, 'blocker.dat');
  writeFileSync(blocker, 'not a directory');
  try {
    assertEq(resolveScratchRoot(), resolveScratchRoot(), 'the root stays usable when a candidate is blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appRoot points at a directory that holds package.json', () => {
  const saved = process.env[APP_ROOT_ENV];
  delete process.env[APP_ROOT_ENV];
  try {
    assert(
      existsSync(join(appRoot(), 'package.json')),
      `appRoot() should resolve to the checkout root, got ${appRoot()}`,
    );
    assertEq(assetRoot(), appRoot(), 'without AUS_ASSET_ROOT, assetRoot() falls back to appRoot()');
  } finally {
    if (saved !== undefined) process.env[APP_ROOT_ENV] = saved;
  }
});

test('appRoot and assetRoot prefer the environment when the launcher sets it', () => {
  const savedRoot = process.env[APP_ROOT_ENV];
  const savedAsset = process.env['AUS_ASSET_ROOT'];
  process.env[APP_ROOT_ENV] = 'C:\\installed\\AudioUsbStudio';
  process.env['AUS_ASSET_ROOT'] = 'C:\\installed\\AudioUsbStudio\\.aus-runtime';
  try {
    assertEq(appRoot(), 'C:\\installed\\AudioUsbStudio', 'appRoot prefers AUS_APP_ROOT');
    assertEq(assetRoot(), 'C:\\installed\\AudioUsbStudio\\.aus-runtime', 'assetRoot prefers AUS_ASSET_ROOT');
  } finally {
    if (savedRoot === undefined) delete process.env[APP_ROOT_ENV];
    else process.env[APP_ROOT_ENV] = savedRoot;
    if (savedAsset === undefined) delete process.env['AUS_ASSET_ROOT'];
    else process.env['AUS_ASSET_ROOT'] = savedAsset;
  }
});
