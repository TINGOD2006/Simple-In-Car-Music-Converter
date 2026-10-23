/**
 * library.ts — real filesystem scanning.
 *
 * These tests create a real directory tree of real audio files (encoded by ffmpeg),
 * plus decoys that must be ignored, and assert on what `scanLibrary` actually
 * reports. Nothing here asserts on argv strings: a scan that never probed anything
 * would still have to produce a real MediaInfo for every entry to pass.
 *
 * Sandbox note (docs/ENVIRONMENT.md 2.3): node cannot mkdir under the workspace,
 * so scratch lives under os.tmpdir().
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { AUDIO_EXTENSIONS, isAudioFile, scanLibrary } from '../src/core/library.ts';
import { probe } from '../src/core/probe.ts';
import type { MediaInfo } from '../src/core/types.ts';

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

const ROOT = join(tmpdir(), 'aus-library');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Encode a real audio file with ffmpeg. */
async function makeAudio(dir: string, name: string, freq = 440, dur = 2): Promise<string> {
  const out = join(dir, name);
  const r = await runFfmpeg(
    bins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=44100`,
      '-ac', '2', out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`could not create ${name}: exit ${r.code}`);
  return out;
}

/* ------------------------------------------------------------------ */

test('library: AUDIO_EXTENSIONS covers the formats a car stereo library accumulates', () => {
  const set = new Set(AUDIO_EXTENSIONS.map((e) => e.toLowerCase()));
  // 'webm' is not decoration: yt-dlp's bestaudio stream for most YouTube videos
  // is Opus in a WebM container, so a download lands as `<name>.webm` and the
  // converter can only reach it if the scanner recognises the extension.
  for (const ext of ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'm4a', 'webm', 'weba', 'wma', 'aiff', 'alac', 'ape', 'wv', 'tta', 'ac3', 'dts', 'mka', 'amr', 'au', 'ra', 'rm', 'caf', 'mpc', 'spx']) {
    assert(set.has(ext), `AUDIO_EXTENSIONS is missing "${ext}"`);
  }
  // Sanity: a non-audio extension must not be in the list.
  for (const ext of ['jpg', 'txt', 'pdf', 'cue', 'log', 'png']) {
    assert(!set.has(ext), `AUDIO_EXTENSIONS must not contain "${ext}"`);
  }
});

test('library: isAudioFile matches extensions case-insensitively and ignores directories-ish paths', () => {
  assert(isAudioFile('song.mp3'), 'lowercase .mp3 recognised');
  assert(isAudioFile('SONG.MP3'), 'uppercase .MP3 recognised');
  assert(isAudioFile('C:\\music\\a b\\track.FLAC'), 'uppercase .FLAC recognised');
  assert(isAudioFile('x.m4a'), '.m4a recognised');
  assert(!isAudioFile('cover.jpg'), 'a .jpg is not audio');
  assert(!isAudioFile('notes.txt'), 'a .txt is not audio');
  assert(!isAudioFile('noextension'), 'an extensionless path is not audio');
  assert(!isAudioFile('fake.mp3.txt'), 'only the final extension counts');
});

test('INTEGRATION: scanLibrary probes every audio file and excludes everything else', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('scan');
  try {
    const music = join(dir, 'music');
    const nested = join(music, 'album');
    mkdirSync(nested, { recursive: true });

    const a = await makeAudio(music, '01 - Artist - One.wav', 440);
    const b = await makeAudio(music, '02 - Artist - Two.wav', 880);
    const c = await makeAudio(nested, '03 - Artist - Three.flac', 1320);

    // Decoys that must never become entries.
    writeFileSync(join(music, 'cover.jpg'), 'not audio');
    writeFileSync(join(music, 'notes.txt'), 'not audio either');
    writeFileSync(join(music, 'playlist.cue'), 'FILE "x.wav" WAVE');
    mkdirSync(join(music, 'empty-dir'), { recursive: true });

    const result = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });

    assertEq(result.errors.length, 0, `scan reported no errors, got ${JSON.stringify(result.errors)}`);
    assertEq(result.entries.length, 3, 'exactly the three real audio files were found');

    const found = result.entries.map((e) => e.path).sort();
    assertEq(found, [a, b, c].sort(), 'the three encoded files are the entries (recursive into album/)');

    for (const e of result.entries) {
      assert(e.info.audio !== null, `${e.path} has an audio stream`);
      assert(e.info.audio!.sampleRate === 44100, `${e.path} sample rate is 44100`);
      assert(e.info.audio!.channels === 2, `${e.path} is stereo`);
      assert(e.info.format.durationSec > 1, `${e.path} duration was probed (${e.info.format.durationSec})`);
      assert(e.id.length > 0, `${e.path} has a non-empty id`);
    }

    // Ids must be unique, or the manifest cannot address an item.
    const ids = new Set(result.entries.map((e) => e.id));
    assertEq(ids.size, result.entries.length, 'every entry id is unique');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: scanLibrary honours a non-recursive scan', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('nonrecursive');
  try {
    const music = join(dir, 'music');
    const nested = join(music, 'album');
    mkdirSync(nested, { recursive: true });
    const top = await makeAudio(music, 'top.wav', 440);
    await makeAudio(nested, 'nested.wav', 880);

    const flat = await scanLibrary({
      roots: [music], ffprobe: bins!.ffprobe, scratch: dir, recursive: false,
    });
    assertEq(flat.entries.length, 1, 'only the top-level file is scanned');
    assertEq(flat.entries[0]!.path, top, 'the top-level file is the entry');

    const deep = await scanLibrary({
      roots: [music], ffprobe: bins!.ffprobe, scratch: dir, recursive: true,
    });
    assertEq(deep.entries.length, 2, 'recursive scan finds both');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: scanLibrary reports a broken audio file as an error without aborting the scan', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('broken');
  try {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const good = await makeAudio(music, 'good.wav', 440);
    // A file with an audio extension but garbage content: ffprobe fails on it.
    writeFileSync(join(music, 'broken.wav'), 'this is definitely not a RIFF header');

    const result = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });

    assertEq(result.entries.length, 1, 'the good file still produced an entry');
    assertEq(result.entries[0]!.path, good, 'the good file is the entry');
    assertEq(result.errors.length, 1, 'the broken file produced exactly one error');
    assert(result.errors[0]!.path.endsWith('broken.wav'), 'the error names the broken file');
    assert(result.errors[0]!.message.length > 0, 'the error carries a message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: scanLibrary reports a missing root instead of throwing', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('missingroot');
  try {
    const absent = join(dir, 'does-not-exist');
    const result = await scanLibrary({ roots: [absent], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(result.entries.length, 0, 'no entries from a missing root');
    assertEq(result.errors.length, 1, 'the missing root is reported as one error');
    assert(result.errors[0]!.message.length > 0, 'the error carries a message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: scanLibrary reports progress for every candidate file', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('progress');
  try {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    await makeAudio(music, 'a.wav', 440);
    await makeAudio(music, 'b.wav', 880);

    const seen: { done: number; total: number; path: string }[] = [];
    await scanLibrary({
      roots: [music],
      ffprobe: bins!.ffprobe,
      scratch: dir,
      onProgress: (done, total, path) => seen.push({ done, total, path }),
    });

    assertEq(seen.length, 2, 'progress fired once per candidate file');
    assertEq(seen[seen.length - 1]!.done, 2, 'the final progress count is the total');
    assertEq(seen[0]!.total, 2, 'total is known up front');
    assert(seen.every((s) => s.path.length > 0), 'every progress event carries a path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('library: scanning a directory with no audio files yields an empty result', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('empty');
  try {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    writeFileSync(join(music, 'a.txt'), 'nope');
    writeFileSync(join(music, 'b.jpg'), 'nope');
    const result = await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: dir });
    assertEq(result.entries.length, 0, 'no entries');
    assertEq(result.errors.length, 0, 'no errors either — nothing was probed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: scanLibrary probes a real file and leaves no scratch residue', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('residue');
  try {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const wav = await makeAudio(music, 'tone.wav', 440);
    const before = statSync(wav).size;

    const scanDir = join(dir, 'scan-scratch');
    mkdirSync(scanDir, { recursive: true });
    await scanLibrary({ roots: [music], ffprobe: bins!.ffprobe, scratch: scanDir });

    // probe() removes its temporary JSON in a finally block.
    const leftover = existsSync(scanDir)
      ? readdirSync(scanDir).filter((f) => f.endsWith('.json'))
      : [];
    assertEq(leftover.length, 0, `no probe JSON left behind, found ${JSON.stringify(leftover)}`);
    assertEq(statSync(wav).size, before, 'the source file was not modified by probing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: probe() refuses a file it cannot open instead of blaming its streams', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('unopenable');
  try {
    const gone = join(dir, 'not-here.mp3');
    let message = '';
    let returned: unknown = null;
    try {
      returned = await probe(bins!.ffprobe, gone, dir);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(returned === null, `probe() must throw, not return ${JSON.stringify(returned)}`);
    assert(message.includes('not-here.mp3'), `the message names the file: ${message}`);
    assert(
      !message.includes('no audio stream'),
      `the message must not blame the streams for an unopenable file: ${message}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: probe() treats an unparseable file as an error, not as an empty stream list', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('garbage');
  try {
    const junk = join(dir, 'pretend.mp3');
    writeFileSync(junk, 'this is a text file wearing an .mp3 extension, and ffprobe will not be fooled');
    let message = '';
    let returned: unknown = null;
    try {
      returned = await probe(bins!.ffprobe, junk, dir);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(returned === null, `probe() must throw, not return ${JSON.stringify(returned)}`);
    assert(
      /could not be read|no stream|unparseable|empty result/i.test(message),
      `the message explains that ffprobe could not read the file: ${message}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: a file with a video stream but no audio still reports "no audio stream"', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('video-only');
  try {
    const movie = join(dir, 'clip.mp4');
    const r = await runFfmpeg(
      bins!.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5',
        '-c:v', 'mpeg4', '-an', movie,
      ],
      { cwd: dir },
    );
    if (r.code !== 0 || !existsSync(movie)) {
      process.stdout.write(`  (skipping: could not encode a video-only file, exit ${r.code})\n`);
      return;
    }
    const info = await probe(bins!.ffprobe, movie, dir);
    assertEq(info.audio, null, 'a video-only file has no audio stream, and that is a real answer');
    assert(info.streams.length === 0, 'and no audio streams were invented');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('library: scanning probes files concurrently and still reports them sorted', async () => {
  const dir = scratch('concurrent');
  try {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(music, `t${String(i).padStart(2, '0')}.mp3`), 'not really audio');
    }

    let inFlight = 0;
    let peak = 0;
    let probed = 0;
    const fake = async (ffprobe: string, file: string): Promise<MediaInfo> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      probed += 1;
      assertEq(ffprobe, 'injected', 'the injected probe receives the configured ffprobe path');
      return {
        path: file,
        streams: [
          {
            index: 0,
            codecName: 'mp3',
            codecLongName: 'MP3',
            sampleRate: 44100,
            channels: 2,
            channelLayout: 'stereo',
            bitsPerRawSample: null,
            bitRate: 320000,
            durationSec: 1,
          },
        ],
        audio: {
          index: 0,
          codecName: 'mp3',
          codecLongName: 'MP3',
          sampleRate: 44100,
          channels: 2,
          channelLayout: 'stereo',
          bitsPerRawSample: null,
          bitRate: 320000,
          durationSec: 1,
        },
        format: {
          formatName: 'mp3',
          formatLongName: 'MP3',
          durationSec: 1,
          sizeBytes: 16,
          bitRate: 320000,
          tags: {},
        },
        probedAt: '2026-01-01T00:00:00.000Z',
      };
    };

    const result = await scanLibrary({
      roots: [music],
      ffprobe: 'injected',
      scratch: dir,
      probeFile: fake,
      concurrency: 4,
    });

    assertEq(result.entries.length, 12, 'every file was probed');
    assertEq(probed, 12, 'and exactly once each');
    assertEq(result.errors.length, 0, 'nothing failed');
    assert(peak > 1, `probing actually ran concurrently (peak ${peak})`);
    assert(peak <= 4, `and stayed inside the injected limit (peak ${peak})`);

    const paths = result.entries.map((e) => e.path);
    assertEq(paths, [...paths].sort(), 'entries stay sorted no matter what order the probes finished in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('library: a leftover staging file beside its own track is never scanned', async () => {
  // The 2026-10-16 incident: an interrupted overwrite left
  // `Song - Artist.aus-tmp-u9nvkk.mp3` next to `Song - Artist.mp3`. `extname()` sees
  // `.mp3`, so the scan would have reported the half-written staging file as a
  // second, real track; the batch then "preserved" the original by renaming the
  // staging file onto the name it already occupied, and the user got `Song - Artist
  // (2).mp3`. A scanner that never lists it cannot get there.
  const dir = scratch('staging-leftover');
  try {
    const music = join(dir, 'music');
    const album = join(music, 'album');
    mkdirSync(album, { recursive: true });

    const track = join(music, 'Song - Artist.mp3');
    const leftover = join(music, 'Song - Artist.aus-tmp-u9nvkk.mp3');
    const deepTrack = join(album, 'Deep - Artist.mp3');
    const deepLeftover = join(album, 'Deep - Artist.AUS-TMP-AAA111.mp3');
    writeFileSync(track, 'not really audio');
    writeFileSync(leftover, 'half-written staging bytes');
    writeFileSync(deepTrack, 'not really audio');
    writeFileSync(deepLeftover, 'half-written staging bytes');

    const oneStream = (file: string): MediaInfo => {
      const audio = {
        index: 0,
        codecName: 'mp3',
        codecLongName: 'MP3',
        sampleRate: 44100,
        channels: 2,
        channelLayout: 'stereo',
        bitsPerRawSample: null,
        bitRate: 320000,
        durationSec: 1,
      };
      return {
        path: file,
        streams: [audio],
        audio,
        format: {
          formatName: 'mp3',
          formatLongName: 'MP3',
          durationSec: 1,
          sizeBytes: 16,
          bitRate: 320000,
          tags: {},
        },
        probedAt: '2026-01-01T00:00:00.000Z',
      };
    };

    const probed: string[] = [];
    const fake = async (_ffprobe: string, file: string): Promise<MediaInfo> => {
      probed.push(file);
      return oneStream(file);
    };

    const result = await scanLibrary({
      roots: [music],
      ffprobe: 'injected',
      scratch: dir,
      probeFile: fake,
      concurrency: 2,
    });

    const expected = [track, deepTrack].sort();
    assertEq(result.entries.map((e) => e.path), expected, 'only the two real tracks are entries');
    assertEq(probed.slice().sort(), expected, 'ffprobe was only ever asked about the real tracks');
    assertEq(result.errors.length, 0, 'and the staging files are not reported as errors either');
    assert(
      !result.entries.some((e) => e.path.includes('.aus-tmp-')),
      'no entry points at a staging file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
