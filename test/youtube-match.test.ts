/**
 * YouTube-match provider tests (`src/core/download/providers/youtubeMatch.ts`).
 *
 * The scoring table is pure — no network. The provider's download is exercised
 * through injected search/download overrides (the real download path is
 * Task 9's smoke script).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertEq, test } from './harness.ts';
import {
  CONFIDENCE_FLOOR,
  DownloadFailure,
  createYoutubeMatchProvider,
  normalizeTitle,
  pickCandidate,
  scoreCandidates,
} from '../src/core/download/providers/youtubeMatch.ts';
import type { TrackMeta } from '../src/core/download/types.ts';
import type { YouTubeSongRow } from '../src/vendor/download-deps.js';

const META: TrackMeta = {
  title: 'Back In Black',
  artists: 'AC/DC',
  album: 'Back In Black',
  durationSec: 255,
  coverUrl: '',
  spotifyId: '4uLU6hMCjMI75M1A2tKUQC',
};

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

test('provider download picks, names and renames deterministically', async () => {
  const destBase = join(tmpdir(), `aus-ytdl-ok-${Date.now().toString(36)}`);
  mkdirSync(destBase, { recursive: true });
  try {
    const provider = createYoutubeMatchProvider({
      search: async () => [cand({ videoId: 'vid1', artistName: 'AC/DC - Topic' })],
      download: async (_videoId, partPath) => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(partPath, 'raw-bytes');
        return { container: '.webm' };
      },
    });
    const { rawPath } = await provider.download(META, destBase, {
      destination: destBase,
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    assertEq(rawPath, join(destBase, 'AC DC - Back In Black.webm'), 'deterministic <artists> - <title> name');
    assert(existsSync(rawPath), 'renamed file exists');
    assertEq(readFileSync(rawPath, 'utf8'), 'raw-bytes', 'content landed');
    assert(!existsSync(join(destBase, 'AC DC - Back In Black.part')), 'no .part leftover');
  } finally {
    rmSync(destBase, { recursive: true, force: true });
  }
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
