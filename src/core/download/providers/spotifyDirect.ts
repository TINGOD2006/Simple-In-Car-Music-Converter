/**
 * The `spotify-direct` route (plan Task 9): real Spotify audio through the
 * user's own `sp_dc` cookie.
 *
 * This is the only route that can produce actual Spotify audio, and the only
 * one that needs an account. It is also the only place the stored secret is
 * read, and it never leaves this module: the cookie goes to spdl and nowhere
 * else — not into a filename, not into a message, not into a response.
 *
 * `downloadTrackStream()` takes a Spotify URL, not a CDN URL — it resolves the
 * metadata, negotiates the license and fetches the CDN bytes internally, and
 * reports every async failure by destroying the returned stream. So the whole
 * download is one `pipeline()` call, and its rejection is the error channel.
 *
 * Auth failures map to the typed `cookie-expired` reason, which the queue turns
 * into a fail-fast for every still-queued track: a dead cookie fails all of
 * them, and hammering Spotify 20 more times with a cookie it already rejected
 * is both pointless and impolite.
 */

import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { readDownloadSettings } from '../../appsettings.ts';
import { createSpotifyClient, downloadTrackStream, SpotifyAuthError } from '../deps.ts';
import { DownloadFailure } from '../errors.ts';
import { sanitizeFilename, resolveSource } from '../resolve.ts';
import type { SpotifyClient, DownloadOpts, DownloadProvider, ResolvedSource, TrackMeta } from '../types.ts';

/** The Premium ladder's top rung; spdl falls back on its own for free accounts. */
const FORMAT = 'OGG_VORBIS_320';

const RAW_EXTENSION = '.ogg';

export interface SpotifyDirectDeps {
  /** Cookie override; the stored setting is used when omitted. */
  cookie?: string | null;
  /** Injected by tests: how a cookie becomes a client. */
  createClient?: (cookie: string) => Promise<SpotifyClient>;
  /** Injected by tests: how a track URL becomes a byte stream. */
  openStream?: (url: string, client: SpotifyClient) => NodeJS.ReadableStream;
}

function cookieExpired(detail: string): DownloadFailure {
  return new DownloadFailure('cookie-expired', `Spotify 登入已失效或尚未設定：${detail}`);
}

export function createSpotifyDirectProvider(deps: SpotifyDirectDeps = {}): DownloadProvider {
  // One client per provider instance: logging in costs a token refresh, and a
  // queue of 200 tracks must not do that 200 times.
  let pending: Promise<SpotifyClient> | null = null;

  function client(): Promise<SpotifyClient> {
    if (pending) return pending;
    pending = (async (): Promise<SpotifyClient> => {
      const cookie = deps.cookie ?? readDownloadSettings().spotifyCookie;
      if (!cookie) throw cookieExpired('尚未在設定中貼上 Spotify cookie');
      const create = deps.createClient ?? ((value: string) => createSpotifyClient(value));
      try {
        return await create(cookie);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw cookieExpired(detail);
      }
    })();
    // A rejected login must not be cached, or a corrected cookie could never
    // take effect without restarting the process.
    pending.catch(() => {
      pending = null;
    });
    return pending;
  }

  return {
    id: 'spotify-direct',
    rawExtensions: [RAW_EXTENSION],

    // The queue only calls this for a client-typed URL string, never to build a
    // preview: the server's own resolve path passes a real client so the user
    // sees full metadata instead of the degraded oEmbed fallback.
    resolve(url: string): Promise<ResolvedSource> {
      return resolveSource(url, null);
    },

    async download(
      track: TrackMeta,
      destDir: string,
      opts: DownloadOpts,
    ): Promise<{ rawPath: string }> {
      const spotify = await client();
      mkdirSync(destDir, { recursive: true });
      const base = sanitizeFilename(`${track.artists} - ${track.title}`);
      // `partPath` keeps the real extension (spdl writes raw OGG bytes), so a
      // crash mid-write cannot leave a file the queue's skip rule would accept.
      const partPath = join(destDir, `${base}${RAW_EXTENSION}.part`);
      const rawPath = join(destDir, `${base}${RAW_EXTENSION}`);
      const url = `https://open.spotify.com/track/${track.sourceId}`;

      try {
        const stream =
          deps.openStream?.(url, spotify) ??
          (downloadTrackStream(url, spotify as never, { format: FORMAT }) as unknown as NodeJS.ReadableStream);
        await pipeline(stream, createWriteStream(partPath), { signal: opts.signal });
        renameSync(partPath, rawPath);
        return { rawPath };
      } catch (err) {
        rmSync(partPath, { force: true });
        if (opts.signal.aborted) throw new DownloadFailure('cancelled', '已取消');
        if (err instanceof SpotifyAuthError) {
          throw cookieExpired(err.message);
        }
        const detail = err instanceof Error ? err.message : String(err);
        // spdl reports a rejected cookie as a plain SpotifyError in several
        // paths; the wording is the only signal available, so it is matched
        // narrowly rather than guessed at broadly.
        if (/cookie|unauthor|authenticat|token/i.test(detail)) throw cookieExpired(detail);
        throw new DownloadFailure('io-error', `Spotify 下載失敗：${detail}`);
      }
    },
  };
}
