/**
 * tags.ts — metadata extraction, mojibake repair, filename parsing and sanitising.
 *
 * The mojibake fixtures are REAL byte sequences: a Big5/CP950-encoded string read
 * as Latin-1. They were produced by encoding the characters with the platform
 * codec and re-reading the bytes as Latin-1, so the input is exactly what a
 * mis-decoded ID3 tag looks like on disk — not an invented lookalike string.
 *
 *   '周杰倫' Big5 = A9 50 AA 4E AD DB -> "©PªN\xADÛ"
 *   '測試'   Big5 = B4 FA B8 D5       -> "´ú¸Õ"
 *
 * The real-tag test additionally writes those bytes into an actual MP3 via ffmpeg
 * and repairs what ffprobe reads back, so the round trip is end-to-end.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import type { BinPaths } from '../src/core/ffbin.ts';
import { probe } from '../src/core/probe.ts';
import {
  FILENAME_PATTERNS,
  deriveTagsFromFilename,
  mergeTags,
  planFilenames,
  readTags,
  repairMojibake,
  sanitizeFilename,
} from '../src/core/tags.ts';
import type { TagSet } from '../src/core/tags.ts';
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

const ROOT = join(tmpdir(), 'aus-tags');

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/* ------------------------------------------------------------------ */
/* Real mis-decoded byte sequences                                     */
/* ------------------------------------------------------------------ */

/** The bytes `[0xA9,0x50,0xAA,0x4E,0xAD,0xDB]` (Big5 "周杰倫") read as Latin-1. */
const BIG5_ZHOU = Buffer.from([0xa9, 0x50, 0xaa, 0x4e, 0xad, 0xdb]).toString('latin1');
/** The bytes `[0xB4,0xFA,0xB8,0xD5]` (Big5 "測試") read as Latin-1. */
const BIG5_TEST = Buffer.from([0xb4, 0xfa, 0xb8, 0xd5]).toString('latin1');
/** UTF-8 "café" (63 61 66 C3 A9) read as Latin-1 -> "cafÃ©". */
const UTF8_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9]).toString('latin1');
/** A GBK pair whose bytes are NOT valid Big5, so only GB18030 can decode it. */
const GBK_ONLY = Buffer.from([0x81, 0x80, 0x81, 0x81]).toString('latin1');

/* ------------------------------------------------------------------ */

test('tags: repairMojibake restores real Big5/CP950 bytes read as Latin-1', () => {
  assertEq(repairMojibake(BIG5_ZHOU), '周杰倫', 'Big5 周杰倫 restored');
  assertEq(repairMojibake(BIG5_TEST), '測試', 'Big5 測試 restored');
});

test('tags: repairMojibake restores UTF-8 bytes read as Latin-1', () => {
  assertEq(repairMojibake(UTF8_CAFE), 'café', 'UTF-8 café restored');
  // "å¨æ°å«" is the UTF-8 form of 周杰倫 read as Latin-1.
  const utf8Zhou = Buffer.from('周杰倫', 'utf8').toString('latin1');
  assertEq(repairMojibake(utf8Zhou), '周杰倫', 'UTF-8 周杰倫 restored (UTF-8 wins over Big5)');
});

test('tags: repairMojibake restores a GBK pair that Big5 cannot decode', () => {
  // This is the case the Big5-first ordering cannot handle, and the reason
  // GB18030 is tried: these lead bytes are invalid in Big5.
  assertEq(repairMojibake(GBK_ONLY), '亐亖', 'GBK-only bytes decoded via GB18030');
});

test('tags: repairMojibake leaves correct and ASCII strings untouched', () => {
  assertEq(repairMojibake('Hello World'), 'Hello World', 'ASCII unchanged');
  assertEq(repairMojibake(''), '', 'empty unchanged');
  assertEq(repairMojibake('周杰倫'), '周杰倫', 'already-correct CJK unchanged');
  assertEq(repairMojibake('café'), 'café', 'already-correct Latin-1 accent unchanged');
  assertEq(repairMojibake('Привет'), 'Привет', 'already-correct Cyrillic unchanged');
  assertEq(repairMojibake('Track 01'), 'Track 01', 'plain ASCII filename unchanged');
});

