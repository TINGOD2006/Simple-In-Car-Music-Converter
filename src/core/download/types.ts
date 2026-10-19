/**
 * Shared types for the download module (plan Task 3).
 *
 * These describe the contract between the resolve layer, the two download
 * providers, the queue and the server API. The Spotify client is a minimal
 * structural view of the vendor façade (`src/core/download/deps.ts`), whose
 * `request()` takes FULL URLs — this keeps every layer testable with plain
 * doubles and leaves the façade's internals swappable.
 */

export type DownloadRoute = 'spotify-direct' | 'youtube-match' | 'youtube-direct';

/** Which upstream service a resolved source, or a track in it, came from. */
export type Platform = 'spotify' | 'youtube';

export interface TrackMeta {
  title: string;
  /** Artist names joined with ', ' — also the display and filename source. */
  artists: string;
  album: string;
  durationSec: number;
  /** First album image URL, or '' when the source has none. */
  coverUrl: string;
  /**
   * The platform-native identifier: a Spotify track id, or a YouTube video id.
   * This is what a provider hands back to its own service.
   */
  sourceId: string;
}

export type TrackState =
  | 'queued'
  | 'downloading'
  | 'tagging'
  | 'converting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface ResolvedSource {
  /** Which service this came from — decides which routes can serve it. */
  platform: Platform;
  /**
   * `video` is one YouTube video, `track` one Spotify track; `album` and
   * `playlist` are multi-track on both services.
   */
  kind: 'track' | 'album' | 'playlist' | 'video';
  name: string;
  /** true = degraded metadata (oEmbed fallback): name only, no track list. */
  partial?: boolean;
  tracks: TrackMeta[];
}

export interface DownloadOpts {
  destination: string;
  signal: AbortSignal;
  timeoutMs: number;
  onStage?: (s: TrackState) => void;
}

export interface DownloadProvider {
  readonly id: DownloadRoute;
  /**
   * Containers this provider's raw stream may land in, before tag+convert.
   * A list because a YouTube download yields webm or m4a depending on the
   * video; the queue tests each in order when hunting for an existing raw.
   */
  readonly rawExtensions: readonly ('.ogg' | '.webm' | '.m4a')[];
  resolve(url: string): Promise<ResolvedSource>;
  download(track: TrackMeta, destBase: string, opts: DownloadOpts): Promise<{ rawPath: string }>;
}

/** Minimal structural view of the vendor façade's Spotify client. */
export interface SpotifyClient {
  request<T>(fullUrl: string): Promise<T>;
}

/** Web API v1 track shape — only the fields this module consumes. */
export interface SpotifyApiTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  /** Present on /v1/tracks and playlist items; absent on album track items. */
  album?: { name: string; images?: { url: string }[] };
  duration_ms: number;
  track_number?: number;
  disc_number?: number;
  /** Local-file entries cannot be downloaded and are skipped. */
  is_local?: boolean;
}
