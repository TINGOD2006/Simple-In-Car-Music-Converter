/**
 * Task 9 of docs/superpowers/plans/2026-10-19-youtube-source.md — the download
 * HTTP surface.
 *
 * These drive the REAL server on an ephemeral port with real requests, and
 * inject only the two things a test cannot own: how a URL resolves, and which
 * provider a route uses. Everything else — routing, the JSON contract, the
 * queue's lifecycle, the settings file — is the shipping code path.
 *
 * The one assertion that is not about functionality is the cookie sweep: the
 * `sp_dc` value is the only secret this app stores, and it must appear in NO
 * response body of ANY endpoint.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { assert, assertEq, test } from './harness.ts';
import { startServer } from '../src/server/index.ts';
import { setDownloadOverridesForTests } from '../src/server/download-runtime.ts';
import { DownloadFailure } from '../src/core/download/errors.ts';
import { usbPreset } from '../src/core/edl.ts';
import type {
  DownloadOpts,
  DownloadProvider,
  ResolvedSource,
  TrackMeta,
} from '../src/core/download/types.ts';

const COOKIE = 'sp_dc=abcdef123456';
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function meta(i: number): TrackMeta {
  return {
    title: `Song ${i}`,
    artists: 'Tester',
    album: '',
    durationSec: 100,
    coverUrl: '',
    sourceId: `vid${i}`,
  };
}

function sourceOf(name: string, count: number): ResolvedSource {
  const tracks: TrackMeta[] = [];
  for (let i = 0; i < count; i += 1) tracks.push(meta(i));
  return { platform: 'youtube', kind: 'track', name, tracks };
}

/**
 * A provider that writes `<dest>/<artists> - <title>.webm` after `delayMs`.
 * It writes real bytes, but not decodable audio — the point here is the HTTP
 * lifecycle, not the encoder, which the queue's own suite already covers.
 */
