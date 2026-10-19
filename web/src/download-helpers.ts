/**
 * Pure helpers behind the 下載 tab.
 *
 * Kept out of the component on purpose: the copy for each track state, the
 * running tally, the default folder and the "does this look like YouTube" hint
 * are all decidable without a browser or an engine, so they are decided here and
 * asserted directly by `test/download-web-api.test.ts`.
 */

import type { TrackState } from './api-types.ts';

/**
 * The one-line label for a track's state.
 *
 * Every member of the union is named, and an unrecognised state still renders
 * something readable — a pill that shows a raw engine token (or nothing) is
 * worse than one that admits it does not know.
 */
const STATE_LABELS: Record<TrackState, string> = {
  queued: '等待中',
  downloading: '下載中',
  tagging: '寫入標籤',
  converting: '轉檔中',
  done: '完成',
  failed: '失敗',
  skipped: '略過',
  cancelled: '已取消',
};

export function statusPill(state: TrackState): string {
  return STATE_LABELS[state] ?? '未知';
}

/** Every state, in the order the progress table reads them. */
const ALL_STATES: readonly TrackState[] = [
  'queued',
  'downloading',
  'tagging',
  'converting',
  'done',
  'failed',
  'skipped',
  'cancelled',
];

/**
 * How many tracks are in each state.
 *
 * Every key is present, so the header can read `.done` without a guard; an
 * unknown state is ignored rather than counted into a `NaN` bucket.
 */
export function countByState(
  tracks: ReadonlyArray<{ state: TrackState }>,
): Record<TrackState, number> {
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<TrackState, number>;
  for (const track of tracks) {
    if (track.state in counts) counts[track.state] += 1;
  }
  return counts;
}

/** A summary line for the progress header: `完成 3／失敗 1` and so on. */
export function describeProgress(tracks: ReadonlyArray<{ state: TrackState }>): string {
  const counts = countByState(tracks);
  const parts = ALL_STATES.filter((s) => counts[s] > 0).map((s) => `${statusPill(s)} ${counts[s]}`);
  return parts.length === 0 ? '沒有曲目' : parts.join('／');
}

/** Characters no Windows path segment may contain, plus the control range. */
const ILLEGAL_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Turn a source name into ONE usable path segment.
 *
 * A playlist called `AC/DC: Live?` must not silently become two directories or
 * an unopenable name, and a name made entirely of separators must still land
 * somewhere addressable.
 */
function segment(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_SEGMENT, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const capped = cleaned.slice(0, 80).trim();
  return capped === '' ? '下載' : capped;
}

/**
 * Where a source's files go by default: a `Downloads` folder inside the folder
 * the user already chose, named after the source.
 *
 * The separator follows the working folder rather than the platform, because
 * this string is handed to the ENGINE, which runs on whatever machine is
 * hosting it — and a path built with the browser's own separator would be wrong
 * for a remote engine of the other family.
 */
export function defaultDestinationFor(workingFolder: string, sourceName: string): string {
  const sep = workingFolder.includes('\\') || !workingFolder.includes('/') ? '\\' : '/';
  const base = workingFolder.replace(/[\\/]+$/, '');
  return `${base}${sep}Downloads${sep}${segment(sourceName)}`;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const ALBUM_BROWSE_ID_RE = /^MPREb_[A-Za-z0-9_-]+$/;
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'music.youtube.com']);

/**
 * A client-side "this is probably a YouTube link" hint.
 *
 * Deliberately mirrors `src/core/download/parse.ts`'s accepted table instead of
 * inventing a looser one: the point is to decide which copy to show BEFORE the
 * round trip, and a hint that accepts more than the engine does would produce a
 * confident message followed by a 400. The engine remains the authority — this
 * only has to be a subset of what it accepts.
 */
export function looksLikeYoutubeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    return VIDEO_ID_RE.test(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
  }
  if (!YOUTUBE_HOSTS.has(host)) return false;

  if (url.pathname === '/watch') {
    // A `watch?v=…&list=…` link is one video, not the playlist: the user pasted
    // a track, and expanding it into 200 tracks would be a surprise.
    return VIDEO_ID_RE.test(url.searchParams.get('v') ?? '');
  }
  if (url.pathname.startsWith('/shorts/')) {
    return VIDEO_ID_RE.test(url.pathname.slice('/shorts/'.length).split('/')[0] ?? '');
  }
  if (url.pathname === '/playlist') {
    return LIST_ID_RE.test(url.searchParams.get('list') ?? '');
  }
  if (host === 'music.youtube.com' && url.pathname.startsWith('/browse/')) {
    return ALBUM_BROWSE_ID_RE.test(url.pathname.slice('/browse/'.length).split('/')[0] ?? '');
  }
  return false;
}
