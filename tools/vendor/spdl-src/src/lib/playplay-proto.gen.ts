// GENERATED FILE — do not edit by hand.
// Source: tools/vendor/spdl-src/proto/playplay.proto
// Vendored from PwLDev/node-spdl @ d01c4044a59332d437b2b322ad7619f60f719240.
// Static descriptor replaces the runtime fs loadSync in proto.ts, because bundled
// SEA code cannot rely on __dirname paths and build assets only carry .js files.
export const PLAYPLAY_PROTO = {
  "nested": {
    "PlayPlayLicenseRequest": {
      "oneofs": {
        "_cacheId": {
          "oneof": [
            "cacheId"
          ]
        }
      },
      "fields": {
        "version": {
          "type": "int32",
          "id": 1
        },
        "token": {
          "type": "bytes",
          "id": 2
        },
        "cacheId": {
          "type": "bytes",
          "id": 3,
          "options": {
            "proto3_optional": true
          }
        },
        "interactivity": {
          "type": "Interactivity",
          "id": 4
        },
        "contentType": {
          "type": "ContentType",
          "id": 5
        },
        "timestamp": {
          "type": "int64",
          "id": 6
        }
      }
    },
    "Interactivity": {
      "values": {
        "UNKNOWN_INTERACTIVITY": 0,
        "INTERACTIVE": 1,
        "DOWNLOAD": 2
      }
    },
    "ContentType": {
      "values": {
        "UNKNOWN_CONTENT_TYPE": 0,
        "AUDIO_TRACK": 1,
        "AUDIO_EPISODE": 2,
        "AUDIO_ADD": 3
      }
    },
    "PlayPlayLicenseResponse": {
      "fields": {
        "obfuscatedKey": {
          "type": "bytes",
          "id": 1
        },
        "b4Seq": {
          "type": "bytes",
          "id": 2
        }
      }
    }
  }
} as const;
