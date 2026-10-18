/**
 * App-settings storage tests (`src/core/appsettings.ts`).
 *
 * The download module persists two things across runs: the Spotify `sp_dc`
 * cookie (a secret — never echoed back) and the default destination folder.
 * Every test injects its own `baseDirs` so nothing here touches the real
 * %LOCALAPPDATA% config.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import {
  maskCookie,
  readDownloadSettings,
  writeDownloadSettings,
} from '../src/core/appsettings.ts';

let counter = 0;
function tempBase(tag: string): string {
  counter += 1;
  const dir = join(tmpdir(), `aus-settings-${tag}-${Date.now().toString(36)}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('missing config file reads as defaults', () => {
  const dir = tempBase('missing');
  const s = readDownloadSettings([dir]);
  assertEq(s, { spotifyCookie: null, destination: null }, 'missing file must read as defaults');
});

test('roundtrip: write then read back cookie and destination', () => {
  const a = tempBase('roundtrip-a');
  const b = tempBase('roundtrip-b');
  writeDownloadSettings(
    { spotifyCookie: 'sp_dc=abcdef123456', destination: 'D:\\Music' },
    [a, b],
  );
  // The first candidate is the write target.
  const raw = JSON.parse(readFileSync(join(a, 'config.json'), 'utf8')) as {
    download: { spotifyCookie?: string; destination?: string };
  };
  assertEq(raw.download.spotifyCookie, 'sp_dc=abcdef123456', 'write target must hold the cookie');
  assertEq(raw.download.destination, 'D:\\Music', 'write target must hold the destination');
  const s = readDownloadSettings([a, b]);
  assertEq(s, { spotifyCookie: 'sp_dc=abcdef123456', destination: 'D:\\Music' }, 'roundtrip must preserve both values');
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('later candidate is used when the first has no file', () => {
  const a = tempBase('fallback-a');
  const b = tempBase('fallback-b');
  writeDownloadSettings({ destination: 'E:\\USB' }, [b]);
  const s = readDownloadSettings([a, b]);
  assertEq(s, { spotifyCookie: null, destination: 'E:\\USB' }, 'fallback candidate must be consulted');
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('corrupt config file falls back to defaults instead of throwing', () => {
  const a = tempBase('corrupt');
  writeFileSync(join(a, 'config.json'), '{ this is not json', 'utf8');
  const s = readDownloadSettings([a]);
  assertEq(s, { spotifyCookie: null, destination: null }, 'corrupt file must read as defaults');
  rmSync(a, { recursive: true, force: true });
});

test('a write preserves unknown sibling keys in config.json', () => {
  const a = tempBase('siblings');
  writeFileSync(
    join(a, 'config.json'),
    JSON.stringify({ someOtherSection: { keep: true }, download: { spotifyCookie: 'sp_dc=keepme9999' } }),
    'utf8',
  );
  writeDownloadSettings({ destination: 'F:\\New' }, [a]);
  const raw = JSON.parse(readFileSync(join(a, 'config.json'), 'utf8')) as {
    someOtherSection?: { keep?: boolean };
    download: { spotifyCookie?: string; destination?: string };
  };
  assert(raw.someOtherSection?.keep === true, 'unknown sibling section must survive a settings write');
  assertEq(raw.download.spotifyCookie, 'sp_dc=keepme9999', 'untouched cookie must survive a partial write');
  assertEq(raw.download.destination, 'F:\\New', 'partial write must set the named value');
  rmSync(a, { recursive: true, force: true });
});

test('maskCookie hides everything but the last four characters', () => {
  assertEq(maskCookie('sp_dc=abcdef123456'), 'sp_dc=****3456', 'long cookie masks all but last four');
  const masked = maskCookie('sp_dc=abcdef123456');
  assert(!masked.includes('abcdef123456'), 'masked hint must not contain the raw secret');
  // Short or empty values collapse to a bare mask rather than leaking length hints.
  assertEq(maskCookie('sp_dc=ab'), '****', 'short cookie collapses to a bare mask');
  assertEq(maskCookie(''), '****', 'empty cookie collapses to a bare mask');
});