function fileProvider(delayMs: number, calls: string[]): DownloadProvider {
  return {
    id: 'youtube-direct',
    rawExtensions: ['.webm', '.m4a'],
    async resolve(): Promise<ResolvedSource> {
      return sourceOf('never used', 0);
    },
    async download(track: TrackMeta, destDir: string, opts: DownloadOpts): Promise<{ rawPath: string }> {
      calls.push(track.sourceId);
      await sleep(delayMs);
      if (opts.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
      const { writeFileSync } = await import('node:fs');
      const rawPath = join(destDir, `${track.artists} - ${track.title}.webm`);
      writeFileSync(rawPath, Buffer.alloc(4096, 7));
      return { rawPath };
    },
  };
}

interface Ctx {
  base: string;
  dir: string;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aus-dlapi-'));
  const { server, port } = await startServer({
    port: 0,
    scratchRoot: join(dir, 'scratch'),
    settingsDirs: [join(dir, 'config')],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, dir });
  } finally {
    setDownloadOverridesForTests(null);
    await new Promise<void>((r) => (server as Server).close(() => r()));
    // A download outlives the HTTP request that started it by design, so its
    // flush can still hold a handle inside `dir` when this runs. Leaving a temp
    // directory behind is acceptable; failing a green test because the cleanup
    // raced the work it just started is not.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reclaims its own temp directory */
    }
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

async function put(base: string, path: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

async function get(base: string, path: string): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

/* ------------------------------------------------------------------ */
/* resolve                                                             */
/* ------------------------------------------------------------------ */

test('resolve refuses a URL it cannot place, with 400', async () => {
  await withServer(async ({ base }) => {
    const r = await post(base, '/api/download/resolve', { url: 'not-a-url' });
    assertEq(r.status, 400, 'unparseable url is a client error, not a 502');
    assertEq(r.json.ok, false, 'ok:false');
  });
});

test('resolve answers with the resolved source', async () => {
  await withServer(async ({ base }) => {
    setDownloadOverridesForTests({ resolve: async () => sourceOf('Rick Astley', 2) });
    const r = await post(base, '/api/download/resolve', { url: YT_URL });
    assertEq(r.status, 200, '200');
    assertEq(r.json.ok, true, 'ok:true');
    assertEq(r.json.source.platform, 'youtube', 'platform survives the JSON round trip');
    assertEq(r.json.source.tracks.length, 2, 'both tracks are returned');
  });
});

test('resolve reports an upstream failure as 502, not 500', async () => {
  await withServer(async ({ base }) => {
    setDownloadOverridesForTests({
      resolve: async () => {
        throw new Error('yt-dlp exploded');
      },
    });
    const r = await post(base, '/api/download/resolve', { url: YT_URL });
    assertEq(r.status, 502, 'an upstream extraction failure is a bad gateway');
  });
});

test('a link that yields no tracks is a 400, not an upstream failure', async () => {
  await withServer(async ({ base }) => {
    // yt-dlp exited cleanly; the playlist is simply empty or fully
    // unavailable. Nothing upstream is broken, so the link is what is wrong.
    setDownloadOverridesForTests({
      resolve: async () => {
        throw new DownloadFailure(
          'no-tracks',
          '這個連結沒有可下載的曲目（播放清單可能是空的，或所有曲目都無法存取）',
        );
      },
    });
    const r = await post(base, '/api/download/resolve', { url: YT_URL });
    assertEq(r.status, 400, 'an empty source is the client link, not a bad gateway');
    assert(
      r.text.includes('沒有可下載的曲目'),
      `the zh-TW explanation must reach the user, got: ${r.text}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* start / status / cancel                                             */
/* ------------------------------------------------------------------ */

test('start answers 202 and is idempotent while the download is active', async () => {
  await withServer(async ({ base, dir }) => {
    setDownloadOverridesForTests({ providers: { 'youtube-direct': fileProvider(300, []) } });
    const source = sourceOf('Idempotent', 1);
    const body = { source, route: 'youtube-direct', destination: dir, preset: usbPreset() };
    const first = await post(base, '/api/download/start', body);
    assertEq(first.status, 202, '202 accepted');
    assertEq(first.json.ok, true, 'ok:true');
    assert(typeof first.json.downloadId === 'string' && first.json.downloadId.length > 0, 'an id comes back');

    const second = await post(base, '/api/download/start', body);
    assertEq(second.status, 202, '202 again');
    assertEq(second.json.downloadId, first.json.downloadId, 'the same request while active is the same download');
  });
});

test('status 404s for an id nobody started', async () => {
  await withServer(async ({ base }) => {
    const r = await get(base, '/api/download/status?downloadId=nope');
    assertEq(r.status, 404, '404');
    assertEq(r.json.ok, false, 'ok:false');
  });
});

test('start refuses a missing destination with a Traditional Chinese message', async () => {
  await withServer(async ({ base }) => {
    setDownloadOverridesForTests({ providers: { 'youtube-direct': fileProvider(0, []) } });
    const r = await post(base, '/api/download/start', {
      source: sourceOf('No destination', 1),
      route: 'youtube-direct',
      preset: usbPreset(),
    });
    assertEq(r.status, 400, '400');
    assert(typeof r.json.error === 'string' && r.json.error.includes('資料夾'), 'the message names the folder to pick');
  });
});

test('start refuses an unknown route', async () => {
  await withServer(async ({ base, dir }) => {
    const r = await post(base, '/api/download/start', {
      source: sourceOf('Bad route', 1),
      route: 'not-a-route',
      destination: dir,
      preset: usbPreset(),
    });
    assertEq(r.status, 400, '400');
  });
});

test('a YouTube source is forced onto youtube-direct whatever the client asks', async () => {
  await withServer(async ({ base, dir }) => {
    setDownloadOverridesForTests({ providers: { 'youtube-direct': fileProvider(50, []) } });
    const started = await post(base, '/api/download/start', {
      source: sourceOf('Forced', 1),
      route: 'spotify-direct',
      destination: dir,
      preset: usbPreset(),
    });
    assertEq(started.status, 202, '202');
    const status = await get(base, `/api/download/status?downloadId=${started.json.downloadId}`);
    assertEq(status.json.download.route, 'youtube-direct', 'the YouTube platform overrides the requested route');
  });
});

test('status walks a track to a terminal state and reports the record finished', async () => {
  await withServer(async ({ base, dir }) => {
    const calls: string[] = [];
    setDownloadOverridesForTests({ providers: { 'youtube-direct': fileProvider(600, calls) } });
    const started = await post(base, '/api/download/start', {
      source: sourceOf('Walk', 1),
      route: 'youtube-direct',
      destination: dir,
      preset: usbPreset(),
    });
    const id = started.json.downloadId as string;

    const seen = new Set<string>();
    let record: any = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const status = await get(base, `/api/download/status?downloadId=${id}`);
      assertEq(status.status, 200, '200 while polling');
      record = status.json.download;
      for (const t of record.tracks) seen.add(t.state as string);
      if (record.finished) break;
      await sleep(40);
    }
    assert(seen.has('downloading'), `the downloading state is observable (saw ${[...seen].join(',')})`);
    assert(record !== null && record.finished === true, 'the record reports itself finished');
    assertEq(calls.length, 1, 'the provider ran exactly once');
  });
});

test('cancel stops an in-flight download and the record ends cancelled', async () => {
  await withServer(async ({ base, dir }) => {
    // A provider that never returns on its own: cancel is the only way out.
    const provider: DownloadProvider = {
      id: 'youtube-direct',
      rawExtensions: ['.webm'],
      async resolve(): Promise<ResolvedSource> {
        return sourceOf('never used', 0);
      },
      download(_track: TrackMeta, _destDir: string, opts: DownloadOpts): Promise<{ rawPath: string }> {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })),
          );
        });
      },
    };
    setDownloadOverridesForTests({ providers: { 'youtube-direct': provider } });
    const started = await post(base, '/api/download/start', {
      source: sourceOf('Cancel me', 2),
      route: 'youtube-direct',
      destination: dir,
      preset: usbPreset(),
    });
    const id = started.json.downloadId as string;

    const cancelled = await post(base, '/api/download/cancel', { downloadId: id });
    assertEq(cancelled.status, 200, '200');
    assertEq(cancelled.json.ok, true, 'ok:true');

    let record: any = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = await get(base, `/api/download/status?downloadId=${id}`);
      record = status.json.download;
      if (record.finished) break;
      await sleep(30);
    }
    assert(record !== null && record.finished === true, 'the record finishes after cancel');
    const states = record.tracks.map((t: any) => t.state as string);
    assert(states.every((s: string) => s === 'cancelled'), `every track ends cancelled (saw ${states.join(',')})`);
  });
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

test('settings start empty and never echo the cookie', async () => {
  await withServer(async ({ base }) => {
    const fresh = await get(base, '/api/download/settings');
    assertEq(fresh.status, 200, '200');
    assertEq(fresh.json.ok, true, 'ok:true');
    assertEq(fresh.json.spotifyCookieSet, false, 'no cookie stored yet');
    assertEq(fresh.json.destination, null, 'no destination stored yet');

    const put1 = await put(base, '/api/download/settings', { spotifyCookie: COOKIE });
    assertEq(put1.status, 200, 'PUT 200');
    assertEq(put1.json.ok, true, 'PUT ok:true');

    const after = await get(base, '/api/download/settings');
    assertEq(after.json.spotifyCookieSet, true, 'the cookie is now stored');
    assertEq(after.json.cookieHint, 'sp_dc=****3456', 'only the hint comes back');
    assert(!after.text.includes(COOKIE), 'the raw cookie is not in the settings response');
  });
});

test('the cookie appears in no response body of any download endpoint', async () => {
  await withServer(async ({ base, dir }) => {
    setDownloadOverridesForTests({
      resolve: async () => sourceOf('Sweep', 1),
      providers: { 'youtube-direct': fileProvider(50, []) },
    });
    await put(base, '/api/download/settings', { spotifyCookie: COOKIE, destination: dir });
    const started = await post(base, '/api/download/start', {
      source: sourceOf('Sweep', 1),
      route: 'youtube-direct',
      destination: dir,
      preset: usbPreset(),
    });
    const id = String(started.json.downloadId);

    const bodies = [
      (await get(base, '/api/download/settings')).text,
      (await get(base, `/api/download/status?downloadId=${id}`)).text,
      (await post(base, '/api/download/resolve', { url: YT_URL })).text,
      (await post(base, '/api/download/cancel', { downloadId: id })).text,
      (await post(base, '/api/download/retry', { downloadId: id, trackIndices: [0] })).text,
      started.text,
    ];
    for (const body of bodies) {
      assert(!body.includes(COOKIE), `no response body leaks the cookie: ${body.slice(0, 80)}`);
      assert(!body.includes('abcdef123456'), 'not even the tail of the secret leaks');
    }
  });
});

test('settings rejects a cookie that is not an sp_dc value', async () => {
  await withServer(async ({ base }) => {
    const r = await put(base, '/api/download/settings', { spotifyCookie: 'not-a-cookie' });
    assertEq(r.status, 400, '400 for a malformed cookie');
    assertEq(r.json.ok, false, 'ok:false');
  });
});

test('settings remembers a destination', async () => {
  await withServer(async ({ base, dir }) => {
    const target = join(dir, 'Downloads');
    const r = await put(base, '/api/download/settings', { destination: target });
    assertEq(r.status, 200, '200');
    const after = await get(base, '/api/download/settings');
    assertEq(after.json.destination, target, 'the destination round trips');
  });
});
