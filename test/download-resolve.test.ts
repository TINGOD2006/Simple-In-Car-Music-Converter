/**
 * Spotify URL parsing, metadata resolve and filename sanitizing tests
 * (`src/core/download/types.ts` + `resolve.ts`).
 *
 * All network paths go through injected client doubles (structural
 * `SpotifyClient` = `{ request<T>(fullUrl): Promise<T> }`, matching the vendor
 * façade whose `request()` takes FULL URLs); the oEmbed fallback is exercised
 * by stubbing `globalThis.fetch`. The real Spotify client is Task 9's smoke
 * script — nothing here touches the network.
 */

import { assert, assertEq, test } from './harness.ts';
import {
  parseSpotifyUrl,
  resolveSource,
  sanitizeFilename,
  trackToMeta,
} from '../src/core/download/resolve.ts';
import type { SpotifyClient, SpotifyApiTrack } from '../src/core/download/types.ts';

interface DoubleRoute {
  match: RegExp;
  body: unknown;
}

function fakeClient(routes: DoubleRoute[]): SpotifyClient {
  return {
    async request<T>(fullUrl: string): Promise<T> {
      const hit = routes.find((r) => r.match.test(fullUrl));
      if (!hit) throw new Error('unexpected URL: ' + fullUrl);
      return hit.body as T;
    },
  };
}

function withStubbedFetch(payload: unknown, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

test('parseSpotifyUrl accepts every documented link form', () => {
  const id = '4uLU6hMCjMI75M1A2tKUQC';
  const cases: Array<[string, { kind: string; id: string }]> = [
    [`https://open.spotify.com/track/${id}`, { kind: 'track', id }],
    [`https://open.spotify.com/track/${id}?si=abc123`, { kind: 'track', id }],
    [`HTTPS://OPEN.SPOTIFY.COM/TRACK/${id}/`, { kind: 'track', id }],
    [`https://open.spotify.com/track/${id}/extra`, { kind: 'track', id }],
    [`https://open.spotify.com/intl-zht/track/${id}`, { kind: 'track', id }],
    [`spotify:track:${id}`, { kind: 'track', id }],
    ['https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', { kind: 'album', id: '1DFixLWuPkv3KT3TnV35m3' }],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x', { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' }],
  ];
  for (const [url, expected] of cases) {
    assertEq(parseSpotifyUrl(url), expected, `link form must parse: ${url}`);
  }
});

test('parseSpotifyUrl rejects non-Spotify and unknown-kind links', () => {
  for (const bad of [
    'https://example.com/track/x',
    'https://open.spotify.com/genre/x',
    'https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC',
    '',
    'not a url at all',
  ]) {
    assertEq(parseSpotifyUrl(bad), null, `must reject: ${bad}`);
  }
});

test('sanitizeFilename survives filesystem-hostile titles', () => {
  assertEq(sanitizeFilename('AC/DC: Back In Black?'), 'AC DC Back In Black', 'hostile punctuation becomes spaces, collapsed');
  assertEq(sanitizeFilename('A\x00B\x1FC'), 'ABC', 'control characters are stripped outright');
  assertEq(sanitizeFilename('a'.repeat(200)).length, 120, '200-char input truncates to the 120-char default');
  assertEq(sanitizeFilename('🎵 Hello 🎵'), '🎵 Hello 🎵', 'emoji is preserved');
  const manyEmoji = '🎵'.repeat(130);
  const cut = sanitizeFilename(manyEmoji);
  assert(Array.from(cut).length <= 120 && Array.from(cut).join('') === cut, 'emoji truncation never splits a surrogate pair');
  assertEq(sanitizeFilename('   ///  '), 'track', 'empty result falls back to "track"');
});

test('trackToMeta maps the Web API shape onto TrackMeta', () => {
  const apiTrack: SpotifyApiTrack = {
    id: '4uLU6hMCjMI75M1A2tKUQC',
    name: 'Back In Black',
    artists: [{ name: 'AC/DC' }, { name: 'Guest' }],
    album: {
      name: 'Back In Black',
      images: [{ url: 'https://i.scdn.co/a.jpg' }, { url: 'https://i.scdn.co/b.jpg' }],
    },
    duration_ms: 255000,
    track_number: 1,
    disc_number: 1,
    is_local: false,
  };
  assertEq(trackToMeta(apiTrack), {
    title: 'Back In Black',
    artists: 'AC/DC, Guest',
    album: 'Back In Black',
    durationSec: 255,
    coverUrl: 'https://i.scdn.co/a.jpg',
    spotifyId: '4uLU6hMCjMI75M1A2tKUQC',
  }, 'meta mapping: artists joined, ms→s, first image');
});

