/**
 * Route B provider — YouTube Music match (plan Task 4).
 *
 * Given a Spotify TrackMeta, searches YouTube Music for the corresponding
 * upload, scores the candidates (duration gate ±3 s, official "- Topic"
 * channel bonus, title token overlap) and streams the best one into
 * `<destBase>/<artists> - <title>.webm|.m4a`. Network search and stream are
 * injectable so tests run offline; the real ones come from the vendor façade
 * (`deps.ts`). The confidence floor is deliberately conservative: a wrong
 * match wastes the user's USB space, a skipped track is visible and retryable.
 */

import { mkdirSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { getYouTubeAudio, type YouTubeSongRow } from '../deps.ts';
import { sanitizeFilename } from '../resolve.ts';
import type { DownloadOpts, DownloadProvider, TrackMeta } from '../types.ts';

/** Below this score nothing is picked — the queue reports no-confident-match. */
export const CONFIDENCE_FLOOR = 70;
/** Duration agreement required to trust a candidate outright. */
export const DURATION_GATE_SEC = 3;
/** When nothing passes the gate, the closest candidate within this window may still win. */
export const FALLBACK_WINDOW_SEC = 10;
/** Official uploads come from "<Artist> - Topic" channels — worth this bonus. */
export const TOPIC_BONUS = 10;

/**
 * Typed provider failure: `reason` is a stable machine string the queue and
 * UI key on ('no-confident-match' today; 'cookie-expired' comes from Route A).
 */
export class DownloadFailure extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DownloadFailure';
    this.reason = reason;
  }
}

/** lowercase, strip parenthetical qualifiers, collapse spaces. */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[（(][^)）]*[)）]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function tokens(s: string): string[] {
  return normalizeTitle(s).split(' ').filter((t) => t.length > 0);
}

/** Jaccard overlap of the two title token sets (0..1). */
function titleOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export interface ScoredCandidate {
  cand: YouTubeSongRow;
  score: number;
  passedGate: boolean;
}

export function scoreCandidates(cands: YouTubeSongRow[], meta: TrackMeta): ScoredCandidate[] {
  return cands.map((cand) => {
    const durDelta = cand.durationSec === null ? Infinity : Math.abs(cand.durationSec - meta.durationSec);
    let score = 100;
    score -= Math.min(durDelta, 30) * 2; // duration proximity (capped so hopeless candidates still rank among themselves)
    score -= (1 - titleOverlap(cand.title, meta.title)) * 40; // title token mismatch
    if (/-\s*topic$/.test(normalizeTitle(cand.artistName))) score += TOPIC_BONUS;
    return { cand, score, passedGate: durDelta <= DURATION_GATE_SEC };
  });
}

/**
 * Pick the best candidate: every gate-passer competes; when none passes, the
 * closest candidate within FALLBACK_WINDOW_SEC may win; below the confidence
 * floor nothing is picked at all.
 */
export function pickCandidate(cands: YouTubeSongRow[], meta: TrackMeta): YouTubeSongRow | null {
  const scored = scoreCandidates(cands, meta);
  const gated = scored.filter((s) => s.passedGate);
  const pool = gated.length > 0
    ? gated
    : scored.filter((s) => s.cand.durationSec !== null
        && Math.abs(s.cand.durationSec - meta.durationSec) <= FALLBACK_WINDOW_SEC);
  if (pool.length === 0) return null;
  pool.sort((a, b) => b.score - a.score);
  const best = pool[0];
  if (!best || best.score < CONFIDENCE_FLOOR) return null;
  return best.cand;
}

/** Low-level streamer: writes `videoId`'s best audio to `partPath`. */
export type RawAudioDownloader = (
  videoId: string,
  partPath: string,
  opts: DownloadOpts,
) => Promise<{ container: '.webm' | '.m4a' }>;

/** Search function: query string → candidate rows (injectable in tests). */
export type YtmSearcher = (query: string) => Promise<YouTubeSongRow[]>;

function downloadRawAudio(videoId: string, partPath: string, opts: DownloadOpts): Promise<{ container: '.webm' | '.m4a' }> {
  return getYouTubeAudio(`https://www.youtube.com/watch?v=${videoId}`).then(async ({ stream, container }) => {
    await pipeline(stream, createWriteStream(partPath), { signal: opts.signal });
    return { container };
  });
}

export function createYoutubeMatchProvider(overrides?: {
  search?: YtmSearcher;
  download?: RawAudioDownloader;
}): DownloadProvider {
  const search: YtmSearcher = overrides?.search ?? ((query) => import('../deps.ts').then((m) => m.searchYouTubeMusic(query)));
  const downloadVideo: RawAudioDownloader = overrides?.download ?? downloadRawAudio;

  return {
    id: 'youtube-match',
    rawExtension: '.webm',
    // Metadata enrichment happens upstream (the API resolves with a logged-in
    // client first); a bare provider resolve degrades to the public oEmbed.
    async resolve(url) {
      const { resolveSource } = await import('../resolve.ts');
      return resolveSource(url, null);
    },
    async download(track: TrackMeta, destBase: string, opts: DownloadOpts): Promise<{ rawPath: string }> {
      mkdirSync(destBase, { recursive: true });
      const cands = await search(`${track.artists} ${track.title}`);
      const best = pickCandidate(cands, track);
      if (!best) {
        throw new DownloadFailure(
          'no-confident-match',
          `找不到符合置信門檻的 YouTube 對應版本：${track.artists} - ${track.title}`,
        );
      }
      const base = sanitizeFilename(`${track.artists} - ${track.title}`);
      const partPath = join(destBase, `${base}.part`);
      try {
        const { container } = await downloadVideo(best.videoId, partPath, opts);
        const rawPath = join(destBase, `${base}${container}`);
        renameSync(partPath, rawPath);
        return { rawPath };
      } catch (err) {
        rmSync(partPath, { force: true }); // never leave a partial behind
        throw err;
      }
    },
  };
}
