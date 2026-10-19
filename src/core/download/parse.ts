/**
 * Which URLs this app accepts, and what it thinks they are.
 *
 * This is an allowlist, not a heuristic. What survives parsing is handed to a
 * child process (`yt-dlp`) or to the Spotify Web API, so the parser is the
 * boundary that decides what is even a candidate; a permissive "looks like
 * YouTube" test would let an arbitrary host reach that boundary.
 *
 * Parsing goes through `new URL()` rather than a regular expression over the
 * whole string. That is what makes `youtu.be` versus `youtube.com` honest:
 * `https://youtu.be/watch?v=x` has the short host but not the short shape, and a
 * single regex has to guess which part it matched.
 */

import type { Platform } from './types.ts';

/** Re-exported so URL parsing stays a single import site for its callers. */
export type { Platform };

export interface ParsedUrl {
  platform: Platform;
  /** A single video, or a whole playlist/album. */
  kind: 'video' | 'playlist';
  /** YouTube video id, or playlist/album list id, or `MPREb_…` album browse id. */
  id: string;
}

/** YouTube video ids are exactly 11 URL-safe characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Playlist and album list ids. `PL…` (playlist), `OLAK5uy_…` (album),
 * `RD…`/`LL…`/`UU…` (radio, liked, uploads) all fit this shape; the shortest
 * legitimate one is far longer than this floor, which exists only to reject
 * `list=` fragments that are obviously not ids.
 */
const LIST_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Album browse ids, as used by `music.youtube.com/browse/<browseId>`. */
const BROWSE_ALBUM_RE = /^MPREb_[A-Za-z0-9_-]+$/;

/** Hosts that serve the shapes we accept. */
const WWW_HOST = 'www.youtube.com';
const MUSIC_HOST = 'music.youtube.com';
const SHORT_HOST = 'youtu.be';

/** Spotify's own host, and the URI form the desktop client copies. */
const SPOTIFY_HOST = 'open.spotify.com';
const SPOTIFY_URI_RE = /^spotify:[a-z]+:[A-Za-z0-9]+$/;

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function video(id: string): ParsedUrl | null {
  return VIDEO_ID_RE.test(id) ? { platform: 'youtube', kind: 'video', id } : null;
}

function playlist(id: string): ParsedUrl | null {
  return LIST_ID_RE.test(id) ? { platform: 'youtube', kind: 'playlist', id } : null;
}

/**
 * Parse an accepted YouTube URL, or return null.
 *
 * Accepted, and nothing else:
 *   `www.youtube.com/watch?v=<11>`, `youtu.be/<11>`,
 *   `music.youtube.com/watch?v=<11>`, `www.youtube.com/shorts/<11>`,
 *   `(www|music).youtube.com/playlist?list=<id>`,
 *   `music.youtube.com/browse/MPREb_…`.
 *
 * A `watch?v=…&list=…` URL is a single video: the user pasted a video that
 * happens to sit in a playlist, and silently downloading the whole playlist is
 * not what that paste asked for.
 */
export function parseYouTubeUrl(url: string): ParsedUrl | null {
  const parsed = tryUrl(url.trim());
  if (!parsed) return null;
  const host = parsed.hostname;
  const path = parsed.pathname;

  if (host === SHORT_HOST) {
    const id = path.replace(/^\/+/, '').split('/')[0] ?? '';
    return video(id);
  }

  if (host !== WWW_HOST && host !== MUSIC_HOST) return null;

  // /watch?v=<11>
  if (path === '/watch' || path === '/watch/') {
    return video(parsed.searchParams.get('v') ?? '');
  }

  // /shorts/<11>
  const shorts = /^\/shorts\/([^/]+)\/?$/.exec(path);
  if (shorts) return video(shorts[1] ?? '');

  // /playlist?list=<id>
  if (path === '/playlist' || path === '/playlist/') {
    return playlist(parsed.searchParams.get('list') ?? '');
  }

  // music.youtube.com/browse/MPREb_… (an album, which yt-dlp reads as a playlist)
  if (host === MUSIC_HOST) {
    const browse = /^\/browse\/([^/]+)\/?$/.exec(path);
    if (browse) {
      const id = browse[1] ?? '';
      return BROWSE_ALBUM_RE.test(id) ? { platform: 'youtube', kind: 'playlist', id } : null;
    }
  }

  return null;
}

/**
 * Which platform a URL belongs to, or null when this app cannot handle it.
 *
 * Deliberately expressed in terms of `parseYouTubeUrl`: a URL is "youtube" only
 * if it is one we would actually accept, so the UI's platform badge can never
 * disagree with the resolver about the same string.
 */
export function detectPlatform(url: string): Platform | null {
  const trimmed = url.trim();
  if (SPOTIFY_URI_RE.test(trimmed)) return 'spotify';

  const parsed = tryUrl(trimmed);
  if (parsed && parsed.hostname === SPOTIFY_HOST) return 'spotify';

  return parseYouTubeUrl(trimmed) === null ? null : 'youtube';
}
