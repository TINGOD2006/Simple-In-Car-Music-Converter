/**
 * Local-file endpoints and the browser-launch path.
 *
 * These cover the half of "open a file" that a browser cannot do for itself:
 * choosing a path with a native dialog, accepting an uploaded file, and streaming
 * engine-side audio back for playback. They also lock down the failure behaviour
 * of the launcher, which is what made a packaged build die silently on startup.
 */

import { assert, assertEq, test } from './harness.ts';
import { startServer } from '../src/server/index.ts';
import { openInBrowser } from '../src/server/main.ts';
import {
  isStreamableAudio,
  parseByteRange,
  pickPaths,
  sanitizeUploadName,
} from '../src/server/files.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import { makeClip, makeTimeline, usbPreset } from '../src/core/edl.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

function scratch(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aus-${tag}-`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Start the real server on an ephemeral port with an isolated scratch root. */
async function withServer(
  scratchRoot: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const { server, port } = await startServer({ port: 0, scratchRoot });
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('files: sanitizeUploadName keeps a readable name', () => {
  assertEq(sanitizeUploadName('Track One.mp3'), 'Track One.mp3', 'a plain name is untouched');
});

test('files: sanitizeUploadName strips directories and traversal', () => {
  assertEq(
    sanitizeUploadName('C:\\Users\\me\\Music\\song.flac'),
    'song.flac',
    'a Windows path keeps only the file name',
  );
  assertEq(
    sanitizeUploadName('../../etc/passwd'),
    'passwd',
    'a traversal path keeps only the last segment',
  );
  assertEq(
    sanitizeUploadName('a\\b/../c.wav'),
    'c.wav',
    'mixed separators are reduced to the final segment',
  );
});

test('files: sanitizeUploadName strips characters Windows rejects', () => {
  const out = sanitizeUploadName('bad:name?with*chars.wav');
  assert(!/[:?*]/.test(out), `reserved characters removed (got ${out})`);
  assert(out.endsWith('.wav'), 'the extension survives');
});

test('files: sanitizeUploadName never returns an empty name', () => {
  assertEq(sanitizeUploadName(''), 'upload.bin', 'an empty name falls back');
  assertEq(sanitizeUploadName('...'), 'upload.bin', 'a dots-only name falls back');
});

test('files: parseByteRange reads the forms an audio element sends', () => {
  assertEq(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 }, 'a closed range');
  assertEq(parseByteRange('bytes=100-', 1000), { start: 100, end: 999 }, 'an open-ended range');
  assertEq(parseByteRange('bytes=-200', 1000), { start: 800, end: 999 }, 'a suffix range');
  assertEq(
    parseByteRange('bytes=900-5000', 1000),
    { start: 900, end: 999 },
    'an over-long end is clamped to the file size',
  );
});

test('files: parseByteRange refuses what it cannot honour', () => {
  // Answering with the whole file is always legal, so anything unclear returns
  // null rather than a wrong slice.
  assertEq(parseByteRange(undefined, 1000), null, 'no header means no range');
  assertEq(parseByteRange('items=0-9', 1000), null, 'a non-bytes unit is ignored');
  assertEq(parseByteRange('bytes=0-9, 20-29', 1000), null, 'multi-range is not attempted');
  assertEq(parseByteRange('bytes=abc-def', 1000), null, 'garbage is ignored');
  assertEq(parseByteRange('bytes=1000-', 1000), null, 'a start at EOF is refused');
  assertEq(parseByteRange('bytes=50-10', 1000), null, 'an inverted range is refused');
  assertEq(parseByteRange('bytes=-0', 1000), null, 'a zero-length suffix is refused');
});

test('files: isStreamableAudio accepts containers and refuses everything else', () => {
  for (const name of ['a.mp3', 'b.WAV', 'c.flac', 'd.ogg', 'e.m4a', 'f.mka']) {
    assert(isStreamableAudio(name), `${name} is a recognised audio container`);
  }
  for (const name of ['notes.txt', 'photo.png', 'app.exe', 'noextension']) {
    assert(!isStreamableAudio(name), `${name} is refused`);
  }
});

/* ------------------------------------------------------------------ */
/* Upload and playback                                                 */
/* ------------------------------------------------------------------ */

test('an upload is written to scratch and streamed back byte for byte', async () => {
  const root = scratch('upload');
  try {
    // Arbitrary bytes: the endpoint validates the *extension*, not the container,
    // so a payload that cannot be mistaken for real audio makes any accidental
    // transformation visible.
    const payload = Buffer.from('AudioUsbStudio-upload-\u0000\u00ff\u0001\u0002-probe', 'latin1');

    await withServer(root, async (base) => {
      const up = await fetch(`${base}/api/upload?name=${encodeURIComponent('probe.wav')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload,
      });
      assertEq(up.status, 200, 'upload accepted');
      const saved = (await up.json()) as { ok: boolean; path: string; bytes: number };
      assertEq(saved.ok, true, 'upload reports ok');
      assertEq(saved.bytes, payload.length, 'every byte was counted');

      const onDisk = readFileSync(saved.path);
      assertEq(onDisk.equals(payload), true, 'the file on disk matches the upload exactly');

      const back = await fetch(`${base}/api/file?path=${encodeURIComponent(saved.path)}`);
      assertEq(back.status, 200, 'the file streams back');
      assertEq(
        back.headers.get('content-type'),
        'audio/wav',
        'the media type comes from the extension',
      );
      assertEq(back.headers.get('accept-ranges'), 'bytes', 'seeking is advertised');
      const body = Buffer.from(await back.arrayBuffer());
      assertEq(body.equals(payload), true, 'the streamed bytes match the upload exactly');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a range request answers 206 with exactly the requested slice', async () => {
  const root = scratch('range');
  try {
    const payload = Buffer.from('0123456789abcdefghij', 'utf8');
    await withServer(root, async (base) => {
      const up = await fetch(`${base}/api/upload?name=slice.wav`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload,
      });
      const { path } = (await up.json()) as { path: string };

      const part = await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, {
        headers: { range: 'bytes=4-9' },
      });
      assertEq(part.status, 206, 'a range answers 206');
      assertEq(
        part.headers.get('content-range'),
        `bytes 4-9/${payload.length}`,
        'the content-range names the slice',
      );
      assertEq(part.headers.get('content-length'), '6', 'the length is the slice length');
      assertEq(await part.text(), '456789', 'the slice is exactly the requested bytes');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/file refuses a missing, relative, or non-audio path', async () => {
  const root = scratch('refuse');
  try {
    await withServer(root, async (base) => {
      const missing = await fetch(`${base}/api/file`);
      assertEq(missing.status, 400, 'no path is a client error');

      const relative = await fetch(`${base}/api/file?path=${encodeURIComponent('song.mp3')}`);
      assertEq(relative.status, 400, 'a relative path is refused');

      // The allow-list is the guard that stops this endpoint reading arbitrary
      // local files, so a non-audio name must not be streamed.
      const nonAudio = await fetch(
        `${base}/api/file?path=${encodeURIComponent(join(root, 'notes.txt'))}`,
      );
      assertEq(nonAudio.status, 415, 'a non-audio extension is refused');

      const absent = await fetch(
        `${base}/api/file?path=${encodeURIComponent(join(root, 'ghost.mp3'))}`,
      );
      assertEq(absent.status, 404, 'a recognised extension that does not exist is 404');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/file does not fall back to the UI shell', async () => {
  const root = scratch('apifall');
  try {
    // An unmatched /api/ GET must stay JSON: serving index.html here is what made
    // a wrong-method call look like a parse error instead of a 404.
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/nope`);
      assertEq(res.status, 404, 'an unknown API route is 404');
      const body = (await res.json()) as { ok: boolean };
      assertEq(body.ok, false, 'the body is JSON, not HTML');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/preview validates its inputs instead of rendering nothing', async () => {
  const root = scratch('preview');
  try {
    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assertEq(res.status, 400, 'a preview without a timeline is a client error');
      const body = (await res.json()) as { ok: boolean; error: string };
      assertEq(body.ok, false, 'the failure is reported');
      assert(body.error.includes('required'), `the message names the missing fields (${body.error})`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INTEGRATION: /api/preview answers with playable WAV bytes', async () => {
  let bins;
  try {
    bins = findBinaries();
  } catch {
    console.log('  (skipping: ffmpeg not found)');
    return;
  }

  const root = scratch('preview-real');
  try {
    // A real tone, because the point of this endpoint is that the browser gets
    // decodable audio rather than a scratch path it cannot fetch — which is why
    // every effect preview used to fail silently.
    const src = join(root, 'tone.wav');
    const gen = await runFfmpeg(
      bins.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2:sample_rate=44100',
        '-ac',
        '2',
        src,
      ],
      { cwd: root },
    );
    assertEq(gen.code, 0, 'the source tone was generated');

    const timeline = makeTimeline([makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 1 })], 44100, 2);

    await withServer(root, async (base) => {
      const res = await fetch(`${base}/api/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeline, preset: usbPreset(), sourcePaths: { src0: src } }),
      });
      assertEq(res.status, 200, `preview renders (${res.status})`);
      assertEq(res.headers.get('content-type'), 'audio/wav', 'preview answers with WAV');

      const bytes = Buffer.from(await res.arrayBuffer());
      assert(bytes.length > 1000, `the WAV carries real audio (got ${bytes.length} bytes)`);
      assertEq(bytes.subarray(0, 4).toString('ascii'), 'RIFF', 'the body is a RIFF container');
      assertEq(bytes.subarray(8, 12).toString('ascii'), 'WAVE', 'the body is a WAVE file');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Native dialog degradation                                           */
/* ------------------------------------------------------------------ */

test('pickPaths answers null rather than throwing when no dialog can open', async () => {
  // This is the contract the UI relies on: `null` means "fall back to upload",
  // and it must never reject, because a rejected promise becomes a 500 and the
  // UI would report a broken feature instead of offering the other path.
  const picked = await pickPaths('files', { shell: 'aus-no-such-shell-3f9c' });
  assertEq(picked, null, 'a shell that cannot start degrades to null');
});

/* ------------------------------------------------------------------ */
/* Browser launch                                                      */
/* ------------------------------------------------------------------ */

test('openInBrowser resolves false when every launcher fails, without crashing', async () => {
  // Regression guard for the startup crash: `spawn` reports a missing or blocked
  // binary asynchronously, so an unhandled 'error' event terminates the process.
  // This call used to be able to take the whole server down; it must instead
  // report failure so the caller can print the URL.
  const opened = await openInBrowser('http://127.0.0.1:9/', [
    { cmd: 'aus-no-such-launcher-7b1d', args: [] },
  ]);
  assertEq(opened, false, 'an unusable launcher reports false rather than throwing');
});

test('openInBrowser reports true once some launcher starts', async () => {
  // `node -e ""` is a launcher that definitely exists and exits immediately, so
  // this exercises the success path without opening a real browser.
  const opened = await openInBrowser('http://127.0.0.1:9/', [
    { cmd: process.execPath, args: ['-e', ''] },
  ]);
  assertEq(opened, true, 'a launcher that starts is reported as success');
});
