/**
 * The download runtime: one queue per server process, plus the seams a test
 * needs to drive it without yt-dlp, Spotify or the network.
 *
 * The queue is a singleton because a download is a foreground user action, not
 * a durable job (the same reasoning as `jobs.ts`) — a second one would race the
 * first for the same destination and the same rate limits. It is built lazily
 * on first use, because building it resolves `yt-dlp.exe`, and an app whose
 * downloader is missing must still start and say so.
 *
 * `setDownloadOverridesForTests()` exists because two of the three providers
 * shell out to binaries that cannot run in a test harness: yt-dlp.exe is a
 * PyInstaller one-file archive that cannot self-extract under the sandbox, and
 * `spotify-direct` needs a real account. Everything else — routing, the JSON
 * contract, the queue's own lifecycle, the settings file — stays on the
 * shipping path in tests.
 */

import { maskCookie, readDownloadSettings, writeDownloadSettings } from '../core/appsettings.ts';
import { createSpotifyClient } from '../core/download/deps.ts';
import { createSpotifyDirectProvider } from '../core/download/providers/spotifyDirect.ts';
import { createYoutubeDirectProvider } from '../core/download/providers/youtubeDirect.ts';
import { createYoutubeMatchProvider } from '../core/download/providers/youtubeMatch.ts';
import { createDownloadQueue, type DownloadQueue } from '../core/download/queue.ts';
import { detectPlatform } from '../core/download/parse.ts';
import { PlaylistTooLargeError, resolveAnySource, resolveSource } from '../core/download/resolve.ts';
import { DownloadFailure } from '../core/download/errors.ts';
import type { SpotifyClient, DownloadProvider, DownloadRoute, ResolvedSource } from '../core/download/types.ts';
import type { ExportPreset } from '../core/types.ts';
import { findYtDlp } from '../core/ytdlp.ts';

/** The three routes, in the order the UI offers them. */
export const DOWNLOAD_ROUTES: readonly DownloadRoute[] = [
  'spotify-direct',
  'youtube-direct',
  'youtube-match',
];

export interface DownloadRuntimeDeps {
  ffmpeg: string;
  ffprobe: string;
  scratch: string;
  /** Overrides the settings file location; tests point this at a temp dir. */
  settingsDirs?: string[];
}

export interface DownloadOverrides {
  resolve?: (url: string) => Promise<ResolvedSource>;
  providers?: Partial<Record<DownloadRoute, DownloadProvider>>;
}

let overrides: DownloadOverrides = {};
let queue: DownloadQueue | null = null;
let queueKey = '';
/** `source+destination` of every download this process still has running. */
const activeKeys = new Map<string, string>();

export function setDownloadOverridesForTests(next: DownloadOverrides | null): void {
  overrides = next ?? {};
  queue = null;
  queueKey = '';
  activeKeys.clear();
}

/**
 * `findYtDlp()` throws when the binary is absent. That is not fatal here: the
 * providers catch it per track and report `ytdlp-missing`, so the UI can tell
 * the user to run `node tools/fetch-ytdlp.mjs` instead of the whole endpoint
 * failing with a 500.
 */
function ytDlpPath(): string {
  try {
    return findYtDlp();
  } catch {
    return '';
  }
}

function buildProviders(scratch: string): Record<DownloadRoute, DownloadProvider> {
  const bin = ytDlpPath();
  const providers: Record<DownloadRoute, DownloadProvider> = {
    'spotify-direct': createSpotifyDirectProvider(),
    'youtube-direct': createYoutubeDirectProvider({ bin, scratch }),
    'youtube-match': createYoutubeMatchProvider({ bin, scratch }),
  };
  for (const route of DOWNLOAD_ROUTES) {
    const injected = overrides.providers?.[route];
    if (injected) providers[route] = injected;
  }
  return providers;
}

