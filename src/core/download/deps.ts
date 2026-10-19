// The ONLY module in src/ allowed to import third-party code. The third-party
// graph (vendored spdl) is bundled into src/vendor/download-deps.js by
// tools/bundle-download-vendor.mjs and typed by the hand-written
// src/vendor/download-deps.d.ts. tools/build-exe.mjs copies the bundle into
// build/vendor/ so the packaged exe keeps the relative import.
// Everything below is the façade the download feature compiles against.
//
// YouTube used to live here too (@distube/ytdl-core + @tnfangel/ytmusic-api).
// Both broke against YouTube's current bot gate, so every YouTube route now
// shells out to the pinned yt-dlp binary instead — see src/core/ytdlp.ts and
// src/core/download/sources/youtube.ts.
import {
    Spotify,
    SPDL_FORMATS,
    downloadTrackStream,
    SpotifyApiError,
    SpotifyAuthError,
    SpotifyError,
    SpotifyResolveError,
    SpotifyStreamError,
} from '../../vendor/download-deps.js';

export { SPDL_FORMATS };
export { SpotifyApiError, SpotifyAuthError, SpotifyError, SpotifyResolveError, SpotifyStreamError };
export { Spotify };
export { downloadTrackStream };

/** Logs a Spotify client in with the stored sp_dc cookie (spdl refreshes tokens on create). */
export function createSpotifyClient(cookie: string): Promise<Spotify> {
    return Spotify.create({ cookie });
}
