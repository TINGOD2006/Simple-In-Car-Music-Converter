# Maintaining the download route

Everything in the download feature rests on one external binary and one set of
pinned numbers. When YouTube changes something, this is the file that says what
to do.

## What ships, and what does not

| Piece | Where it lives | Tracked in git? |
|---|---|---|
| `yt-dlp.exe` | `tools/bin/yt-dlp.exe`, copied to `bin/` beside the engine exe | **No** — see `tools/bin/.gitignore` |
| its pin (version, size, sha256) | `tools/fetch-ytdlp.mjs`, top of file | Yes |
| ffmpeg / ffprobe | supplied by the machine, or copied at build time | No |
| `re-unplayplay` (PlayPlay bridge) | `node_modules`, shipped beside the exe | No |

The binary is fetched per machine, never committed: it is 17.8 MB, it is
platform-specific, and a committed copy would be stale the moment YouTube moves.
`tools/fetch-ytdlp.mjs` downloads it, verifies it against `EXPECTED_SIZE` and
`EXPECTED_SHA256`, and only then renames it into place — a crash mid-download
leaves a `.part` file, never a half-written binary that looks valid.

```powershell
node tools/fetch-ytdlp.mjs          # writes tools/bin/yt-dlp.exe
tools\bin\yt-dlp.exe --version      # prints the pinned version
```

There is **no** Python requirement anywhere in this path. The `.exe` is
PyInstaller's one-file build, so it embeds its own interpreter.

## Why not a library

This project used to bundle `@distube/ytdl-core` and `@tnfangel/ytmusic-api` as
npm dependencies. Both stopped working: `ytmusic-api` returned HTTP 400 for every
call, and `ytdl-core` threw `Failed to find any playable formats` because
YouTube's player response now hands back audio formats with neither `url` nor
`cipher` — the stream is gated behind a PO token that a plain HTTP client cannot
mint. Neither library has a fix that does not amount to reimplementing yt-dlp.

Measured on the same ten music videos, on the same machine, on the same network:

| Extractor | Result |
|---|---|
| a hand-written InnerTube client (`ANDROID_VR` player) | **1 / 10** — nine videos answered `LOGIN_REQUIRED`, "Sign in to confirm you're not a bot" |
| `yt-dlp.exe` | **10 / 10** |

The bot gate is deterministic per video, not transient and not IP-wide, and no
alternative client family (ANDROID, IOS, MWEB, TVHTML5, WEB_EMBEDDED_PLAYER)
escaped it. So the extraction layer is a process, not a library, and the version
pin below is the thing that keeps it honest.

## Bumping the pin

Do all three steps. Skipping the third is how a release ships a downloader
nobody has run.

**1. Change the pin.** In `tools/fetch-ytdlp.mjs`:

```js
export const VERSION = '2026.08.19';            // the release tag
export const EXPECTED_SIZE = 17840399;          // bytes
export const EXPECTED_SHA256 = '666749…';       // lowercase hex
```

Take the size and the hash from the release page, not from a local download: a
local file proves what you downloaded, not what the tag publishes. Set
`EXPECTED_SHA256` to `''` only to discover a hash, and put it back before you
commit.

**2. Re-fetch and re-verify.**

```powershell
node tools/fetch-ytdlp.mjs     # exit 4 = size mismatch, exit 5 = sha256 mismatch
node test/run.ts
```

`test/download-packaging.test.ts` reads these pins, so a build whose binary does
not match fails the suite rather than a user's download.

**3. Run the smoke test on a machine that can execute the binary.**

```powershell
node tools/smoke-download.mjs --route youtube-direct --url "https://music.youtube.com/playlist?list=..."
node tools/smoke-download.mjs --route youtube-match     --url "https://open.spotify.com/track/..."
node tools/smoke-download.mjs --route spotify-direct    --url "https://open.spotify.com/track/..."   # needs a stored sp_dc cookie
```

This is **manual only** and must never run in CI: it needs a real network, a
real YouTube, and a real `yt-dlp.exe`. It resolves the URL, starts a download
into a temp folder, waits for the queue to finish, prints one line per track, and
`ffprobe`s every file it produced. It exits non-zero on any failure.

The smoke run is the only step that proves the shipped artefact works. Every
automated test injects a fake runner, because PyInstaller's one-file
self-extraction is blocked in this project's sandbox — `yt-dlp.exe` cannot start
there at all. Report the smoke result honestly, including a failure.

## When YouTube breaks again

The symptom is per-track and specific, never a crash:

| Reason | Meaning |
|---|---|
| `ytdlp-missing` | `yt-dlp.exe` was not found — run `node tools/fetch-ytdlp.mjs` |
| `video-unavailable` | yt-dlp reported the video is gone, private, or region-locked |
| `live-unsupported` | a live stream, which has no finite audio track |
| `no-audio-format` | yt-dlp found the video but no audio-only format |
| `rate-limit` | YouTube asked us to slow down; the queue pauses 30 s and retries the track once |
| `io-error` | anything else, including a killed child |

If many tracks suddenly report `video-unavailable` at once, the pinned yt-dlp is
behind YouTube: bump the pin (above). If `--route spotify-direct` reports
`cookie-expired`, the `sp_dc` cookie in 設定 has expired; re-paste it.

## Related

- `tools/smoke-download.mjs` — the manual end-to-end check
- `tools/fetch-ytdlp.mjs` — fetch + verify + install the binary
- `tools/build-exe.mjs` — copies the binary into `bin/` when building with tools
- `tools/build-desktop-release.mjs` — refuses to ship a release without it
- `docs/superpowers/specs/2026-10-19-youtube-source-design.md` — the design and
  the measurements quoted above
