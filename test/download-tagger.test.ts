/**
 * tagger.ts — per-container tag/cover writing for downloaded tracks, plus the
 * stream-level tag reading fix that keeps .ogg metadata alive through probing.
 *
 * These tests run REAL ffmpeg/ffprobe against generated fixtures:
 *   - a 1 s sine encoded as .m4a / .mp3 / .ogg (lavfi)
 *   - a 300×300 red JPEG cover (lavfi color source)
 *
 * Arg tables are pinned to the planning-time probe (2026-10-18, ffmpeg 8.1):
 *   - mp3/m4a take a second cover input: -map 0:a -map 1 -c copy
 *     -map_metadata -1 -metadata k=v … (-id3v2_version 3 on mp3 only)
 *     -disposition:v attached_pic
 *   - ogg/webm take text tags only: -c copy -map_metadata -1 -metadata k=v …
 *     (ogg rejects picture streams; tags surface at STREAM level)
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { probe } from '../src/core/probe.ts';
import { readTags } from '../src/core/tags.ts';
import { CONTAINER_SUPPORT, fetchCover, writeTags } from '../src/core/download/tagger.ts';
import type { TrackMeta } from '../src/core/download/types.ts';

let bins: BinPaths | null = null;
let unavailable = '';
try {
  bins = findBinaries();
} catch (err) {
  unavailable = (err as Error).message;
}

function skipUnlessAvailable(): boolean {
  if (!bins) {
    process.stdout.write(`  (skipping: ${unavailable.split('\n')[0]})\n`);
    return true;
  }
  return false;
}

const ROOT = join(tmpdir(), 'aus-tagger');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function makeAudio(
  ffmpeg: string,
  dir: string,
  codec: string,
  ext: string,
): Promise<string> {
  const out = join(dir, `base${ext}`);
  const r = await runFfmpeg(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
     '-c:a', codec, out],
    { cwd: dir, timeoutMs: 30_000 },
  );
  assertEq(r.code, 0, `fixture ${ext} encodes`);
  assert(existsSync(out), `fixture ${ext} exists`);
  return out;
}

async function makeCover(ffmpeg: string, dir: string): Promise<string> {
  const out = join(dir, 'cover.jpg');
  const r = await runFfmpeg(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', 'color=red:s=300x300', '-frames:v', '1', out],
    { cwd: dir, timeoutMs: 30_000 },
  );
  assertEq(r.code, 0, 'cover fixture encodes');
  return out;
}

interface RawStreamShape {
  codec_type?: string;
  codec_name?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

/** Full ffprobe JSON (streams are NOT filtered — we need the picture stream). */
async function rawProbe(ffprobe: string, file: string, scratch: string) {
  const out = join(scratch, `raw-${Math.random().toString(36).slice(2)}.json`);
  const r = await runFfmpeg(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-o', out, file],
    { cwd: scratch, timeoutMs: 30_000 },
  );
  assertEq(r.code, 0, `ffprobe reads ${file}`);
  const text = (await import('node:fs')).readFileSync(out, 'utf8');
  rmSync(out, { force: true });
  return JSON.parse(text) as {
    streams?: RawStreamShape[];
    format?: { tags?: Record<string, string> };
  };
}

const META: TrackMeta = {
  title: '測試歌曲',
  artists: '測試歌手, Another One',
  album: '測試專輯',
  durationSec: 1,
  coverUrl: '',
  sourceId: '3n3PamnLuyFSbkgxjjB9YX',
};

/* ------------------------------------------------------------------ */

test('CONTAINER_SUPPORT pins which containers accept cover art', () => {
  assertEq(CONTAINER_SUPPORT['.mp3']?.cover, true, 'mp3 takes cover');
  assertEq(CONTAINER_SUPPORT['.m4a']?.cover, true, 'm4a takes cover');
  assertEq(CONTAINER_SUPPORT['.ogg']?.cover, false, 'ogg refuses cover');
  assertEq(CONTAINER_SUPPORT['.webm']?.cover, false, 'webm refuses cover');
});

