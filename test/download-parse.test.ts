/**
 * Task 3 — which URLs this app will accept, and what it thinks they are.
 *
 * The accepted set is deliberately an allowlist, not "anything that looks like
 * YouTube": a URL that reaches the resolver becomes a child process invocation,
 * so the parser is the boundary that decides what is even a candidate.
 */

import { assert, assertEq, test } from './harness.ts';

import { detectPlatform, parseYouTubeUrl } from '../src/core/download/parse.ts';

/** Every accepted shape, with the exact result it must produce. */
const ACCEPTED: Array<[url: string, kind: 'video' | 'playlist', id: string]> = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
  [
    'https://www.youtube.com/playlist?list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA',
    'playlist',
    'PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA',
  ],
  [
    'https://music.youtube.com/playlist?list=OLAK5uy_nvZ8-4QLd50AUrhuA-KWpSE965WLRlkqw',
    'playlist',
    'OLAK5uy_nvZ8-4QLd50AUrhuA-KWpSE965WLRlkqw',
  ],
  [
    'https://music.youtube.com/browse/MPREb_kRWtRm3lN0RhFZ8NsAtKOBFOPqMkJyWmw',
    'playlist',
    'MPREb_kRWtRm3lN0RhFZ8NsAtKOBFOPqMkJyWmw',
  ],
];

/** Every shape that must be refused, so the resolver never sees it. */
const REJECTED = [
  'dQw4w9WgXcQ',
  'https://www.youtube.com/@RickAstleyYT',
  'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
  'https://www.youtube.com/results?search_query=despacito',
  'https://www.youtube.com/feed/subscriptions',
  'https://example.com/watch?v=dQw4w9WgXcQ',
  '',
];

test('parseYouTubeUrl maps every accepted URL shape to its exact identity', () => {
  for (const [url, kind, id] of ACCEPTED) {
    const parsed = parseYouTubeUrl(url);
    assert(parsed !== null, `${url} must be accepted`);
    assertEq(parsed.platform, 'youtube', `${url}: platform`);
    assertEq(parsed.kind, kind, `${url}: kind`);
    assertEq(parsed.id, id, `${url}: id`);
  }
});

test('parseYouTubeUrl refuses anything outside the allowlist', () => {
  for (const url of REJECTED) {
    assertEq(parseYouTubeUrl(url), null, `${url} must be refused`);
  }
});

test('a watch URL carrying both v and list resolves to the single video', () => {
  const parsed = parseYouTubeUrl(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA',
  );
  assert(parsed !== null, 'the combined URL must be accepted');
  assertEq(parsed.kind, 'video', 'the v parameter wins over list');
  assertEq(parsed.id, 'dQw4w9WgXcQ', 'the video id, not the list id');
});

test('a video id must be exactly 11 characters', () => {
  assertEq(parseYouTubeUrl('https://www.youtube.com/watch?v=tooShort'), null, 'too short');
  assertEq(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQx'), null, 'too long');
});

test('detectPlatform sorts the two platforms and refuses everything else', () => {
  assertEq(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube', 'watch');
  assertEq(detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube', 'short link');
  assertEq(
    detectPlatform('https://www.youtube.com/playlist?list=PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA'),
    'youtube',
    'playlist',
  );
  assertEq(
    detectPlatform('https://music.youtube.com/browse/MPREb_kRWtRm3lN0RhFZ8NsAtKOBFOPqMkJyWmw'),
    'youtube',
    'album browse',
  );
  assertEq(
    detectPlatform('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
    'spotify',
    'spotify web url',
  );
  assertEq(detectPlatform('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), 'spotify', 'spotify uri');
  assertEq(detectPlatform('https://example.com'), null, 'unknown host');
  assertEq(detectPlatform(''), null, 'empty string');
  assertEq(detectPlatform('https://www.youtube.com/@RickAstleyYT'), null, 'channel handle');
});

test('a spotify uri is not a YouTube URL', () => {
  assertEq(parseYouTubeUrl('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), null, 'uri must be refused');
  assertEq(
    parseYouTubeUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
    null,
    'web url must be refused',
  );
});
