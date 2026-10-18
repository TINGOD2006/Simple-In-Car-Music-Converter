import proto from "protobufjs";

import { PLAYPLAY_PROTO } from "./playplay-proto.gen.js";

// PATCH (AudioUsbStudio): the upstream file loaded playplay.proto from disk via
// proto.loadSync(resolveProtoPath(...)) at module top level — impossible in a
// bundled SEA executable where only .js assets are materialised. The descriptor
// is now compiled in as a static JSON module (see playplay-proto.gen.ts).
// The unused upstream helper resolveProto() (CWD-relative fs load) was removed.
const playplay = proto.Root.fromJSON(PLAYPLAY_PROTO);

export const PlayPlayLicenseRequest = playplay.lookupType("PlayPlayLicenseRequest");
export const Interactivity = playplay.lookupEnum("Interactivity");
export const ContentType = playplay.lookupEnum("ContentType");
export const PlayPlayLicenseResponse = playplay.lookupType("PlayPlayLicenseResponse");
