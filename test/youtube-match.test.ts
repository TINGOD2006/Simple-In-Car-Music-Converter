/**
 * YouTube-match provider tests (`src/core/download/providers/youtubeMatch.ts`).
 *
 * The scoring table is pure — no network. The search and the fetch both shell
 * out to yt-dlp, which cannot run under this sandbox, so every test injects the
 * runner and asserts what yt-dlp would have been asked to do.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import {
  CONFIDENCE_FLOOR,
  createYoutubeMatchProvider,
  normalizeTitle,
  pickCandidate,
  scoreCandidates,
} from '../src/core/download/providers/youtubeMatch.ts';
import { DownloadFailure } from '../src/core/download/errors.ts';
import { SEARCH_LIMIT, type YouTubeSongRow } from '../src/core/download/sources/youtube.ts';
import type { DownloadOpts, TrackMeta } from '../src/core/download/types.ts';

const META: TrackMeta = {
  title: 'Back In Black',
  artists: 'AC/DC',
  album: 'Back In Black',
  durationSec: 255,
  coverUrl: '',
  sourceId: '4uLU6hMCjMI75M1A2tKUQC',
};

/** The stem the queue's skip rule probes; `sanitizeFilename` turns `/` into a space. */
const STEM = 'AC DC - Back In Black';

let counter = 0;