/** The process-wide queue, rebuilt only when the identity of its deps changes. */
export function downloadQueue(deps: DownloadRuntimeDeps): DownloadQueue {
  const key = `${deps.ffmpeg}|${deps.ffprobe}|${deps.scratch}|${Object.keys(overrides.providers ?? {}).join(',')}`;
  if (queue && queueKey === key) return queue;
  queue = createDownloadQueue({
    providers: buildProviders(deps.scratch),
    ffmpeg: deps.ffmpeg,
    ffprobe: deps.ffprobe,
    scratch: deps.scratch,
  });
  queueKey = key;
  return queue;
}

/**
 * Resolve a pasted URL through whichever platform owns it.
 *
 * A Spotify client is only built when the cookie is actually stored, and a
 * failed login degrades to the public oEmbed metadata (name only, `partial`)
 * rather than failing the whole resolve — the user still sees what they pasted,
 * which is far more useful than "something went wrong".
 */
export async function resolveForApi(
  url: string,
  deps: { scratch: string; settingsDirs?: string[] },
): Promise<ResolvedSource> {
  if (overrides.resolve) return overrides.resolve(url);

  const platform = detectPlatform(url);
  let client: SpotifyClient | null = null;
  if (platform === 'spotify') {
    const cookie = readDownloadSettings(deps.settingsDirs).spotifyCookie;
    if (cookie) {
      try {
        client = await createSpotifyClient(cookie);
      } catch {
        client = null;
      }
    }
  }
  return resolveAnySource(url, client, { bin: ytDlpPath(), scratch: deps.scratch });
}

/** Four-oh-four versus upstream: what the API should answer for a resolve failure. */
export function resolveFailureStatus(err: unknown): number {
  if (err instanceof DownloadFailure && err.reason === 'unsupported-url') return 400;
  // An empty source is not an outage: yt-dlp exited cleanly and the link simply
  // holds nothing downloadable, so the fix is a different link.
  if (err instanceof DownloadFailure && err.reason === 'no-tracks') return 400;
  if (err instanceof PlaylistTooLargeError) return 400;
  if (err instanceof DownloadFailure && err.reason === 'playlist-too-large') return 400;
  return 502;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Start a download, or hand back the one already running for the same source
 * and destination.
 *
 * Double-clicking 開始下載 is the obvious user move, and two queues writing the
 * same filenames into the same folder is the one outcome nobody can reason
 * about afterwards. Only an UNFINISHED record counts as a duplicate: once it is
 * done, starting again is a legitimate "download it again".
 */
export function startFromApi(
  deps: DownloadRuntimeDeps,
  source: ResolvedSource,
  route: DownloadRoute,
  destination: string,
  preset: ExportPreset,
  trackIndices?: number[],
): string {
  // The platform owns the route for YouTube: `spotify-direct` cannot play a
  // video id, and silently trying would produce a confusing per-track failure.
  const effective: DownloadRoute = source.platform === 'youtube' ? 'youtube-direct' : route;

  // The key has to describe the WORK, not just the source. Two requests for the
  // same playlist that differ in track selection, route or preset are different
  // jobs: keying on name+destination alone made a re-selection return the
  // still-running old job, so the UI showed the user's freshly chosen tracks as
  // 已取消 while someone else's selection downloaded. A double-click sends an
  // identical body, so it still collapses to one job. `\u0000` cannot occur in
  // any of these values, so no two different jobs can share a key.
  const key = [
    source.platform,
    source.kind,
    source.name,
    destination,
    effective,
    // `ExportPreset` carries no id — it is a value type — so its own values are
    // the identity. JSON key order is the literal's order, stable per call site.
    JSON.stringify(preset),
    [...(trackIndices ?? [])].sort((a, b) => a - b).join(','),
  ].join('\u0000');
  const q = downloadQueue(deps);

  const existingId = activeKeys.get(key);
  if (existingId) {
    const existing = q.get(existingId);
    if (existing && !existing.finished) return existingId;
    activeKeys.delete(key);
  }

  const id = q.start(source, effective, destination, preset, trackIndices);
  activeKeys.set(key, id);
  return id;
}

export { readDownloadSettings, writeDownloadSettings, maskCookie, resolveSource };
