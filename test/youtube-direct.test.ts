/**
 * Task 6 — the `youtube-direct` provider.
 *
 * Every test injects `run`, because the real `yt-dlp.exe` cannot start under
 * this sandbox (PyInstaller's onefile self-extraction is refused). What the
 * injected runner *writes to disk* is therefore the whole point: the provider
 * discovers the landed file by scanning, so a test that only returned a path
 * from a mock would prove nothing.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, assert, assertEq } from './harness.ts';
import { DownloadFailure } from '../src/core/download/errors.ts';
import {
  createYoutubeDirectProvider,
  type YoutubeDirectDeps,
} from '../src/core/download/providers/youtubeDirect.ts';
import type { YtDlpRunner } from '../src/core/download/sources/youtube.ts';
import type { DownloadOpts, TrackMeta } from '../src/core/download/types.ts';
import type { RunYtDlpResult } from '../src/core/ytdlp.ts';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const META: TrackMeta = {
  title: 'Despacito',
  artists: 'Luis Fonsi',
  album: '',
  durationSec: 281,
  coverUrl: '',
  sourceId: 'kJQP7kiw5Fk',
};

let counter = 0;

function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  counter += 1;
  const dir = join(tmpdir(), 'aus-ytdirect', `${process.pid}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function opts(signal: AbortSignal = new AbortController().signal): DownloadOpts {
  return { destination: 'unused', signal, timeoutMs: 30_000 };
}

/**
 * The stem the provider must build out of `META`, with no extension. This is the
 * exact name the queue's skip rule probes for, so getting it wrong here is the
 * difference between a download landing and being invisible.
 */
const STEM = `${META.artists} - ${META.title}`;

function stemIn(dir: string): string {
  return join(dir, STEM);
}

/** The queue hands `download()` a folder; the `-o` template is `<dir>/<stem>.%(ext)s`. */
function destBaseOf(args: string[]): string {
  const at = args.indexOf('-o');
  const template = at === -1 ? '' : (args[at + 1] ?? '');
  return template.replace(/\.%\(ext\)s$/, '');
}

interface RunCall {
  args: string[];
  cwd: string;
}

/**
 * A runner that performs a caller-supplied side effect, so tests can make the
 * "download" actually leave bytes on disk exactly as yt-dlp would.
 */
function fakeRun(
  behavior: (destBase: string, call: RunCall) => RunYtDlpResult | Promise<RunYtDlpResult>,
  calls: RunCall[] = [],
): YtDlpRunner {
  return async (args, o) => {
    const call: RunCall = { args, cwd: o.cwd };
    calls.push(call);
    return behavior(destBaseOf(args), call);
  };
}

function deps(dir: string, run: YtDlpRunner, find?: () => string): YoutubeDirectDeps {
  return find ? { bin: join(dir, 'yt-dlp.exe'), scratch: dir, run, find } : { bin: join(dir, 'yt-dlp.exe'), scratch: dir, run };
}

function sizeOf(file: string): number {
  return statSync(file).size;
}

function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => new Error('expected a rejection, but it resolved'),
    (err: unknown) => err,
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('the provider is the youtube-direct route with both YouTube containers', () => {
  const provider = createYoutubeDirectProvider({ bin: 'yt-dlp.exe', scratch: '.' });
  assertEq(provider.id, 'youtube-direct', 'id');
  assertEq(provider.rawExtensions.join(','), '.webm,.m4a', 'rawExtensions');
});

test('download builds the measured argument shape', async () => {
  await withScratch(async (dir) => {
    const calls: RunCall[] = [];
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun((destBase) => {
        writeFileSync(`${destBase}.webm`, Buffer.alloc(2048));
        return { code: 0, stderr: '' };
      }, calls)),
    );

    await provider.download(META, dir, opts());

    const args = calls[0]?.args ?? [];
    assert(args.includes('--force-overwrites'), 'force-overwrites is required: the queue owns the skip rule');
    assert(args.includes('bestaudio/best'), `-f bestaudio/best, got ${JSON.stringify(args)}`);
    assertEq(args[args.indexOf('-f') + 1], 'bestaudio/best', 'the format selector follows -f');
    assert(args.includes('--no-playlist'), 'a single video must not expand into a playlist');
    assert(!args.includes('--write-info-json'), 'no sidecar is written; the landed file is discovered');
    assertEq(args[args.indexOf('-o') + 1], `${stemIn(dir)}.%(ext)s`, 'the output template is the queue\'s own skip target');
    assertEq(args[args.length - 1], META.sourceId, 'the video id is the last argument');
    assertEq(args[args.length - 2], '--', 'the id is separated from the options');
    assertEq(calls[0]?.cwd, dir, 'the child runs in the scratch directory');
  });
});

test('download returns the file the runner actually wrote', async () => {
  await withScratch(async (dir) => {
    const destBase = stemIn(dir);
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun((base) => {
        writeFileSync(`${base}.webm`, Buffer.alloc(4096));
        return { code: 0, stderr: '' };
      })),
    );

    const { rawPath } = await provider.download(META, dir, opts());
    assertEq(rawPath, `${destBase}.webm`, 'rawPath is the landed webm');
    assertEq(sizeOf(rawPath), 4096, 'and it is the real file, not a stub');
  });
});

