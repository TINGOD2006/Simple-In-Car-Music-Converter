/**
 * Resolving a YouTube URL into tracks (plan Task 5).
 *
 * The real `yt-dlp.exe` cannot execute in this sandbox, so every test injects a
 * runner that writes a fixture TSV where `--print-to-file` told it to. What is
 * under test is the mapping from those five columns onto `TrackMeta`, the
 * handling of rows that are missing pieces, and the argument shape that keeps
 * data flowing through a file rather than the stdout this process discards.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import { DownloadFailure } from '../src/core/download/errors.ts';
import { PlaylistTooLargeError, resolveAnySource, sanitizeFilename } from '../src/core/download/resolve.ts';
import { resolveYouTubeSource, type YtDlpRunner } from '../src/core/download/sources/youtube.ts';
import type { SpotifyApiTrack, SpotifyClient } from '../src/core/download/types.ts';
import type { RunYtDlpResult } from '../src/core/ytdlp.ts';

const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA';
const VIDEO_URL = 'https://www.youtube.com/watch?v=vid00000001';

/* ------------------------------------------------------------------ */

interface RunnerCall {
  args: string[];
  cwd: string;
}

function row(id: string, title: string, uploader: string, duration: string, thumbs: unknown): string {
  return [id, title, uploader, duration, JSON.stringify(thumbs)].join('\t');
}

/** A runner that materialises `rows` into the file `--print-to-file` names. */
function fakeRunner(
  rows: string[],
  result: Partial<RunYtDlpResult> = {},
  calls: RunnerCall[] = [],
): YtDlpRunner {
  return async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const flag = args.indexOf('--print-to-file');
    if (flag >= 0) {
      const out = args[flag + 2];
      if (out) writeFileSync(out, rows.length > 0 ? `${rows.join('\n')}\n` : '');
    }
    return { code: 0, stderr: '', ...result };
  };
}

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aus-ytsrc-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function deps(dir: string, run: YtDlpRunner) {
  return { bin: 'yt-dlp.exe', scratch: dir, run };
}

/** 11-character ids, two thumbnails each, ascending durations. */
function playlistRows(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    row(
      `vid${String(i).padStart(8, '0')}`,
      `Song ${i}`,
      `Artist ${i}`,
      String(180 + i),
      [
        { url: `https://i.ytimg.com/vi/v${i}/hqdefault.jpg`, width: 480, height: 360 },
        { url: `https://i.ytimg.com/vi/v${i}/maxresdefault.jpg`, width: 1280, height: 720 },
      ],
    ),
  );
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

/* ------------------------------------------------------------------ */

test('resolveYouTubeSource maps every row of a playlist TSV', async () => {
  await withScratch(async (dir) => {
    const calls: RunnerCall[] = [];
    const res = await resolveYouTubeSource(PLAYLIST_URL, deps(dir, fakeRunner(playlistRows(11), {}, calls)));

    assertEq(res.platform, 'youtube', 'platform');
    assertEq(res.kind, 'playlist', 'kind');
    assertEq(res.tracks.length, 11, 'every row becomes a track');
    assertEq(res.tracks[0]?.title, 'Song 0', 'title');
    assertEq(res.tracks[0]?.artists, 'Artist 0', 'artists come from uploader');
    assertEq(res.tracks[0]?.durationSec, 180, 'duration is seconds');
    assertEq(res.tracks[0]?.album, '', 'yt-dlp carries no album');
    assertEq(res.tracks[0]?.sourceId, 'vid00000000', 'sourceId comes from id');
    assertEq(
      res.tracks[0]?.coverUrl,
      'https://i.ytimg.com/vi/v0/maxresdefault.jpg',
      'cover is the LAST thumbnail',
    );
    assertEq(res.tracks[10]?.title, 'Song 10', 'the last row maps too');
    assertEq(calls.length, 1, 'exactly one yt-dlp call');
    assertEq(calls[0]?.cwd, dir, 'the child runs in the scratch dir');
  });
});

test('a single-video URL resolves to one track', async () => {
  await withScratch(async (dir) => {
    const res = await resolveYouTubeSource(VIDEO_URL, deps(dir, fakeRunner(playlistRows(1))));
    assertEq(res.kind, 'video', 'a watch URL is one video');
    assertEq(res.tracks.length, 1, 'one track');
    assertEq(res.name, 'Song 0', 'named after the video title');
  });
});

