// Task 2 of docs/superpowers/plans/2026-10-18-cross-platform-download.md — vendor bundle + deps façade.
// Re-pinned by Task 8 of docs/superpowers/plans/2026-10-19-youtube-source.md, after
// @distube/ytdl-core and @tnfangel/ytmusic-api were dropped: the façade is now the
// SPOTIFY surface only.
// Pins: (1) the façade surface the download providers compile against,
//       (2) no source file still reaches for the retired vendor YouTube surface,
//       (3) the committed bundle imports ONLY node builtins (+ the single lazy native import),
//       (4) spdl's stream endpoints really are compiled in.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { test, assert, assertEq } from './harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'src', 'vendor', 'download-deps.js');
const srcRoot = path.join(here, '..', 'src');

// Node builtins the bundle is allowed to import (bundled with platform=node, so all of
// these stay external). Anything else appearing as a specifier is a packaging bug:
// node_modules does not ship next to the packaged exe.
const ALLOWED_IMPORTS = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
    'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'fs/promises', 'http',
    'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
    'punycode', 'querystring', 'readline', 'repl', 'sqlite', 'stream', 'string_decoder', 'sys',
    'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
]);
test('deps façade exposes the download surface', async () => {
    const deps = await import('../src/core/download/deps.ts');
    assertEq(typeof deps.createSpotifyClient, 'function', 'createSpotifyClient');
    assertEq(typeof deps.SPDL_FORMATS.includes, 'function', 'SPDL_FORMATS is a list');
    assertEq(typeof deps.SpotifyAuthError, 'function', 'SpotifyAuthError is an error class');
    assertEq(typeof deps.SpotifyStreamError, 'function', 'SpotifyStreamError is an error class');
    assertEq(typeof deps.SpotifyApiError, 'function', 'SpotifyApiError is an error class');
});

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTs(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

test('no source file still reaches for the retired vendor YouTube surface', () => {
    // The packages that provided these were removed, so a lingering reference is
    // not merely dead code — it is a runtime crash waiting for the one caller.
    // NOTE: `YouTubeSongRow` is deliberately NOT in this list. It is now OUR type
    // (src/core/download/sources/youtube.ts); what is retired is importing it from
    // the vendor façade.
    const retiredFns = ['searchYouTubeMusic', 'getYouTubeAudio', 'getYouTubeStream', 'getYouTubeInfo'];
    const offenders: string[] = [];
    for (const file of walkTs(srcRoot)) {
        const text = readFileSync(file, 'utf8');
        const rel = path.relative(srcRoot, file);
        for (const name of retiredFns) {
            if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${rel}: ${name}`);
        }
        // Import statements span lines, so match the whole braced clause rather
        // than a single line.
        for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*(?:vendor\/download-deps\.js|(?:^|[./])deps\.ts)["']/g)) {
            const clause = m[1]!;
            if (/\bYouTubeSongRow\b/.test(clause)) offenders.push(`${rel}: imports YouTubeSongRow from the vendor façade`);
            for (const name of retiredFns) {
                if (new RegExp(`\\b${name}\\b`).test(clause)) offenders.push(`${rel}: re-exports ${name} from the vendor façade`);
            }
        }
    }
    assertEq(offenders.join(', '), '', 'the vendor YouTube surface is retired, not just unreferenced');
});

test('SPDL format list covers the vorbis ladder plus the lossy fallbacks', async () => {
    const deps = await import('../src/core/download/deps.ts');
    for (const format of ['OGG_VORBIS_96', 'OGG_VORBIS_160', 'OGG_VORBIS_320', 'MP3_96', 'MP4_128', 'MP4_256']) {
        assert(deps.SPDL_FORMATS.includes(format), `SPDL_FORMATS contains ${format}`);
    }
    assertEq(deps.SPDL_FORMATS.length, 8, 'all eight spdl formats are listed');
});

test('vendor bundle imports nothing but node builtins', () => {
    const src = readFileSync(bundlePath, 'utf8');
    const specifiers = new Set<string>();
    // Real statements only: static from-imports are line-anchored (the output is
    // not minified), and require()/import() calls are guarded against a word
    // char so `x.require(` and string CONTENT (proto parsers, embedded keys)
    // cannot produce phantom specifiers.
    for (const line of src.split('\n')) {
        for (const m of line.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*"([^"]+)"/g)) specifiers.add(m[1]!);
        for (const m of line.matchAll(/(?:^|[^\w.$])import\(\s*"([^"]+)"\s*\)/g)) specifiers.add(m[1]!);
        for (const m of line.matchAll(/(?:^|[^\w.$])(?:__)?require\(\s*"([^"]+)"\s*\)/g)) specifiers.add(m[1]!);
    }
    assert(specifiers.size > 0, 'bundle declares at least one import');
    const offenders: string[] = [];
    for (const spec of specifiers) {
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
        if (bare === 're-unplayplay') continue; // the one deliberate lazy external (native, shipped beside the exe)
        if (!ALLOWED_IMPORTS.has(bare)) offenders.push(spec);
    }
    assertEq(offenders.join(', '), '', 'every bundle import is a node builtin (or the whitelisted native lazy import)');
});

test('the playplay native module stays out of the static import graph', () => {
    const src = readFileSync(bundlePath, 'utf8');
    assertEq(
        (src.match(/from\s*"re-unplayplay"/g) ?? []).length, 0,
        'no static import of the native bridge (it would break bundling)'
    );
    assertEq(
        (src.match(/import\(\s*"re-unplayplay"\s*\)/g) ?? []).length, 1,
        'exactly one lazy dynamic import of the playplay bridge'
    );
    assert(!src.includes('pkg-prebuilds'), 'the native loader is not bundled (it ships as real files)');
    assert(!src.includes('binding-options'), 'the binding options file is not referenced by the bundle');
});

test('spdl stream endpoints are compiled into the bundle', () => {
    const src = readFileSync(bundlePath, 'utf8');
    assert(src.includes('OGG_VORBIS_320'), 'format table present');
    assert(src.includes('storage-resolve/files/audio/interactive'), 'stream resolve endpoint present');
    assert(src.includes('metadata/4/track'), 'track metadata endpoint present');
});

test('the playplay bridge decrypts the reference vector', async () => {
    const pp = await import('re-unplayplay');
    const key = pp.decryptAndBindKey(Buffer.from('01', 'hex'), '01');
    assertEq(key.toString('hex').toUpperCase(), '7EE4480B767DD92A03E90A7FC1FF4099', 'decryptAndBindKey reference vector');
    assertEq(pp.getToken().length, 16, 'playplay token is 16 bytes');
});