test('tags: repairMojibake never returns replacement characters', () => {
  for (const s of [BIG5_ZHOU, BIG5_TEST, UTF8_CAFE, GBK_ONLY, 'plain', '']) {
    assert(!repairMojibake(s).includes('\uFFFD'), `no U+FFFD for ${JSON.stringify(s)}`);
  }
});

test('tags: deriveTagsFromFilename parses the layouts that accumulate in a music folder', () => {
  assertEq(deriveTagsFromFilename('01 - Artist - Title.mp3'), { artist: 'Artist', title: 'Title', track: '01' }, '"01 - Artist - Title.mp3"');
  assertEq(deriveTagsFromFilename('Artist - Title.flac'), { artist: 'Artist', title: 'Title' }, '"Artist - Title.flac"');
  assertEq(deriveTagsFromFilename('01 Title.mp3'), { title: 'Title', track: '01' }, '"01 Title.mp3"');
  assertEq(deriveTagsFromFilename('Title.mp3'), { title: 'Title' }, '"Title.mp3"');
  assertEq(deriveTagsFromFilename('01. Artist - Title.flac'), { artist: 'Artist', title: 'Title', track: '01' }, '"01. Artist - Title.flac"');
  assertEq(deriveTagsFromFilename('01 - Title.mp3'), { title: 'Title', track: '01' }, '"01 - Title.mp3" (no artist)');
});

test('tags: deriveTagsFromFilename handles paths, underscores and separator edge cases', () => {
  assertEq(deriveTagsFromFilename('C:\\music\\07 - A - B.wav'), { artist: 'A', title: 'B', track: '07' }, 'a full Windows path');
  assertEq(deriveTagsFromFilename('/home/me/07 - A - B.wav'), { artist: 'A', title: 'B', track: '07' }, 'a full POSIX path');
  assertEq(deriveTagsFromFilename('03_-_Some_Song.ogg'), { title: 'Some Song', track: '03' }, 'underscores become spaces');
  assertEq(deriveTagsFromFilename('A - B - C.mp3'), { artist: 'A', title: 'B - C' }, 'only the first dash splits artist from title');
  assertEq(deriveTagsFromFilename('.mp3'), {}, 'a bare extension yields no tags');
  assertEq(deriveTagsFromFilename(''), {}, 'an empty path yields no tags');
});

test('tags: deriveTagsFromFilename never invents fields it cannot see', () => {
  const t = deriveTagsFromFilename('Title.mp3');
  assert(t.album === undefined, 'no album is invented');
  assert(t.year === undefined, 'no year is invented');
  assert(t.genre === undefined, 'no genre is invented');
  assert(t.track === undefined, 'no track number is invented when absent');
});

test('tags: sanitizeFilename strips every character Windows forbids', () => {
  const out = sanitizeFilename('a/b\\c:d*e?f"g<h>i|j');
  for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    assert(!out.includes(ch), `"${ch}" was removed (got ${JSON.stringify(out)})`);
  }
  assertEq(out, 'a_b_c_d_e_f_g_h_i_j', 'each illegal character became a single underscore');
});

test('tags: sanitizeFilename strips control characters and trailing dots/spaces', () => {
  const out = sanitizeFilename('name\u0000with\u001fcontrols\u007f');
  assert(!/[\u0000-\u001f\u007f]/.test(out), `control characters removed (got ${JSON.stringify(out)})`);
  assertEq(sanitizeFilename('trailing...  '), 'trailing', 'trailing dots and spaces removed');
  assertEq(sanitizeFilename('   '), 'untitled', 'a whitespace-only name becomes untitled');
  assertEq(sanitizeFilename(''), 'untitled', 'an empty name becomes untitled');
  assertEq(sanitizeFilename('  ok name  '), 'ok name', 'surrounding whitespace trimmed');
});