test('missing row fields degrade to safe values, never undefined', async () => {
  await withScratch(async (dir) => {
    const rows = [
      ['vid00000001', 'Bare Title', '', '', '[]'].join('\t'),
      ['vid00000002', 'Empty Thumbs', 'Someone', '200', '[]'].join('\t'),
      ['vid00000003', 'Truncated Thumbs', 'Someone', '90', '[{"url": "https://x/y.jpg"'].join('\t'),
    ];
    const res = await resolveYouTubeSource(PLAYLIST_URL, deps(dir, fakeRunner(rows)));
    const [bare, empty, broken] = res.tracks;

    assertEq(bare?.durationSec, 0, 'an empty duration column is 0, not NaN');
    assertEq(bare?.artists, 'YouTube', 'a missing uploader falls back to YouTube');
    assertEq(bare?.coverUrl, '', 'an empty thumbnail list has no cover');
    assertEq(empty?.coverUrl, '', 'an empty thumbnail list has no cover');
    assertEq(broken?.coverUrl, '', 'truncated thumbnail JSON degrades to no cover');
    assertEq(broken?.durationSec, 90, 'a parse failure does not lose the row');

    const named = sanitizeFilename(`${bare?.artists} - ${bare?.title}`);
    assert(!named.includes('undefined'), `the filename must never contain undefined: ${named}`);
    assertEq(named, 'YouTube - Bare Title', 'filename from fallback artist and title');
  });
});

test('a successful run with no rows is a zh-TW failure, not an empty success', async () => {
  await withScratch(async (dir) => {
    const err = await rejection(resolveYouTubeSource(PLAYLIST_URL, deps(dir, fakeRunner([]))));
    assert(err instanceof DownloadFailure, `a DownloadFailure is thrown, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'no-tracks', 'reason');
    assert(
      (err as Error).message.includes('沒有可下載的曲目'),
      `the message is zh-TW and actionable: ${(err as Error).message}`,
    );
  });
});

test('an unavailable video surfaces as video-unavailable', async () => {
  await withScratch(async (dir) => {
    const err = await rejection(
      resolveYouTubeSource(
        VIDEO_URL,
        deps(dir, fakeRunner([], { code: 1, stderr: 'ERROR: [youtube] vid00000001: This video is unavailable\n' })),
      ),
    );
    assert(err instanceof DownloadFailure, `a DownloadFailure is thrown, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'video-unavailable', 'reason');
  });
});

test('more than 200 rows hits the playlist cap', async () => {
  await withScratch(async (dir) => {
    const err = await rejection(resolveYouTubeSource(PLAYLIST_URL, deps(dir, fakeRunner(playlistRows(201)))));
    assert(err instanceof PlaylistTooLargeError, `the cap error is thrown, got ${String(err)}`);
    const message = (err as Error).message;
    assert(message.includes('200'), `the cap is named: ${message}`);
    assert(message.includes('拆分播放清單'), `the advice is zh-TW: ${message}`);
  });
});

test('the resolve command prints to a file and never uses -J', async () => {
  await withScratch(async (dir) => {
    const calls: RunnerCall[] = [];
    await resolveYouTubeSource(PLAYLIST_URL, deps(dir, fakeRunner(playlistRows(2), {}, calls)));
    const args = calls[0]?.args ?? [];

    assert(args.includes('--print-to-file'), 'structured data goes to a file');
    assert(args.includes('--flat-playlist'), 'every playlist entry is enumerated');
    assert(args.includes('--simulate'), 'resolving must not download');
    assert(args.includes('--no-warnings'), 'warnings would pollute the stderr report');
    assert(!args.includes('-J'), '-J prints to the stdout this process discards');
    assert(!args.includes('--write-info-json'), 'write-info-json cannot resolve a playlist');
    assertEq(args[args.length - 1], PLAYLIST_URL, 'the URL is the last argument');
    assertEq(args[args.indexOf('--print-to-file') + 1]?.includes('%(id)s'), true, 'the template emits ids');
  });
});

test('resolveAnySource routes by platform and refuses anything else', async () => {
  await withScratch(async (dir) => {
    const ytCalls: RunnerCall[] = [];
    const yt = await resolveAnySource(PLAYLIST_URL, null, deps(dir, fakeRunner(playlistRows(2), {}, ytCalls)));
    assertEq(yt.platform, 'youtube', 'a YouTube URL takes the YouTube path');
    assertEq(ytCalls.length, 1, 'yt-dlp ran once');

    const apiTrack: SpotifyApiTrack = {
      id: '4uLU6hMCjMI75M1A2tKUQC',
      name: 'Hells Bells',
      artists: [{ name: 'AC/DC' }],
      album: { name: 'Back In Black', images: [{ url: 'https://i.scdn.co/a.jpg' }] },
      duration_ms: 312000,
    };
    // `SpotifyClient.request` is generic; the fake has to be too, and the cast is
    // the same one every other fake client in this suite makes.
    const client: SpotifyClient = {
      request<T>(_fullUrl: string): Promise<T> {
        return Promise.resolve(apiTrack as unknown as T);
      },
    };
    const spotify = await resolveAnySource(
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      client,
      deps(dir, fakeRunner([])),
    );
    assertEq(spotify.platform, 'spotify', 'a Spotify URL takes the Spotify path');
    assertEq(spotify.tracks[0]?.title, 'Hells Bells', 'Spotify metadata still resolves');

    const err = await rejection(resolveAnySource('https://example.com/whatever', null, deps(dir, fakeRunner([]))));
    assert(err instanceof DownloadFailure, `an unknown host fails typed, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'unsupported-url', 'reason');
  });
});
