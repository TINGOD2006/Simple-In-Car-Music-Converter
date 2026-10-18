// The ONLY module in src/ allowed to import third-party code. The whole
// third-party graph (vendored spdl + ytdl-core + ytmusic-api) is bundled into
// src/vendor/download-deps.js by tools/bundle-download-vendor.mjs and typed by
// the hand-written src/vendor/download-deps.d.ts. tools/build-exe.mjs copies the
// bundle into build/vendor/ so the packaged exe keeps the relative import.
// Everything below is the façade the download feature compiles against.
import {
    Spotify,
    SPDL_FORMATS,
    downloadTrackStream,
    getYouTubeAudio,
    getYouTubeInfo,
    getYouTubeStream,
    searchYouTubeMusic,
    SpotifyApiError,
    SpotifyAuthError,
    SpotifyError,
    SpotifyResolveError,
    SpotifyStreamError,
    type YouTubeSongRow,
} from '../../vendor/download-deps.js';

export { SPDL_FORMATS };
export { searchYouTubeMusic };
export { getYouTubeStream };
export { getYouTubeAudio };
export { getYouTubeInfo };
export { SpotifyApiError, SpotifyAuthError, SpotifyError, SpotifyResolveError, SpotifyStreamError };
export { Spotify };
export { downloadTrackStream };
export type { YouTubeSongRow };

/** Logs a Spotify client in with the stored sp_dc cookie (spdl refreshes tokens on create). */
export function createSpotifyClient(cookie: string): Promise<Spotify> {
    return Spotify.create({ cookie });
}
