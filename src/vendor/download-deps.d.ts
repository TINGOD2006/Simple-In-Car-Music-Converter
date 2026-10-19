// Hand-written types over the generated bundle src/vendor/download-deps.js.
// The bundle is produced by tools/bundle-download-vendor.mjs from
// tools/vendor/download-entry.ts (vendored spdl @ d01c4044a59332d437b2b322ad7619f60f719240).
// Deviations from upstream spdl are recorded in tools/vendor/spdl-src/PATCHES.md.
// This file is the ONLY type surface src/ sees — never import from node_modules
// in src/.
//
// The YouTube declarations that used to end this file are gone: @distube/ytdl-core
// and @tnfangel/ytmusic-api were removed after both stopped working against
// YouTube's bot gate, and YouTube now goes through the pinned yt-dlp binary.
import type { Readable } from 'node:stream';

// --- spdl error taxonomy (message-prefixed in upstream constructors) ---
export declare class SpotifyError extends Error {
    constructor(message: string);
}
export declare class SpotifyApiError extends Error {
    constructor(statusCode: number, message: string);
}
export declare class SpotifyAuthError extends Error {
    constructor(message: string);
}
export declare class SpotifyResolveError extends Error {
    constructor(entity: unknown, reason: string);
}
export declare class SpotifyStreamError extends Error {
    constructor(reason: string);
}

// --- spdl Spotify client (static create performs the anonymous-token refresh) ---
export declare interface SpotifyUserSub {
    isPremium(): Promise<boolean>;
}

export declare class Spotify {
    static create(options: { cookie?: string; accessToken?: string }): Promise<Spotify>;
    /**
     * GET against a FULL endpoint URL (spdl's Endpoints.* values are full URLs).
     * Sends the Bearer token + WebPlayer headers; resolves the parsed JSON body.
     * Throws SpotifyApiError on non-2xx.
     */
    request<T = unknown>(fullUrl: string): Promise<T>;
    readonly user: SpotifyUserSub;
}

/**
 * Streams a playable Spotify URL (track) as raw audio. The returned stream is
 * the authoritative error channel: every async failure (auth, metadata, license,
 * CDN) destroys the stream with the error instead of hanging.
 */
export declare function downloadTrackStream(
    url: string,
    client: Spotify,
    options?: { format?: string; preload?: boolean; encrypt?: boolean },
): Readable;

export declare const SPDL_FORMATS: readonly string[];
