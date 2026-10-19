/**
 * Route B provider — match a Spotify track against YouTube (plan Task 7).
 *
 * Given a `TrackMeta` (metadata from Spotify), searches YouTube for the
 * corresponding upload, scores the candidates (duration gate ±3 s, official
 * "- Topic" channel bonus, title token overlap) and hands the winner to the
 * `youtube-direct` route to fetch. The scoring is deliberately conservative: a
 * wrong match wastes the user's USB space, a skipped track is visible and
 * retryable.
 *
 * The fetch is NOT re-implemented here. Both YouTube routes shell out to the
 * same yt-dlp, so routing the matched video through `createYoutubeDirectProvider`
 * is what keeps them from drifting into two subtly different commands. Only the
 * *choice* of video is Route B's own business.
 */

import { tmpdir } from 'node:os';

import { findYtDlp } from '../../ytdlp.ts';
import { DownloadFailure } from '../errors.ts';
import {
  searchYouTubeRows,
  ytDlpFailureMessage,
  type YouTubeResolveDeps,
  type YouTubeSongRow,
  type YtDlpRunner,
} from '../sources/youtube.ts';
import type { DownloadOpts, DownloadProvider, TrackMeta } from '../types.ts';
import { createYoutubeDirectProvider } from './youtubeDirect.ts';

/** Below this score nothing is picked — the queue reports no-confident-match. */
export const CONFIDENCE_FLOOR = 70;
/** Duration agreement required to trust a candidate outright. */
export const DURATION_GATE_SEC = 3;
/** When nothing passes the gate, the closest candidate within this window may still win. */
export const FALLBACK_WINDOW_SEC = 10;
/** Official uploads come from "<Artist> - Topic" channels — worth this bonus. */
export const TOPIC_BONUS = 10;

/** lowercase, strip parenthetical qualifiers, collapse spaces. */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[（(][^)）]*[)）]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function tokens(s: string): string[] {
  return normalizeTitle(s).split(' ').filter((t) => t.length > 0);
}

/** `(...)`, `[...]` — qualifiers a metadata title never carries. */
const DECORATION_RE = /[（(][^)）]*[)）]|\[[^\]]*\]/g;
/** `ft. X`, `feat X`, `featuring X`, `with X` — the rest of the title is a guest. */
const FEATURING_RE = /\b(?:ft|feat|featuring|with)\.?\s+.*$/i;

/**
 * Strip the decorations a YouTube title adds to a track title.
 *
 * This is not cosmetic: scoring the raw string punished exactly the uploads most
 * likely to be correct. Measured against the live search (R8), the official
 * "Luis Fonsi - Despacito ft. Daddy Yankee" — right video, right duration —
 * scored **64** against a floor of 70 and was rejected outright, because the
 * channel prefix and the `ft.` credit were counted as title mismatch. The
 * channel is not part of the title, and a credited guest is not evidence
 * against it.
 *
 * The stripping is deliberately narrow. A bare extra word such as "Live" is NOT
 * removed, so a different performance still scores below the exact title.
 */
function stripDecorations(title: string, artists: string): string {
  let s = title.replace(DECORATION_RE, ' ');
  const artist = normalizeTitle(artists);
  if (artist !== '' && s.toLowerCase().startsWith(artist)) {
    const rest = s.slice(artist.length);
    const sep = /^\s*[-–—:]\s*/.exec(rest);
    if (sep) s = rest.slice(sep[0].length);
  }
  return s.replace(FEATURING_RE, ' ');
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
    score -= (1 - titleOverlap(stripDecorations(cand.title, meta.artists), meta.title)) * 40; // title token mismatch
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

/** Search function: query string → candidate rows (injectable in tests). */
export type YtmSearcher = (query: string) => Promise<YouTubeSongRow[]>;

/**
 * Fetch the chosen video into `destDir`, returning the file that landed.
 *
 * Separate from `YtDlpRunner` so a test can assert Route B's *selection* without
 * restating yt-dlp's argument list, which belongs to the direct route's tests.
 */
export type MatchedDownloader = (
  videoId: string,
  destDir: string,
  opts: DownloadOpts,
) => Promise<{ rawPath: string }>;

export interface YoutubeMatchOverrides {
  search?: YtmSearcher;
  download?: MatchedDownloader;
  /** Low-level runner, forwarded to the yt-dlp calls (tests only). */
  run?: YtDlpRunner;
  /** Path to `yt-dlp.exe`; resolved late via `findYtDlp()` when absent. */
  bin?: string;
  /** Directory the children run in; defaults to the system temp dir. */
  scratch?: string;
}

export function createYoutubeMatchProvider(overrides?: YoutubeMatchOverrides): DownloadProvider {
  const scratch = overrides?.scratch ?? tmpdir();

  function ytdlpDeps(): YouTubeResolveDeps {
    const run = overrides?.run;
    let bin = overrides?.bin ?? '';
    if (bin === '') {
      try {
        bin = findYtDlp();
      } catch {
        const reason = 'ytdlp-missing';
        throw new DownloadFailure(reason, ytDlpFailureMessage(reason, ''));
      }
    }
    return run ? { bin, scratch, run } : { bin, scratch };
  }

  const search: YtmSearcher = overrides?.search ?? ((query) => searchYouTubeRows(query, ytdlpDeps()));

  let direct: DownloadProvider | null = null;
  function directProvider(): DownloadProvider {
    if (!direct) {
      // An empty `bin` is not a bug: the direct provider resolves it late via
      // `findYtDlp()` and reports `ytdlp-missing` when there is nothing to find.
      const run = overrides?.run;
      direct = createYoutubeDirectProvider({
        bin: overrides?.bin ?? '',
        scratch,
        ...(run ? { run } : {}),
      });
    }
    return direct;
  }

  return {
    id: 'youtube-match',
    rawExtensions: ['.webm', '.m4a'],
    // Metadata enrichment happens upstream (the API resolves with a logged-in
    // client first); a bare provider resolve degrades to the public oEmbed.
    async resolve(url) {
      const { resolveSource } = await import('../resolve.ts');
      return resolveSource(url, null);
    },
    async download(track: TrackMeta, destDir: string, opts: DownloadOpts): Promise<{ rawPath: string }> {
      const cands = await search(`${track.artists} ${track.title}`);
      const best = pickCandidate(cands, track);
      if (!best) {
        throw new DownloadFailure(
          'no-confident-match',
          `找不到符合置信門檻的 YouTube 對應版本：${track.artists} - ${track.title}`,
        );
      }
      const fetch = overrides?.download
        ?? ((videoId: string, dir: string, o: DownloadOpts) =>
          directProvider().download({ ...track, sourceId: videoId }, dir, o));
      return fetch(best.videoId, destDir, opts);
    },
  };
}
