/**
 * Spotify URL parsing, metadata resolve and filename sanitizing (plan Task 3).
 *
 * Metadata comes from the Web API v1 endpoints through the injected
 * `SpotifyClient` (the vendored parser expects the spclient shape and is not
 * used here). When no client is available, or the client path fails, resolve
 * degrades to Spotify's public oEmbed endpoint (partial metadata: name only)
 * — callers treat `partial` as "show a warning in the UI". A playlist over
 * 200 tracks is a hard error, never a silent slice.
 */

import { DownloadFailure } from './errors.ts';
import { detectPlatform } from './parse.ts';
import { resolveYouTubeSource, type YouTubeResolveDeps } from './sources/youtube.ts';
import type { ResolvedSource, SpotifyApiTrack, SpotifyClient, TrackMeta } from './types.ts';

/** Playlists larger than this are rejected with a split suggestion. */
export const PLAYLIST_CAP = 200;

const WEB_API = 'https://api.spotify.com/v1/';

export class PlaylistTooLargeError extends Error {
  readonly total: number;
  constructor(total: number) {
    super(`播放清單超過 200 首上限（${total} 首）— 請拆分播放清單後重試`);
    this.name = 'PlaylistTooLargeError';
    this.total = total;
  }
}

export type SpotifyUrlKind = 'track' | 'album' | 'playlist';

export function parseSpotifyUrl(url: string): { kind: SpotifyUrlKind; id: string } | null {
  const trimmed = url.trim();
  const https = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i.exec(trimmed);
  if (https) return { kind: https[1]!.toLowerCase() as SpotifyUrlKind, id: https[2]! };
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i.exec(trimmed);
  if (uri) return { kind: uri[1]!.toLowerCase() as SpotifyUrlKind, id: uri[2]! };
  return null;
}

/**
 * Make an arbitrary Spotify title safe as a filename on Windows: control
 * characters are stripped outright, filesystem-hostile punctuation becomes a
 * space (so multi-part names stay readable: AC/DC → AC DC), trailing dots and
 * spaces are removed, the result is capped at `maxLength` code points
 * (never splitting a surrogate pair) and an empty result falls back to
 * "track".
 */
export function sanitizeFilename(name: string, maxLength = 120): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) continue;
    if ('<>:"/\\|?*'.includes(ch)) out += ' ';
    else out += ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  if (out.length > maxLength) out = Array.from(out).slice(0, maxLength).join('');
  out = out.replace(/[. ]+$/g, '');
  return out === '' ? 'track' : out;
}

/** Map a Web API track (plus optional album-level fallback) onto TrackMeta. */
export function trackToMeta(
  t: SpotifyApiTrack,
  fallbackAlbum?: { name: string; images?: { url: string }[] },
): TrackMeta {
  const album = t.album ?? fallbackAlbum;
  return {
    title: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
    album: album?.name ?? '',
    durationSec: t.duration_ms / 1000,
    coverUrl: album?.images?.[0]?.url ?? '',
    sourceId: t.id,
  };
}

interface AlbumResponse {
  name: string;
  images?: { url: string }[];
  tracks?: { items: SpotifyApiTrack[]; next?: string | null; total?: number };
}

interface PlaylistPage {
  name: string;
  tracks?: { items: { track: SpotifyApiTrack | null }[]; next?: string | null; total?: number };
}

interface OEmbedPayload {
  title?: string;
  thumbnail_url?: string;
}

async function oEmbedResolve(url: string, kind: SpotifyUrlKind): Promise<ResolvedSource> {
  const endpoint = 'https://open.spotify.com/oembed?url=' + encodeURIComponent(url);
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`Spotify oEmbed 查詢失敗（HTTP ${res.status}）`);
  const body = (await res.json()) as OEmbedPayload;
  return { platform: 'spotify', kind, name: body.title ?? '', partial: true, tracks: [] };
}

export async function resolveSource(url: string, client: SpotifyClient | null): Promise<ResolvedSource> {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) throw new Error('無法辨識的 Spotify 連結');

  if (client === null) return oEmbedResolve(url, parsed.kind);

  try {
    if (parsed.kind === 'track') {
      const t = await client.request<SpotifyApiTrack>(`${WEB_API}tracks/${parsed.id}`);
      return { platform: 'spotify', kind: 'track', name: t.name, tracks: [trackToMeta(t)] };
    }

    if (parsed.kind === 'album') {
      const a = await client.request<AlbumResponse>(`${WEB_API}albums/${parsed.id}`);
      const tracks = (a.tracks?.items ?? []).map((item) => trackToMeta(item, { name: a.name, images: a.images }));
      return { platform: 'spotify', kind: 'album', name: a.name, tracks };
    }

    // Playlist: cap check on the reported total BEFORE fetching everything,
    // then paginate (≤100/page) while the accumulated list is below the cap.
    const first = await client.request<PlaylistPage>(`${WEB_API}playlists/${parsed.id}`);
    const total = first.tracks?.total;
    if (typeof total === 'number' && total > PLAYLIST_CAP) throw new PlaylistTooLargeError(total);

    const metas: TrackMeta[] = [];
    let page: PlaylistPage | null = first;
    let pages = 0;
    while (page !== null && pages < 4) {
      for (const item of page.tracks?.items ?? []) {
        const t = item.track;
        if (!t || t.is_local) continue; // unavailable and local entries cannot be downloaded
        metas.push(trackToMeta(t));
        if (metas.length >= PLAYLIST_CAP) break;
      }
      if (metas.length >= PLAYLIST_CAP) break;
      const nextUrl: string | null = page.tracks?.next ?? null;
      page = nextUrl ? await client.request<PlaylistPage>(nextUrl) : null;
      pages += 1;
    }
    if (metas.length > PLAYLIST_CAP) metas.length = PLAYLIST_CAP; // defensive slice AFTER the cap check
    return { platform: 'spotify', kind: 'playlist', name: first.name, tracks: metas };
  } catch (err) {
    if (err instanceof PlaylistTooLargeError) throw err; // cap failure must not be masked by the fallback
    return oEmbedResolve(url, parsed.kind); // R1: client/network breakage → public metadata
  }
}

/**
 * Resolve whichever platform the pasted URL belongs to.
 *
 * This is the only entry point the server API calls. `detectPlatform` decides,
 * and an unrecognised host is a typed `unsupported-url` failure rather than a
 * misleading "not a Spotify link" — which is what the caller would otherwise
 * have had to guess from two separate parsers disagreeing.
 *
 * `resolve.ts` and `sources/youtube.ts` import each other: the YouTube source
 * reuses `PLAYLIST_CAP` and `PlaylistTooLargeError` from here. The cycle is
 * safe because neither module touches the other's bindings while evaluating —
 * each only calls into the other from inside a function body.
 */
export async function resolveAnySource(
  url: string,
  client: SpotifyClient | null,
  deps: YouTubeResolveDeps,
): Promise<ResolvedSource> {
  const platform = detectPlatform(url);
  if (platform === 'youtube') return resolveYouTubeSource(url, deps);
  if (platform === 'spotify') return resolveSource(url, client);
  throw new DownloadFailure('unsupported-url', `不支援的連結：${url}`);
}