test('tags: sanitizeFilename avoids Windows reserved device names', () => {
  assertEq(sanitizeFilename('CON'), '_CON', 'CON is prefixed');
  assertEq(sanitizeFilename('nul.mp3'), '_nul.mp3', 'nul.mp3 is prefixed');
  assertEq(sanitizeFilename('COM1'), '_COM1', 'COM1 is prefixed');
  assertEq(sanitizeFilename('lpt9'), '_lpt9', 'lpt9 is prefixed');
  // A name that merely starts with a reserved word is fine.
  assertEq(sanitizeFilename('console'), 'console', 'console is not reserved');
});

test('tags: sanitizeFilename enforces the length budget', () => {
  assertEq(sanitizeFilename('x'.repeat(200)).length, 120, 'default limit is 120');
  assertEq(sanitizeFilename('abcdefghijklmnop', 10), 'abcdefghij', 'explicit limit is honoured');
  // Truncation must not leave a trailing dot or space.
  const dotted = sanitizeFilename('a'.repeat(9) + '. bbbbbb', 10);
  assert(!/[. ]$/.test(dotted), `no trailing dot/space after truncation (got ${JSON.stringify(dotted)})`);
});

test('tags: mergeTags lets primary win field by field, including empty strings', () => {
  const merged = mergeTags({ artist: 'P', title: '' }, { artist: 'F', title: 'T', album: 'Al' });
  assertEq(merged.artist, 'P', 'primary artist wins');
  assertEq(merged.title, 'T', 'an empty primary title falls back');
  assertEq(merged.album, 'Al', 'the fallback fills a missing field');

  const gaps = mergeTags({ artist: 'P', title: 'T' }, { artist: 'F', title: 'X', genre: 'Rock' });
  assertEq(gaps.artist, 'P', 'primary artist still wins');
  assertEq(gaps.title, 'T', 'primary title still wins');
  assertEq(gaps.genre, 'Rock', 'the fallback fills only the gap');

  assertEq(mergeTags({}, {}), {}, 'merging two empty sets yields empty');

  const blank = mergeTags({ artist: '   ' }, { artist: 'F' });
  assertEq(blank.artist, 'F', 'a whitespace-only primary value is treated as absent');
  assertEq(Object.keys(blank).length, 1, 'no extra fields are invented');
});

test('tags: planFilenames renders every documented pattern and de-duplicates collisions', () => {
  assert('track artist title' in FILENAME_PATTERNS, 'pattern "track artist title" is offered');
  assert('artist title' in FILENAME_PATTERNS, 'pattern "artist title" is offered');
  assert('title' in FILENAME_PATTERNS, 'pattern "title" is offered');
  assertEq(FILENAME_PATTERNS['track artist title'], '{track} {artist} - {title}', 'the contract pattern string');
  assertEq(FILENAME_PATTERNS['artist title'], '{artist} - {title}', 'the contract pattern string');
  assertEq(FILENAME_PATTERNS['title'], '{title}', 'the contract pattern string');

  const names = planFilenames(
    [
      { id: 'a', tags: { artist: 'X', title: 'Same' } },
      { id: 'b', tags: { artist: 'X', title: 'Same' } },
      { id: 'c', tags: {} },
    ],
    FILENAME_PATTERNS['artist title']!,
  );
  assertEq(names.get('a'), 'X - Same', 'first collision keeps the plain name');
  assertEq(names.get('b'), 'X - Same (2)', 'second collision gets a suffix');
  assertEq(names.size, 3, 'every entry got a name');

  // All generated names must be distinct and individually safe.
  const values = [...names.values()];
  assertEq(new Set(values.map((v) => v.toLowerCase())).size, values.length, 'all planned names are unique');
  for (const v of values) {
    assert(sanitizeFilename(v) === v, `planned name ${JSON.stringify(v)} is already sanitised`);
  }
});

test('tags: planFilenames is deterministic across runs', () => {
  const entries = [
    { id: 'a', tags: { artist: 'X', title: 'T' } as TagSet },
    { id: 'b', tags: { artist: 'X', title: 'T' } as TagSet },
  ];
  const first = planFilenames(entries, '{artist} - {title}');
  const second = planFilenames(entries, '{artist} - {title}');
  assertEq([...first.entries()], [...second.entries()], 'the same input yields the same plan');
});

