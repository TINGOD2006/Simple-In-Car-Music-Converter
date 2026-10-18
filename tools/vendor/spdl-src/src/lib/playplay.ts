// PATCH (AudioUsbStudio): PlayPlay key handling now uses `re-unplayplay` (es3n1n's
// clean rewrite of pbdecrypt.cc with prebuilt binaries), replacing @spdl/unplayplay
// which is an unpublished native addon that cannot be installed or bundled.
// IMPORTANT: every Spotify audio format (OGG_VORBIS and MP4 alike) goes through
// PlayPlay key decryption — MP3_96 is the only unencrypted branch. The import is
// still lazy so bundling never loads native code at module-eval time; the
// re-unplayplay package directory ships beside the packaged exe (like ffmpeg).
import undici from "undici";

import { Spotify } from "./client.js";
import { Endpoints, AudioType } from "./const.js";
import { SpotifyApiError, SpotifyAuthError, SpotifyStreamError } from "./errors.js";
import { PlayPlayLicenseRequest, PlayPlayLicenseResponse } from "./proto.js";

export class PlayPlayClient {
    readonly client: Spotify;

    constructor(client: Spotify) {
        this.client = client;
    }

    public async getKey(fileId: string, licenseType: AudioType) {
        // PATCH (AudioUsbStudio): lazy import of the re-unplayplay native bridge —
        // see the file header.
        const unplayplay = await import("re-unplayplay");

        const licensePayload = PlayPlayLicenseRequest.encode({
            version: 2,
            token: unplayplay.getToken(),
            interactivity: 1,
            contentType: licenseType,
            timestamp: Math.floor(Date.now() / 1000)
        });

        const license = await this.getLicense(licensePayload.finish(), fileId);
        const challenge = PlayPlayLicenseResponse.decode(license).toJSON();
        const obfuscatedKey = Buffer.from(challenge.obfuscatedKey, "base64");
        // PATCH (AudioUsbStudio): removed upstream's stray `console.log` of the key hex.

        if (!obfuscatedKey) {
            throw new SpotifyAuthError("No PlayPlay key was provided by the response.");
        }

        const key = unplayplay.decryptAndBindKey(
            obfuscatedKey,
            fileId
        );

        return key;
    }

    private async getLicense(
        challenge: Uint8Array,
        fileId: string,
    ): Promise<Buffer> {
        const request = await undici.request(
            `${Endpoints.PLAYPLAY}${fileId}`,
            {
                method: "POST",
                body: challenge,
                headers: this.client.getRawHeaders()
            }
        );

        if (request.statusCode == 403) {
            const isPremium = await this.client.user.isPremium();

            if (!isPremium) {
                throw new SpotifyStreamError("Playplay token invalid! Update the re-unplayplay dependency if there is an update available.");
            }
        }

        if (request.statusCode != 200) {
            throw new SpotifyApiError(request.statusCode, await request.body.text());
        }

        const content = await request.body.arrayBuffer();
        return Buffer.from(content);
    }
}