test('cancelling deletes the extension-bearing partial yt-dlp leaves behind', async () => {
  await withScratch(async (dir) => {
    const destBase = stemIn(dir);
    const controller = new AbortController();
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun((base) => {
        // yt-dlp's partial keeps the container extension: <name>.webm.part.
        writeFileSync(`${base}.webm.part`, Buffer.alloc(64));
        controller.abort();
        return { code: 1, cancelled: true, stderr: '' };
      })),
    );

    const err = await rejection(provider.download(META, dir, opts(controller.signal)));
    assert(err instanceof DownloadFailure, `expected a DownloadFailure, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'cancelled', 'reason');
    assertEq(existsSync(`${destBase}.webm.part`), false, 'the .webm.part orphan is gone');
    assertEq(existsSync(`${destBase}.part`), false, 'and so is the extension-less form');
  });
});

test('a sub-1 KB stub is replaced, not treated as a finished download', async () => {
  await withScratch(async (dir) => {
    const destBase = stemIn(dir);
    writeFileSync(`${destBase}.webm`, Buffer.alloc(500));

    const calls: RunCall[] = [];
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun((base) => {
        writeFileSync(`${base}.webm`, Buffer.alloc(3000));
        return { code: 0, stderr: '' };
      }, calls)),
    );

    const { rawPath } = await provider.download(META, dir, opts());
    assertEq(rawPath, `${destBase}.webm`, 'the same target path is reused');
    assertEq(sizeOf(rawPath), 3000, 'the 500-byte stub was overwritten, so --force-overwrites is load-bearing');
    assertEq(calls.length, 1, 'the download ran exactly once');
  });
});

test('an unavailable video surfaces as video-unavailable', async () => {
  await withScratch(async (dir) => {
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun(() => ({
        code: 1,
        stderr: `ERROR: [youtube] ${META.sourceId}: This video is unavailable\n`,
      }))),
    );

    const err = await rejection(provider.download(META, dir, opts()));
    assert(err instanceof DownloadFailure, `expected a DownloadFailure, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'video-unavailable', 'reason');
  });
});

test('a missing binary names the fetch script instead of failing as an i/o error', async () => {
  await withScratch(async (dir) => {
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun(() => ({ code: 0, stderr: '' })), () => {
        throw new Error('no yt-dlp.exe anywhere');
      }),
    );

    const err = await rejection(provider.download(META, dir, opts()));
    assert(err instanceof DownloadFailure, `expected a DownloadFailure, got ${String(err)}`);
    assertEq((err as DownloadFailure).reason, 'ytdlp-missing', 'reason');
    assert((err as Error).message.includes('tools/fetch-ytdlp.mjs'), `the message must name the fix, got ${(err as Error).message}`);
  });
});

test('several landed candidates resolve to the newest, deterministically', async () => {
  await withScratch(async (dir) => {
    const destBase = stemIn(dir);
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun((base) => {
        writeFileSync(`${base}.m4a`, Buffer.alloc(2048));
        // Pin the times so "newest" is a fact rather than a race between writes.
        const older = new Date(Date.now() - 60_000);
        utimesSync(`${base}.m4a`, older, older);
        writeFileSync(`${base}.webm`, Buffer.alloc(4096));
        return { code: 0, stderr: '' };
      })),
    );

    const { rawPath } = await provider.download(META, dir, opts());
    assertEq(rawPath, `${destBase}.webm`, 'the newer of the two containers wins');
    assertEq(readdirSync(dir).filter((n) => n.startsWith(STEM)).length, 2, 'both candidates exist');
  });
});

test('resolve goes through the injected runner, not the real binary', async () => {
  await withScratch(async (dir) => {
    const provider = createYoutubeDirectProvider({
      bin: join(dir, 'yt-dlp.exe'),
      scratch: dir,
      // resolve() exchanges data through --print-to-file, so the fake writes there.
      run: async (args) => {
        const at = args.indexOf('--print-to-file');
        const out = at === -1 ? '' : (args[at + 2] ?? '');
        writeFileSync(out, 'kJQP7kiw5Fk\tA Song\tA Channel\t180\t[]\n');
        return { code: 0, stderr: '' };
      },
    });

    const source = await provider.resolve('https://www.youtube.com/watch?v=kJQP7kiw5Fk');
    assertEq(source.platform, 'youtube', 'platform');
    assertEq(source.kind, 'video', 'kind');
    assertEq(source.tracks.length, 1, 'one track');
    assertEq(source.tracks[0]?.sourceId, 'kJQP7kiw5Fk', 'the row file was read back');
    assertEq(source.tracks[0]?.artists, 'A Channel', 'uploader became the artist');
  });
});

test('an unrecognised URL is refused before any child is started', async () => {
  await withScratch(async (dir) => {
    const calls: RunCall[] = [];
    const provider = createYoutubeDirectProvider(
      deps(dir, fakeRun(() => ({ code: 0, stderr: '' }), calls)),
    );

    const err = await rejection(provider.resolve('https://example.com/nope'));
    assertEq((err as DownloadFailure).reason, 'unsupported-url', 'reason');
    assertEq(calls.length, 0, 'yt-dlp was never invoked');
  });
});