test('tags: a missing field never leaves a dangling separator in the filename', () => {
  // Regression: the default pattern is `{artist} - {title}`. With no artist tag
  // the empty placeholder used to leave its separator behind, producing names
  // like "- Song.mp3" — which is what a real batch run actually wrote to disk.
  const noArtist = planFilenames([{ id: 'a', tags: { title: 'Song' } }], '{artist} - {title}');
  assertEq(noArtist.get('a'), 'Song', 'no artist -> just the title, no leading dash');

  const noTitle = planFilenames([{ id: 'b', tags: { artist: 'Band' } }], '{artist} - {title}');
  assertEq(noTitle.get('b'), 'Band', 'no title -> just the artist, no trailing dash');

  const neither = planFilenames([{ id: 'c', tags: {} }], '{artist} - {title}');
  assertEq(neither.get('c'), 'c', 'no tags at all falls back to the entry id');

  // Both fields present must keep the normal shape.
  const both = planFilenames([{ id: 'd', tags: { artist: 'Band', title: 'Song' } }], '{artist} - {title}');
  assertEq(both.get('d'), 'Band - Song', 'a complete pair still renders the separator');

  // Every planned name must survive sanitisation unchanged and never start with
  // a separator character.
  for (const v of [...noArtist.values(), ...noTitle.values(), ...neither.values(), ...both.values()]) {
    assert(sanitizeFilename(v) === v, `planned name ${JSON.stringify(v)} is already sanitised`);
    assert(!/^[\s\-_]/.test(v), `planned name ${JSON.stringify(v)} does not start with a separator`);
  }
});

test('INTEGRATION: readTags reads real ID3 tags written into a real MP3', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('readtags');
  try {
    const out = join(dir, 'tagged.mp3');
    const r = await runFfmpeg(
      bins!.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100',
        '-metadata', 'title=Tïtle',
        '-metadata', 'artist=Artïst',
        '-metadata', 'album=Albüm',
        '-metadata', 'track=7',
        '-metadata', 'date=2021',
        '-metadata', 'genre=Rock',
        '-metadata', 'comment=hi',
        '-id3v2_version', '3', '-b:a', '192k',
        out,
      ],
      { cwd: dir },
    );
    assertEq(r.code, 0, 'ffmpeg wrote the tagged MP3');
    assert(existsSync(out), 'the tagged MP3 exists');

    const info: MediaInfo = await probe(bins!.ffprobe, out, dir);
    const tags = readTags(info);

    assertEq(tags.title, 'Tïtle', 'title read');
    assertEq(tags.artist, 'Artïst', 'artist read');
    assertEq(tags.album, 'Albüm', 'album read');
    assertEq(tags.track, '7', 'track read');
    assertEq(tags.year, '2021', 'the date tag is exposed as year');
    assertEq(tags.genre, 'Rock', 'genre read');
    assertEq(tags.comment, 'hi', 'comment read');
    assert(tags.albumArtist === undefined, 'no albumArtist was invented');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTEGRATION: a mis-encoded tag is repaired end to end through ffmpeg and ffprobe', async () => {
  if (skipUnlessAvailable()) return;
  const dir = scratch('mojitag');
  try {
    const out = join(dir, 'moji.mp3');
    // Write the Big5 bytes of 周杰倫 into the ID3 title. ffmpeg stores what it is
    // given, so ffprobe reads back the mis-decoded Latin-1 form.
    const r = await runFfmpeg(
      bins!.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100',
        '-metadata', `title=${BIG5_ZHOU}`,
        '-id3v2_version', '3', '-b:a', '192k',
        out,
      ],
      { cwd: dir },
    );
    assertEq(r.code, 0, 'ffmpeg wrote the mis-encoded MP3');

    const info = await probe(bins!.ffprobe, out, dir);
    const raw = readTags(info).title;
    assert(raw !== undefined && raw.length > 0, 'ffprobe returned a title');

    assertEq(repairMojibake(raw!), '周杰倫', 'the mis-encoded tag round-trips back to 周杰倫');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