function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  counter += 1;
  const dir = join(tmpdir(), 'aus-ytmatch', `${process.pid}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function opts(signal: AbortSignal = new AbortController().signal): DownloadOpts {
  return { destination: 'unused', signal, timeoutMs: 5000 };
}

/** The `--print-to-file` argument pair is `<template> <file>`. */
function rowsFileOf(args: string[]): string {
  return args[args.indexOf('--print-to-file') + 2] ?? '';
}

/** The `-o` template yt-dlp was given, as a `--print-to-file`-style row file. */
function rowLine(over: Record<string, string> = {}): string {
  const cols = {
    id: 'vid1',
    title: 'Back In Black',
    uploader: 'AC/DC',
    duration: '255',
    thumbnails: '[]',
    ...over,
  };
  return `${cols.id}\t${cols.title}\t${cols.uploader}\t${cols.duration}\t${cols.thumbnails}\n`;
}

function cand(over: Partial<YouTubeSongRow>): YouTubeSongRow {
  return {
    videoId: 'v1',
    title: 'Back In Black',
    artistName: 'AC/DC',
    albumName: 'Back In Black',
    durationSec: 255,
    thumbnailUrl: '',
    ...over,
  };
}

test('the channel prefix and guest credit in a YouTube title do not sink the right video', () => {
  // Measured against the live search (R8): scoring the raw title gave this exact
  // upload — right video, right duration — 64 against a floor of 70, so Route B
  // refused to download "Despacito" at all.
  const official = cand({
    videoId: 'official',
    title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
    artistName: 'Luis Fonsi',
    durationSec: 282,
  });
  const meta: TrackMeta = { ...META, title: 'Despacito', artists: 'Luis Fonsi', durationSec: 281 };

  const scored = scoreCandidates([official], meta);
  assert(scored[0] !== undefined, 'one candidate');
  assert(
    scored[0].score >= CONFIDENCE_FLOOR,
    `the official upload must clear the floor, got ${scored[0].score}`,
  );
  assertEq(pickCandidate([official], meta)?.videoId, 'official', 'and so it is picked');
});

test('an en-dash channel prefix is stripped as well as a hyphen', () => {
  const official = cand({
    videoId: 'official',
    title: 'Queen – Bohemian Rhapsody (Official Video Remastered)',
    artistName: 'Queen Official',
    durationSec: 360,
  });
  const meta: TrackMeta = { ...META, title: 'Bohemian Rhapsody', artists: 'Queen', durationSec: 355 };

  const scored = scoreCandidates([official], meta);
  assert(scored[0] !== undefined, 'one candidate');
  assert(
    scored[0].score >= CONFIDENCE_FLOOR,
    `a 5 s official-vs-stream delta must stay above the floor, got ${scored[0].score}`,
  );
  assertEq(pickCandidate([official], meta)?.videoId, 'official', 'the closest official upload still wins the fallback window');
});

test('normalizeTitle strips parenthetical qualifiers and collapses spaces', () => {
  assertEq(normalizeTitle('Back In Black (Official Audio)'), 'back in black', 'parenthetical stripped');
  assertEq(normalizeTitle('Back In Black  (HD) (Lyrics)'), 'back in black', 'multiple qualifiers stripped');
  assertEq(normalizeTitle('  BACK   IN   black '), 'back in black', 'lowercase + collapse');
});

test('duration gate: within ±3 s passes, farther fails', () => {
  const near = cand({ durationSec: 256 });
  const far = cand({ durationSec: 262 });
  const scored = scoreCandidates([near, far], META);
  assertEq(scored[0]?.passedGate, true, '1 s off passes the gate');
  assertEq(scored[1]?.passedGate, false, '7 s off fails the gate');
});

test('all gate-fail but closest within 10 s wins', () => {
  const cands = [
    cand({ videoId: 'a', durationSec: META.durationSec + 6, title: 'Back In Black' }),
    cand({ videoId: 'b', durationSec: META.durationSec + 8, title: 'Back In Black' }),
  ];
  const picked = pickCandidate(cands, META);
  assertEq(picked?.videoId, 'a', 'the closest duration wins the fallback window');
});

test('all gate-fail and beyond 10 s → null', () => {
  const cands = [
    cand({ videoId: 'a', durationSec: META.durationSec + 20 }),
    cand({ videoId: 'b', durationSec: META.durationSec + 25 }),
  ];
  assertEq(pickCandidate(cands, META), null, 'nothing within the fallback window');
});

test('official -Topic channel beats an equal upload', () => {
  const cands = [
    cand({ videoId: 'topic', artistName: 'AC/DC - Topic' }),
    cand({ videoId: 'plain', artistName: 'AC/DC' }),
  ];
  const picked = pickCandidate(cands, META);
  assertEq(picked?.videoId, 'topic', 'the Topic bonus tips an otherwise equal pair');
});

test('token overlap: extra "Live" token loses to the exact title', () => {
  const cands = [
    cand({ videoId: 'live', title: 'Neon Lights Live' }),
    cand({ videoId: 'exact', title: 'Neon Lights' }),
  ];
  const meta: TrackMeta = { ...META, title: 'Neon Lights', durationSec: 200 };
  const c1 = cand({ videoId: 'live', title: 'Neon Lights Live', durationSec: 200 });
  const c2 = cand({ videoId: 'exact', title: 'Neon Lights', durationSec: 200 });
  assertEq(pickCandidate([c1, c2], meta)?.videoId, 'exact', 'exact title beats the Live variant');
  void cands;
});

test('best score below CONFIDENCE_FLOOR → null (no-confident-match)', () => {
  const unrelated = cand({ title: 'Random Unrelated Thing', durationSec: META.durationSec + 1 });
  const scored = scoreCandidates([unrelated], META);
  const best = scored[0];
  assert(best !== undefined, 'one scored candidate');
  assert(best.score < CONFIDENCE_FLOOR, 'an unrelated title must score below the floor');
  assertEq(pickCandidate([unrelated], META), null, 'below the floor nothing is picked');
});

test('"with" inside a real title is not treated as a guest credit', () => {
  // Measured regression: the featuring rule matched a bare `with`, so the exact
  // official upload of a track whose own title contains the word had its title
  // truncated to "Rock", losing 2 of 3 tokens — 69.33 against a floor of 70 —
  // and the track was reported as having no confident match at all.
  const meta: TrackMeta = { ...META, title: 'Rock with You', artists: 'Michael Jackson', durationSec: 220 };
  const exact = cand({
    videoId: 'exact',
    title: 'Rock with You (Official Video)',
    artistName: 'Michael Jackson',
    durationSec: 222,
  });

  const scored = scoreCandidates([exact], meta)[0];
  assert(scored !== undefined, 'one scored candidate');
  assert(
    scored.score >= CONFIDENCE_FLOOR,
    `the exact upload must clear the floor, scored ${scored.score}`,
  );
  assertEq(pickCandidate([exact], meta)?.videoId, 'exact', 'the exact upload must be picked');
});

test('a genuine guest credit is still stripped', () => {
  const meta: TrackMeta = { ...META, title: 'Despacito', artists: 'Luis Fonsi', durationSec: 281 };
  const credited = cand({
    videoId: 'credited',
    title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
    artistName: 'Luis Fonsi',
    durationSec: 281,
  });

  assertEq(pickCandidate([credited], meta)?.videoId, 'credited', 'ft. is a credit, not a mismatch');
});

test('search asks yt-dlp for a bounded ytsearch of "artists title"', async () => {
  await withScratch(async (dir) => {
    const calls: string[][] = [];
    const provider = createYoutubeMatchProvider({
      bin: join(dir, 'yt-dlp.exe'),
      scratch: dir,
      run: async (args) => {
        calls.push(args);
        writeFileSync(rowsFileOf(args), rowLine({ uploader: 'AC/DC - Topic' }));
        return { code: 0, stderr: '' };
      },
      download: async () => ({ rawPath: join(dir, `${STEM}.webm`) }),
    });

    await provider.download(META, dir, opts());

    const args = calls[0] ?? [];
    assert(args.includes('--flat-playlist'), 'the search reuses the resolve invocation');
    assert(args.includes('--simulate'), 'a search downloads nothing');
    assert(rowsFileOf(args) !== '', 'the rows go to a file, never to stdout the sandbox discards');
    assertEq(args[args.length - 1], `ytsearch${SEARCH_LIMIT}:AC/DC Back In Black`, 'the query is the last argument');
  });
});

test('rows carry yt-dlp\'s columns into the scorer, and an unmeasurable duration still ranks', async () => {
  await withScratch(async (dir) => {
    const picked: string[] = [];
    const provider = createYoutubeMatchProvider({
      bin: join(dir, 'yt-dlp.exe'),
      scratch: dir,
      run: async (args) => {
        // Two candidates: one yt-dlp could not measure, one it could.
        writeFileSync(
          rowsFileOf(args),
          rowLine({ id: 'unknown', duration: 'NA' }) + rowLine({ id: 'exact', duration: '255' }),
        );
        return { code: 0, stderr: '' };
      },
      download: async (videoId) => {
        picked.push(videoId);
        return { rawPath: join(dir, `${STEM}.webm`) };
      },
    });

    await provider.download(META, dir, opts());
    assertEq(picked.join(','), 'exact', 'the measurable duration beats the unmeasurable one');
  });
});

test('the best-scoring candidate is the one that gets fetched', async () => {
  await withScratch(async (dir) => {
    const picked: string[] = [];
    const provider = createYoutubeMatchProvider({
      search: async () => [
        cand({ videoId: 'plain', artistName: 'AC/DC' }),
        cand({ videoId: 'topic', artistName: 'AC/DC - Topic' }),
      ],
      download: async (videoId) => {
        picked.push(videoId);
        return { rawPath: join(dir, `${STEM}.webm`) };
      },
    });

    await provider.download(META, dir, opts());
    assertEq(picked.join(','), 'topic', 'the Topic bonus decided it');
  });
});

test('the matched video is fetched with the youtube-direct command, into the queue\'s own file name', async () => {
  await withScratch(async (dir) => {
    const calls: string[][] = [];
    const provider = createYoutubeMatchProvider({
      bin: join(dir, 'yt-dlp.exe'),
      scratch: dir,
      search: async () => [cand({ videoId: 'vid1', artistName: 'AC/DC - Topic' })],
      run: async (args) => {
        calls.push(args);
        const template = args[args.indexOf('-o') + 1] ?? '';
        writeFileSync(`${template.replace(/\.%\(ext\)s$/, '')}.webm`, Buffer.alloc(4096));
        return { code: 0, stderr: '' };
      },
    });

    const { rawPath } = await provider.download(META, dir, opts());

    assertEq(rawPath, join(dir, `${STEM}.webm`), 'the file lands where the queue skip rule probes');
    assertEq(existsSync(rawPath), true, 'and it is the file the runner actually wrote');
    const args = calls[0] ?? [];
    assertEq(args[args.indexOf('-f') + 1], 'bestaudio/best', 'the same format selector as youtube-direct');
    assert(args.includes('--no-playlist'), 'the same playlist policy');
    assert(args.includes('--force-overwrites'), 'the same overwrite policy');
    assertEq(args[args.indexOf('-o') + 1], join(dir, `${STEM}.%(ext)s`), 'the same output template as youtube-direct');
    assertEq(args[args.length - 1], 'vid1', 'the matched video id is fetched, not the Spotify id');
    assertEq(args[args.length - 2], '--', 'and it is separated from the options');
  });
});

test('an empty search result never starts a download', async () => {
  await withScratch(async (dir) => {
    const calls: string[][] = [];
    const provider = createYoutubeMatchProvider({
      search: async () => [],
      run: async (args) => {
        calls.push(args);
        return { code: 0, stderr: '' };
      },
    });

    let caught: unknown;
    try {
      await provider.download(META, dir, opts());
    } catch (err) {
      caught = err;
    }
    assertEq(calls.length, 0, 'a search that matched nothing must not reach yt-dlp');
    assert(caught instanceof DownloadFailure, 'a DownloadFailure is thrown');
    assertEq((caught as DownloadFailure).reason, 'no-confident-match', 'failure reason');
  });
});

test('provider rejects with reason no-confident-match when nothing scores', async () => {
  const provider = createYoutubeMatchProvider({ search: async () => [] });
  let caught: unknown;
  try {
    await provider.download(META, join(tmpdir(), 'aus-ytdl-none'), {
      destination: join(tmpdir(), 'aus-ytdl-none'),
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof DownloadFailure, 'a DownloadFailure is thrown');
  assertEq((caught as DownloadFailure).reason, 'no-confident-match', 'failure reason');
});
