// Bundle entry for the download dependencies (compiled by tools/bundle-download-vendor.mjs
// into src/vendor/download-deps.js). spdl's index.ts does not re-export entity.ts or
// content.ts, so we import the graph directly and compose the download pipeline here —
// which also fixes upstream's fire-and-forget bug: async failures now destroy the
// returned stream instead of becoming unhandled rejections while the stream hangs.
import { PassThrough } from "node:stream";

import { Spotify } from "./spdl-src/src/lib/client.js";
import { AudioType, Endpoints, Formats, premiumFormats } from "./spdl-src/src/lib/const.js";
import {
    createSpotifyEntity,
    EpisodeEntity,
    PlayableEntity,
    TrackEntity,
} from "./spdl-src/src/lib/entity.js";
import {
    SpotifyApiError,
    SpotifyAuthError,
    SpotifyError,
    SpotifyResolveError,
    SpotifyStreamError,
} from "./spdl-src/src/lib/errors.js";
import type { SpdlFormat, SpdlOptions } from "./spdl-src/src/lib/types.js";
import { getIdFromURL, validateURL } from "./spdl-src/src/lib/url.js";

import ytdlCore from "@distube/ytdl-core";
import YTMusic from "@tnfangel/ytmusic-api";

export { Spotify };
export { AudioType, Endpoints, Formats, premiumFormats };
export { getIdFromURL, validateURL };
export { SpotifyApiError, SpotifyAuthError, SpotifyError, SpotifyResolveError, SpotifyStreamError };
export type { SpdlFormat, SpdlOptions };

// The eight format names spdl's SpdlFormat type declares. (Formats also contains
// AAC_24 and the *_DUAL keys, but the typed surface is these eight.)
export const SPDL_FORMATS: SpdlFormat[] = [
    "OGG_VORBIS_96",
    "OGG_VORBIS_160",
    "OGG_VORBIS_320",
    "MP3_96",
    "MP4_128",
    "MP4_128_DUAL",
    "MP4_256",
    "MP4_256_DUAL",
];

const DEFAULT_SPDL_FORMAT: SpdlFormat = "OGG_VORBIS_160";

/**
 * Downloads a playable Spotify URL (track or episode) and returns the raw audio
 * stream. Errors — including every async one (auth, metadata, license, CDN) —
 * are propagated by destroying the stream, so the consumer's error handler sees
 * them instead of the stream hanging forever.
 */
export function downloadTrackStream(
    url: string,
    client: Spotify,
    options: Partial<SpdlOptions> = {}
): PassThrough {
    const stream = new PassThrough({ highWaterMark: 1024 * 512 });

    const run = async (): Promise<void> => {
        if (!validateURL(url)) {
            throw new SpotifyError("An invalid Spotify URL was provided.");
        }
        const content = createSpotifyEntity(url);
        if (!(content instanceof PlayableEntity)) {
            throw new SpotifyError("An unplayable Spotify entity was provided.");
        }

        const effective: SpdlOptions = {
            ...options,
            format: options.format ?? DEFAULT_SPDL_FORMAT,
            encrypt: options.encrypt ?? false,
            preload: options.preload ?? false,
        };

        const feeder = new (await import("./spdl-src/src/lib/content.js")).PlayableContentStreamer(
            client,
            stream,
            effective.preload
        );
        const isPremium = await client.user.isPremium();

        if (content instanceof TrackEntity) {
            const metadata = await client.tracks.getMetadata(content.toHex());
            const formats = [
                ...metadata.files.map((k) => k.format),
                ...metadata.preview.map((k) => k.format),
            ];
            if (!formats.includes(effective.format)) {
                throw new SpotifyStreamError("Format provided is not supported by this content.");
            }
            if (premiumFormats.includes(effective.format) && !isPremium) {
                throw new SpotifyAuthError("Selected format is only available for Spotify premium accounts.");
            }
            await feeder.loadContent(metadata, effective, AudioType.AUDIO_TRACK);
        } else {
            const metadata = await client.podcasts.getMetadata(content.toHex());
            const formats = [
                ...metadata.files.map((k) => k.format),
                ...metadata.preview.map((k) => k.format),
            ];
            if (!formats.includes(effective.format)) {
                throw new SpotifyStreamError("Format provided is not supported by this content.");
            }
            if (premiumFormats.includes(effective.format) && !isPremium) {
                throw new SpotifyAuthError("Selected format is only available for Spotify premium accounts.");
            }
            await feeder.loadContent(metadata, effective, AudioType.AUDIO_EPISODE);
        }
    };

    run().catch((error: unknown) => {
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return stream;
}

// ---------------------------------------------------------------------------
// YouTube Music (Route B)
// ---------------------------------------------------------------------------

export interface YouTubeSongRow {
    videoId: string;
    title: string;
    artistName: string;
    albumName: string | null;
    durationSec: number | null;
    thumbnailUrl: string | null;
}

export async function searchYouTubeMusic(query: string): Promise<YouTubeSongRow[]> {
    const yt = new YTMusic();
    const rows = (await yt.searchSongs(query)) as any[];
    if (!Array.isArray(rows)) return [];
    return rows
        .map((row): YouTubeSongRow => ({
            videoId: String(row?.videoId ?? ""),
            title: String(row?.name ?? ""),
            artistName: String(row?.artist?.name ?? ""),
            albumName: row?.album?.name ? String(row.album.name) : null,
            durationSec: typeof row?.duration === "number" ? row.duration : null,
            thumbnailUrl: Array.isArray(row?.thumbnails) && row.thumbnails.length
                ? String(row.thumbnails[row.thumbnails.length - 1]?.url ?? "")
                : null,
        }))
        .filter((row) => row.videoId.length > 0);
}

export function getYouTubeStream(url: string, options?: { quality?: string }): PassThrough | import("node:stream").Readable {
    return ytdlCore(url, {
        filter: "audioonly",
        quality: options?.quality ?? "highestaudio",
    } as any) as any;
}

export async function getYouTubeInfo(url: string): Promise<{
    videoId: string;
    title: string;
    durationSec: number | null;
    author: string;
    isLive: boolean;
}> {
    const info = await (ytdlCore as any).getInfo(url);
    const details = info?.videoDetails ?? {};
    const lengthSeconds = Number(details.lengthSeconds);
    return {
        videoId: String(details.videoId ?? ""),
        title: String(details.title ?? ""),
        durationSec: Number.isFinite(lengthSeconds) ? lengthSeconds : null,
        author: String(details.author?.name ?? ""),
        isLive: details.isLiveContent === true,
    };
}

/**
 * Best audio-only stream plus the container it will actually land in
 * ("webm" → .webm, "mp4" (m4a/opus-in-mp4) → .m4a). Callers write to a temp
 * name and rename to the container-specific extension afterwards.
 */
export async function getYouTubeAudio(url: string): Promise<{
    stream: import("node:stream").Readable;
    container: ".webm" | ".m4a";
}> {
    const info = await (ytdlCore as any).getInfo(url);
    const format = (ytdlCore as any).chooseFormat(info.formats, {
        filter: "audioonly",
        quality: "highestaudio",
    });
    const stream = (ytdlCore as any).downloadFromInfo(info, { format });
    return { stream, container: format?.container === "mp4" ? ".m4a" : ".webm" };
}