test('resolveSource maps a track through the client', async () => {
  const apiTrack: SpotifyApiTrack = {
    id: '4uLU6hMCjMI75M1A2tKUQC',
    name: 'Hells Bells',
    artists: [{ name: 'AC/DC' }],
    album: { name: 'Back In Black', images: [{ url: 'https://i.scdn.co/a.jpg' }] },
    duration_ms: 312000,
  };
  const client = fakeClient([{ match: /api\.spotify\.com\/v1\/tracks\/4uLU6hMCjMI75M1A2tKUQC/, body: apiTrack }]);
  const resolved = await resolveSource('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', client);
  assertEq(resolved.kind, 'track', 'kind');
  assertEq(resolved.name, 'Hells Bells', 'source name');
  assertEq(resolved.tracks.length, 1, 'one track');
  assertEq(resolved.tracks[0]?.title, 'Hells Bells', 'track title');
  assertEq(resolved.partial, undefined, 'not partial');
});

test('resolveSource maps an album with album-level cover art', async () => {
  const body = {
    name: 'Dirty Deeds',
    images: [{ url: 'https://i.scdn.co/album.jpg' }],
    tracks: {
      items: [
        { id: 't1', name: 'AA', artists: [{ name: 'X' }], duration_ms: 100000, track_number: 1, disc_number: 1 },
        { id: 't2', name: 'BB', artists: [{ name: 'X' }], duration_ms: 200000, track_number: 2, disc_number: 1 },
      ],
      next: null,
    },
  };
  const client = fakeClient([{ match: /api\.spotify\.com\/v1\/albums\/1DFixLWuPkv3KT3TnV35m3/, body }]);
  const resolved = await resolveSource('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', client);
  assertEq(resolved.kind, 'album', 'kind');
  assertEq(resolved.name, 'Dirty Deeds', 'source name');
  assertEq(resolved.tracks.length, 2, 'two tracks');
  for (const t of resolved.tracks) {
    assertEq(t.coverUrl, 'https://i.scdn.co/album.jpg', 'album-level image feeds every track');
    assertEq(t.album, 'Dirty Deeds', 'album-level name feeds every track');
  }
});

test('resolveSource enforces the 200-track playlist cap', async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({
    track: { id: `t${i}`, name: `T${i}`, artists: [{ name: 'A' }], album: { name: 'AL', images: [] }, duration_ms: 1000 },
  }));
  const client = fakeClient([{
    match: /api\.spotify\.com\/v1\/playlists\/37i9dQZF1DXcBWIGoYBM5M/,
    body: { name: '超大清單', tracks: { total: 201, next: null, items } },
  }]);
  let message = '';
  try {
    await resolveSource('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', client);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes('200'), 'cap message must state the 200 cap');
  assert(message.includes('拆分播放清單'), 'cap message must suggest splitting the playlist');
});

test('resolveSource maps a small playlist', async () => {
  const body = {
    name: 'Small List',
    tracks: {
      total: 2,
      next: null,
      items: [
        { track: { id: 't1', name: 'One', artists: [{ name: 'A' }], album: { name: 'AL', images: [{ url: 'https://i.scdn.co/1.jpg' }] }, duration_ms: 60000 } },
        { track: null },
        { track: { id: 't2', name: 'Two', artists: [{ name: 'B' }], album: { name: 'AL2', images: [] }, duration_ms: 120000, is_local: true } },
        { track: { id: 't3', name: 'Three', artists: [{ name: 'C' }], album: { name: 'AL3', images: [] }, duration_ms: 180000 } },
      ],
    },
  };
  const client = fakeClient([{ match: /api\.spotify\.com\/v1\/playlists\/small/, body }]);
  const resolved = await resolveSource('https://open.spotify.com/playlist/small', client);
  assertEq(resolved.kind, 'playlist', 'kind');
  assertEq(resolved.name, 'Small List', 'source name');
  assertEq(resolved.tracks.map((t) => t.title), ['One', 'Three'], 'null and is_local entries are skipped');
});

test('resolveSource falls back to oEmbed without a client', async () => {
  await withStubbedFetch({ title: 'Some Playlist', thumbnail_url: 'https://img/x.jpg' }, async () => {
    const resolved = await resolveSource('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', null);
    assertEq(resolved.kind, 'playlist', 'kind preserved');
    assertEq(resolved.name, 'Some Playlist', 'oEmbed title becomes the source name');
    assertEq(resolved.partial, true, 'marked partial');
    assertEq(resolved.tracks, [], 'no tracks without a client');
  });
});

test('resolveSource falls back to oEmbed when the client request rejects', async () => {
  const client = fakeClient([]); // every URL throws
  await withStubbedFetch({ title: 'Loose Track' }, async () => {
    const resolved = await resolveSource('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', client);
    assertEq(resolved.kind, 'track', 'kind preserved');
    assertEq(resolved.name, 'Loose Track', 'oEmbed title becomes the source name');
    assertEq(resolved.partial, true, 'marked partial');
  });
});