test('writeTags attaches a cover picture and tags to .m4a', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const ffprobe = bins!.ffprobe;
  const dir = scratch('m4a-cover');
  try {
    const raw = await makeAudio(ffmpeg, dir, 'aac', '.m4a');
    const cover = await makeCover(ffmpeg, dir);
    const tagged = await writeTags(raw, META, { ffmpeg, trackNumber: 7, coverPath: cover });
    assertEq(tagged, raw, 'tags are written in place');

    const rawJson = await rawProbe(ffprobe, tagged, dir);
    const hasPic = (rawJson.streams ?? []).some(
      (s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) === 1,
    );
    assert(hasPic, 'm4a gains an attached_pic video stream');
    assertEq(rawJson.format?.tags?.title, META.title, 'm4a format-level title tag');
    assertEq(rawJson.format?.tags?.artist, META.artists, 'm4a artist tag');
    assertEq(rawJson.format?.tags?.album, META.album, 'm4a album tag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a webp cover — what yt-dlp actually reports — still attaches to .m4a', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const ffprobe = bins!.ffprobe;
  const dir = scratch('m4a-webp-cover');
  try {
    const raw = await makeAudio(ffmpeg, dir, 'aac', '.m4a');

    // Review Focus 5 / R7: YouTube thumbnails are WebP, and the tagger was
    // built against Spotify's JPEG CDN. Measured: `-c copy` refuses the webp
    // stream outright ("Could not find tag for codec webp in stream #1",
    // exit -22), which used to fail the whole tagging step.
    const cover = join(dir, 'cover.webp');
    const enc = await runFfmpeg(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error',
       '-f', 'lavfi', '-i', 'color=blue:s=300x300', '-frames:v', '1', cover],
      { cwd: dir, timeoutMs: 30_000 },
    );
    assertEq(enc.code, 0, 'webp cover fixture encodes');

    await writeTags(raw, META, { ffmpeg, trackNumber: 1, coverPath: cover });

    const rawJson = await rawProbe(ffprobe, raw, dir);
    const pic = (rawJson.streams ?? []).find(
      (s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) === 1,
    );
    assert(pic !== undefined, 'the webp cover is attached, not silently dropped');
    assertEq(pic?.codec_name, 'mjpeg', 'and re-encoded to the container-native codec');
    assert(
      (rawJson.streams ?? []).some((s) => s.codec_type === 'audio'),
      'the audio stream survives the embed',
    );
    assertEq(rawJson.format?.tags?.title, META.title, 'tags are still written alongside it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTags writes id3v2.3 tags plus cover to .mp3', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const ffprobe = bins!.ffprobe;
  const dir = scratch('mp3-cover');
  try {
    const raw = await makeAudio(ffmpeg, dir, 'libmp3lame', '.mp3');
    const cover = await makeCover(ffmpeg, dir);
    await writeTags(raw, META, { ffmpeg, trackNumber: 3, coverPath: cover });

    // ID3 header: bytes 0..2 = 'ID3', byte 3 = version major (3 => v2.3).
    const fd = openSync(raw, 'r');
    try {
      const head = Buffer.alloc(10);
      readSync(fd, head, 0, 10, 0);
      assertEq(head.toString('ascii', 0, 3), 'ID3', 'mp3 has an ID3v2 header');
      assertEq(head[3], 3, 'id3v2 major version is 3 (v2.3)');
    } finally {
      closeSync(fd);
    }

    const rawJson = await rawProbe(ffprobe, raw, dir);
    const hasPic = (rawJson.streams ?? []).some(
      (s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) === 1,
    );
    assert(hasPic, 'mp3 gains an attached_pic video stream');
    assertEq(rawJson.format?.tags?.title, META.title, 'mp3 title tag readable');
    assertEq(rawJson.format?.tags?.track, '3', 'mp3 track-number tag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTags tags .ogg at stream level and never attaches a picture', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const ffprobe = bins!.ffprobe;
  const dir = scratch('ogg-tags');
  try {
    const raw = await makeAudio(ffmpeg, dir, 'libvorbis', '.ogg');
    const cover = await makeCover(ffmpeg, dir);
    // coverPath is passed on purpose: the tagger must IGNORE it for ogg.
    await writeTags(raw, META, { ffmpeg, trackNumber: 2, coverPath: cover });

    const rawJson = await rawProbe(ffprobe, raw, dir);
    const hasVideo = (rawJson.streams ?? []).some((s) => s.codec_type === 'video');
    assertEq(hasVideo, false, 'ogg has no picture stream');
    const audio = (rawJson.streams ?? []).find((s) => s.codec_type === 'audio');
    assertEq(audio?.tags?.title, META.title, 'ogg title tag sits at STREAM level');
    assertEq(audio?.tags?.artist, META.artists, 'ogg artist tag at stream level');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTags returns ogg stream-level tags after probing (regression)', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const ffprobe = bins!.ffprobe;
  const dir = scratch('ogg-readtags');
  try {
    const raw = await makeAudio(ffmpeg, dir, 'libvorbis', '.ogg');
    await writeTags(raw, META, { ffmpeg });

    const info = await probe(ffprobe, raw, dir);
    assertEq(readTags(info).title, META.title, 'readTags merges stream tags for ogg');
    assertEq(readTags(info).artist, META.artists, 'readTags artist from stream tags');
    assertEq(readTags(info).album, META.album, 'readTags album from stream tags');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchCover resolves to null on a dead URL without throwing', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('fetch-cover');
  try {
    const p = await fetchCover('http://127.0.0.1:9/definitely-not-here.jpg', dir, 3_000);
    assertEq(p, null, 'unreachable URL yields null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTags rejects unknown containers', async () => {
  if (skipUnlessAvailable()) return;
  const ffmpeg = bins!.ffmpeg;
  const dir = scratch('unknown-ext');
  try {
    const bogus = join(dir, 'song.flac');
    (await import('node:fs')).writeFileSync(bogus, 'not really audio');
    let message = '';
    try {
      await writeTags(bogus, META, { ffmpeg });
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('.flac'), `unknown container rejected: ${message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Silence an unused-import warning path: dirname is used by the tagger contract
// (tags land beside the raw file), referenced here to keep the import honest.
void dirname;
