/**
 * The download tab's wire surface and its pure helpers.
 *
 * Node-only. `api` is plain `fetch`, so one stubbed `globalThis.fetch` records
 * exactly which URL, method and body each download method produced — which is
 * the part the browser cannot check for us. The helpers decide the copy and the
 * default folder, and they are pure functions, so they are asserted directly.
 */

import { assert, assertEq, test } from './harness.ts';
import { api } from '../web/src/api.ts';
import {
  countByState,
  defaultDestinationFor,
  looksLikeYoutubeUrl,
  statusPill,
} from '../web/src/download-helpers.ts';
import type { TrackState } from '../web/src/api-types.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A `fetch` that records every request and answers from a `"METHOD url"` table. */
function stubFetch(
  routes: Record<string, unknown>,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${url}`;
    if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = real;
  });
}

const SOURCE = {
  kind: 'track',
  name: 'Despacito',
  platform: 'youtube',
  tracks: [
    {
      title: 'Despacito',
      artists: 'Luis Fonsi',
      album: '',
      durationSec: 281,
      coverUrl: '',
      sourceId: 'kJQP7kiw5Fk',
    },
  ],
};

const DOWNLOAD = {
  id: 'dl-1',
  route: 'youtube-direct',
  destination: 'E:\\USB\\Downloads\\Despacito',
  sourceName: 'Despacito',
  preset: { container: 'mp3' },
  createdAt: '2026-10-19T00:00:00.000Z',
  finished: false,
  tracks: [{ index: 0, meta: SOURCE.tracks[0], state: 'downloading' }],
};

test('every download method hits its own route, method and body', async () => {
  const routes: Record<string, unknown> = {
    'POST /api/download/resolve': { ok: true, source: SOURCE },
    'POST /api/download/start': { ok: true, downloadId: 'dl-1' },
    'GET /api/download/status?downloadId=dl-1': { ok: true, download: DOWNLOAD },
    'POST /api/download/cancel': { ok: true },
    'POST /api/download/retry': { ok: true },
    'GET /api/download/settings': {
      ok: true,
      spotifyCookieSet: true,
      cookieHint: 'sp_dc=****3456',
      destination: 'E:\\USB\\Downloads',
    },
    'PUT /api/download/settings': { ok: true },
  };

  await stubFetch(routes, async (calls) => {
    const resolved = await api.resolveDownload('https://youtu.be/kJQP7kiw5Fk');
    assertEq(resolved.source.name, 'Despacito', 'resolve returns the source');

    const started = await api.startDownload({
      source: SOURCE as never,
      route: 'youtube-direct',
      destination: 'E:\\USB\\Downloads\\Despacito',
      preset: { container: 'mp3' } as never,
      trackIndices: [0],
    });
    assertEq(started.downloadId, 'dl-1', 'start returns the id');

    const status = await api.downloadStatus('dl-1');
    assertEq(status.download.tracks[0]?.state, 'downloading', 'status carries the track states');

    const cancelled = await api.cancelDownload('dl-1');
    assertEq(cancelled.ok, true, 'cancel reports ok');

    const retried = await api.retryDownload('dl-1', [0]);
    assertEq(retried.ok, true, 'retry reports ok');

    const settings = await api.getDownloadSettings();
    assertEq(settings.spotifyCookieSet, true, 'settings reports a stored cookie');
    assertEq(settings.cookieHint, 'sp_dc=****3456', 'settings carries only the hint');
    assertEq(settings.destination, 'E:\\USB\\Downloads', 'settings carries the destination');

    await api.putDownloadSettings({ destination: 'F:\\Stick\\Downloads' });

    assertEq(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'POST /api/download/resolve',
        'POST /api/download/start',
        'GET /api/download/status?downloadId=dl-1',
        'POST /api/download/cancel',
        'POST /api/download/retry',
        'GET /api/download/settings',
        'PUT /api/download/settings',
      ],
      'each method owns exactly one route',
    );

    assertEq(calls[0]?.body, { url: 'https://youtu.be/kJQP7kiw5Fk' }, 'resolve posts the url');
    assertEq(
      calls[1]?.body,
      {
        source: SOURCE,
        route: 'youtube-direct',
        destination: 'E:\\USB\\Downloads\\Despacito',
        preset: { container: 'mp3' },
        trackIndices: [0],
      },
      'start posts the whole request',
    );
    assertEq(calls[3]?.body, { downloadId: 'dl-1' }, 'cancel names the download');
    assertEq(calls[4]?.body, { downloadId: 'dl-1', trackIndices: [0] }, 'retry names the tracks');
    assertEq(
      calls[6]?.body,
      { destination: 'F:\\Stick\\Downloads' },
      'settings PUT sends only what it was given — never an empty cookie',
    );
  });
});

test('the downloadId is query-encoded, so an id with a slash cannot break the route', async () => {
  await stubFetch({ 'GET /api/download/status?downloadId=a%2Fb': { ok: true, download: DOWNLOAD } }, async (calls) => {
    await api.downloadStatus('a/b');
    assertEq(calls[0]?.url, '/api/download/status?downloadId=a%2Fb', 'id is encoded');
  });
});

test('defaultDestinationFor puts the source under a Downloads folder beside the stick', () => {
  assertEq(
    defaultDestinationFor('E:\\USB', 'Top Hits 2026'),
    'E:\\USB\\Downloads\\Top Hits 2026',
    'a plain name is appended verbatim',
  );
  assertEq(
    defaultDestinationFor('E:\\USB\\', 'Top Hits'),
    'E:\\USB\\Downloads\\Top Hits',
    'a trailing separator does not double up',
  );
  assertEq(
    defaultDestinationFor('/', 'Top Hits'),
    '/Downloads/Top Hits',
    'a posix working folder keeps its own separator',
  );
  assertEq(
    defaultDestinationFor('E:\\USB', 'AC/DC: Live? *2026*'),
    'E:\\USB\\Downloads\\AC DC Live 2026',
    'a name that cannot be a single path segment is cleaned, not escaped',
  );
  assertEq(
    defaultDestinationFor('E:\\USB', '   '),
    'E:\\USB\\Downloads\\下載',
    'a name with nothing usable falls back to a readable label',
  );
});

test('statusPill names every state in Traditional Chinese', () => {
  const states: TrackState[] = [
    'queued',
    'downloading',
    'tagging',
    'converting',
    'done',
    'failed',
    'skipped',
    'cancelled',
  ];
  for (const state of states) {
    const pill = statusPill(state);
    assert(pill.length > 0, `every state needs a label: ${state}`);
    assert(!pill.includes(state), `the label must be copy, not the raw state: ${state} -> ${pill}`);
  }
  assert(statusPill('failed').includes('失敗'), 'failed reads 失敗');
  assert(statusPill('done').includes('完成'), 'done reads 完成');
  assert(statusPill('skipped').includes('略過'), 'skipped reads 略過');
  assert(statusPill('cancelled').includes('取消'), 'cancelled reads 取消');
});

test('countByState tallies the progress table without inventing states', () => {
  const tracks = [
    { state: 'done' as TrackState },
    { state: 'done' as TrackState },
    { state: 'failed' as TrackState },
    { state: 'queued' as TrackState },
  ];
  const counts = countByState(tracks);
  assertEq(counts.done, 2, 'two finished');
  assertEq(counts.failed, 1, 'one failed');
  assertEq(counts.queued, 1, 'one still waiting');
  assertEq(counts.downloading, 0, 'an absent state counts as zero');
  assertEq(countByState([]).done, 0, 'an empty queue is all zeros');
});

test('looksLikeYoutubeUrl mirrors the engine\u2019s accepted table', () => {
  const id = 'kJQP7kiw5Fk';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/watch?v=${id}&list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA`,
    'https://www.youtube.com/playlist?list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA',
    'https://music.youtube.com/playlist?list=OLAK5uy_nvZ8-4QLd50AUrhuA-KWpSE965WLRlkqw',
    'https://music.youtube.com/browse/MPREb_p8vQOVQIe2S5',
  ]) {
    assert(looksLikeYoutubeUrl(url), `must look like a YouTube link: ${url}`);
  }
  for (const bad of [
    'https://example.com/watch?v=' + id,
    'https://www.youtube.com/',
    'https://www.youtube.com/@RickAstleyYT',
    'https://www.youtube.com/results?search_query=despacito',
    'not a url',
    '',
  ]) {
    assert(!looksLikeYoutubeUrl(bad), `must not look like a YouTube link: ${bad}`);
  }
});
