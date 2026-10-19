# YouTube as a Download Source, via yt-dlp — Design Spec

Date: 2026-10-19
Status: Design approved in chat (yt-dlp.exe as a shipped binary; Route B replaced too)
Next artifact: implementation plan (writing-plans), only after spec approval

**Amends** `docs/superpowers/specs/2026-10-18-cross-platform-download-design.md`:
its non-goal *"Other platforms (YT Music direct, …)"* is superseded **for YouTube
only**, and the shared interfaces it froze (`DownloadRoute`, `TrackMeta`,
`DownloadProvider`) change shape. Everything else in that spec still stands —
including the settings file, the queue's concurrency/timeout/cancel/retry rules,
the tagging behaviour and the 200-track playlist cap.

This supersedes the *previous* version of this same document
(`src/core/youtube/` + a hand-written InnerTube client). That approach was
measured, found to work on 1 video in 10, and abandoned. The measurement is
recorded below rather than deleted, so that nobody re-derives it.

## Why this exists

The user asked to implement YouTube as a source — paste a YouTube / YouTube Music
URL, single track or playlist / album — which the original spec listed as an
explicit v0.3 non-goal. While scoping it, live probing on the target machine
showed the already-committed YouTube stack does not work at all. That turned
"add a provider" into "replace the extraction layer", and the replacement is what
makes both the new `youtube-direct` route *and* the existing `youtube-match`
route (Route B) functional again.

## Evidence (live probes, target machine, 2026-10-19)

### The committed stack is broken

| Probe | Result |
|---|---|
| `fetch('https://www.youtube.com/watch?v=…')` | **200 `text/html`** — network, DNS and TLS are fine |
| `@tnfangel/ytmusic-api@5.3.0` `searchSongs()` | **HTTP 400** |
| `@tnfangel/ytmusic-api@5.3.0` after `initialize({GL:'TW',HL:'zh-TW'})` | `initialize()` resolves, then **every** call (search, `getSong`, `getPlaylistVideos`) 400s |
| `@distube/ytdl-core@4.16.12` `getInfo()` | throws `Failed to find any playable formats` (`lib/info.js:298`) |
| Raw InnerTube `WEB_REMIX` `/search` | **200**, real results (`musicResponsiveListItemRenderer`) — so the packages' 400 is theirs, not YouTube's |
| Raw InnerTube `WEB` `/player` | 200, `playabilityStatus: UNPLAYABLE`, `adaptiveFormats: 0` — **this is the cause of `ytdl-core`'s error** |

### A hand-written InnerTube client was tried, and does not work

The previous version of this spec proposed our own client riding on the
`ANDROID_VR` family, because on a single probe that family returned direct,
cipher-free audio URLs:

| Probe | Result |
|---|---|
| `ANDROID_VR 1.60.19` `/player` on `dQw4w9WgXcQ` | `OK`, `streamingData`, 4 audio formats, every `url` direct (`cipher: 0`, no `pot`) |
| Range `GET` on that URL | **206**, `audio/webm`, `content-range bytes 0-65535/3433755`, EBML magic `1a45dfa3` |

**That single video was not representative.** Repeating it across **10 videos ×
3 passes each**:

| Outcome | Videos |
|---|---|
| `OK` (4 audio formats, direct URLs) — **every pass** | `dQw4w9WgXcQ` — **1 of 10** |
| `LOGIN_REQUIRED`, *"Sign in to confirm you're not a bot"*, 0 formats — **every pass** | the other **9 of 10** |

The gate is **deterministic and per-video**, not transient, not rate-limiting,
and not a matter of retrying. Every cheap bypass was tried and failed:

- `visitorData` harvested from a working `WEB_REMIX` search, passed in the request
  body **and** in an `x-goog-visitor-id` header → still `LOGIN_REQUIRED`.
- Alternate client families on a gated video: `WEB` (UNPLAYABLE), `WEB_REMIX`
  (UNPLAYABLE), `MWEB` (`The page needs to be reloaded.`),
  `WEB_EMBEDDED_PLAYER` (`This video is unavailable`),
  `TVHTML5_SIMPLY_EMBEDDED_PLAYER` (`YouTube is no longer supported in this
  application or device`), `ANDROID` / `IOS` (`400 Precondition check failed`).
- The **watch page** for a gated video: `ytInitialPlayerResponse` present,
  `playabilityStatus: OK`, `videoDetails` complete, 4 audio formats — and every
  one carries **`url: null` and `cipher: null`**. The formats are PO-token gated;
  there is nothing to decrypt.

Conclusion: on this machine, for ordinary music videos, **the web/InnerTube path
yields no playable audio format at all**, with or without a hand-written client.
Implementing a PO-token / `BgUtils` JS-VM flow was rejected as disproportionate
and permanently fragile.

### yt-dlp succeeds on the same videos

| Probe | Result |
|---|---|
| `yt-dlp` **2026.08.19**, `--simulate -f bestaudio/best`, the **same 10 videos** | **10 / 10 succeeded**, every one resolving to `itag 251` (Opus/webm), `abr` 111–132 |
| Full download of `kJQP7kiw5Fk` | `kJQP7kiw5Fk.webm`, **4,605,080 bytes** |
| `ffprobe` on that file | `codec_name=opus`, `sample_rate=48000`, `channels=2`, `format_name=matroska,webm`, `duration=281.521000`, `bit_rate=130862` — genuine, decodable audio matching the reported `abr` |
| `yt-dlp --flat-playlist -J` on `PL9tY0BWXOZFtc4Kan4Q0HApZcdRuXN0YA` | **187 rows** |
| …on a second channel playlist | 3 rows |
| …on `https://music.youtube.com/playlist?list=OLAK5uy_…` (album) | 11 / 15 / 1 rows across three albums |
| `yt-dlp -J` on `https://music.youtube.com/watch?v=kJQP7kiw5Fk` | `extractor: youtube`; `title`, `duration: 282`, `uploader`/`channel: Luis Fonsi`, `thumbnail` — but **`artist`, `album`, `track`, `release_year` are all empty** |
| `yt-dlp --flat-playlist -J 'ytsearch1:…'` | entries carry `id`, `title`, `duration`, `uploader`, `channel`, `view_count`, `thumbnails` — and **no `artist`/`album`** |
| Option support | `--print-to-file`, `--write-info-json`, `--dump-json`, `--flat-playlist`, `--no-simulate`, `--paths` all **SUPPORTED** |

The `-J` rows above were gathered by reading stdout directly. Because the shipping
wrapper can never read stdout (see *The yt-dlp layer*), the two channels the design
actually depends on were re-measured in isolation, with stdout **and** stderr
discarded:

| Probe (stdout **and** stderr discarded) | Result |
|---|---|
| `--flat-playlist --simulate --print-to-file "<id>\t<title>\t<uploader>\t<duration>\t<thumbnails>j" <file> <album url>` | **exit 0**, file written, 8,331 bytes, **11 non-empty rows**, `%(…)j` emitting valid JSON |
| `--flat-playlist --simulate --write-info-json -o <dir>/%(id)s.%(ext)s <album url>` | exit 0 but **0 files** — unusable as the playlist channel |
| `--skip-download --write-info-json -o <dir>/%(id)s.%(ext)s <a good single video>` | exit 0, wrote `dQw4w9WgXcQ.info.json` (615,759 bytes) — single videos only |
| the same on an unavailable id | **exit 1 and 0 files** — a failure leaves nothing behind to read |
| `stderr` redirected to a **file descriptor** (not a pipe) | accepted: good → exit 0 / empty log; unavailable → exit 1 / `ERROR: [youtube] <id>: This video is unavailable`; bad option → exit 2 / usage text |

### Honest limitation on the evidence

End-to-end verification used the **3 MB Python zipapp** (`python yt-dlp.zipapp
--version` → `2026.08.19`). The **17.8 MB `yt-dlp.exe`** was downloaded
(17,840,399 bytes, PE magic `MZ`) and hashed, but **could not be executed on this
machine**: its PyInstaller bootloader fails with
`[PYI-33408:ERROR] Failed to create parent directory structure` because this
development sandbox denies the temporary-directory creation that self-extraction
needs. That is an artifact of the sandbox, not a defect in the binary — but it is
unverified here, and it is why **no automated test may depend on running
`yt-dlp.exe`** (see Testing).

## Decision: shell out to yt-dlp, shipped as a pinned binary

The extraction layer becomes a thin wrapper around the `yt-dlp` executable. This
follows machinery this repository **already has, twice**:

- `src/core/ffbin.ts` — locates `ffmpeg.exe`/`ffprobe.exe`, runs them with
  `stdio: 'ignore'` and a timeout, and exchanges all data through **files**,
  because this process may run under a sandbox that denies *piped* stdio
  (`spawn EPERM`). This is exactly the constraint yt-dlp must be run under.
- `tools/fetch-deep-filter.mjs` + `tools/bin/.gitignore` — the established
  policy for a large platform binary: **never committed**, fetched per machine by
  a Node script that pins the version, the byte size and the sha256, because
  (measured in this project) PowerShell's `curl`, `Invoke-WebRequest` and .NET
  `HttpClient` all fail against GitHub release redirects while Node's global
  `fetch` succeeds. `tools/unblock-release.mjs` then strips the
  `Zone.Identifier` Mark-of-the-Web that a downloaded `.exe` carries.

Consequences, all deliberate:

1. There is no PO token, no signature deciphering, no client-version constant and
   no JSON-shape parser of ours to maintain. yt-dlp carries that burden, and the
   whole ecosystem updates it.
2. Both `@distube/ytdl-core` and `@tnfangel/ytmusic-api` are removed. The vendor
   bundle collapses to the Spotify graph alone.
3. The failure mode changes character: instead of *silently* returning nothing
   playable, a missing or stale yt-dlp produces a **named error the UI can show**
   and a `doctor` check can report.
4. Requirement: the target machine needs **no Python**. `yt-dlp.exe` is a
   standalone PyInstaller build; only the *verification* used the zipapp.

## Modules

```
src/core/
  ytdlp.ts                       (new — locate + run the binary; mirrors ffbin.ts)
  download/
    types.ts                     (modified — DownloadRoute, TrackMeta, DownloadProvider)
    errors.ts                    (new — DownloadFailure moves here)
    parse.ts                     (new — parseSpotifyUrl / parseYouTubeUrl / detect)
    resolve.ts                   (modified — dispatches to youtube sources)
    sources/youtube.ts           (new — resolveYouTubeSource())
    providers/youtubeDirect.ts   (new)
    providers/youtubeMatch.ts    (modified — yt-dlp search instead of ytmusic-api;
                                  scoring/confidence/duration-gate logic UNCHANGED)
    deps.ts                      (modified — Spotify surface only)
    queue.ts                     (modified — rawExtensions, ~5 lines)
  ffbin.ts                       (unchanged; its ffmpeg path is reused for tagging)

tools/
  fetch-ytdlp.mjs                (new — mirrors fetch-deep-filter.mjs)
  bin/.gitignore                 (modified — add yt-dlp.exe)
  README.md                      (modified — record release / size / sha256)
  build-exe.mjs                  (modified — copy yt-dlp.exe into the release)
  smoke-download.mjs             (new — the ONLY place a real yt-dlp runs)

vendor/vite side:
  tools/vendor/download-entry.ts (modified — drop both YouTube packages)
  src/vendor/download-deps.d.ts  (modified — drop the YouTube declarations)
  src/vendor/download-deps.js    (regenerated, much smaller)
  package.json                   (modified — drop both dependencies)
```

`src/core/ytdlp.ts` is a **sibling of `download/`**, not a child: it is a general
"run this external tool" module in the same family as `ffbin.ts`, and the
download module is only one consumer.

## Interface changes (the part that makes this architectural)

```ts
// before → after
type DownloadRoute = 'spotify-direct' | 'youtube-match'
                  → 'spotify-direct' | 'youtube-match' | 'youtube-direct';

interface TrackMeta {
  …
  spotifyId: string;   →   sourceId: string;                    // the platform's own id
                       +   platform: 'spotify' | 'youtube';
}

interface DownloadProvider {
  readonly rawExtension: '.ogg' | '.webm' | '.m4a';
  → readonly rawExtensions: readonly ('.ogg' | '.webm' | '.m4a')[];
}
```

- **`spotifyId` → `sourceId` + `platform`.** `grep spotifyId` over `src/` returns
  exactly two hits — written at `resolve.ts:73`, declared at `types.ts:21` — and
  `providers/youtubeMatch.ts` searches using only `artists` and `title`. Nothing
  in `src/` *reads* it, so the rename is mechanical; the `platform` field is what
  the API and UI need to decide which routes make sense for a pasted URL.
- **`rawExtension` must become an array.** yt-dlp yields Opus-in-webm or
  AAC-in-m4a depending on what the video offers. All 10 probed videos gave webm,
  but m4a-only videos exist. Forcing a single value would mean either lying about
  the container or re-encoding, and re-encoding is a second lossy generation
  before the batch engine's own transcode. The array keeps the provider honest:
  `spotify-direct` → `['.ogg']`; `youtube-direct` and `youtube-match` →
  `['.webm', '.m4a']`. `queue.ts`'s skip-if-exists check iterates the list
  instead of testing one name.
- `DownloadRoute` gains a third member, so `QueueDeps.providers`
  (`Record<DownloadRoute, DownloadProvider>`) forces every construction site to
  supply all three — a compile-time guarantee rather than a convention.
- `DownloadFailure` moves from `providers/youtubeMatch.ts` to
  `download/errors.ts`: today `queue.ts` imports a *provider* module to obtain a
  shared error type, which will not survive a third provider.

## The yt-dlp layer (`src/core/ytdlp.ts`)

Mirrors `ffbin.ts` deliberately — same resolution philosophy, same stdio
discipline, same timeout-and-escalate kill:

```ts
export function findYtDlp(explicit?: string): string;
// explicit arg → AUS_YTDLP env → appRoot()/yt-dlp.exe
//              → appRoot()/tools/bin/yt-dlp.exe → appRoot()/bin/yt-dlp.exe
//              → PATH.  Throws with every location tried, like findBinaries().

export interface RunYtDlpOptions {
  cwd: string;                 // scratch dir; the child runs here
  timeoutMs?: number;          // default: see below
  env?: Record<string, string>;
}
export interface RunYtDlpResult { code: number; timedOut?: boolean }
export function runYtDlp(bin: string, args: string[], opts: RunYtDlpOptions): Promise<RunYtDlpResult>;
```

- `spawn(bin, argv, { cwd, stdio: ['ignore', 'ignore', errFd], windowsHide: true })`.
  **Never piped.** stdout is discarded outright; stderr is redirected to a **file
  descriptor the wrapper opens itself** — a file, not a pipe. This is the same
  rule `ffbin.ts:4-9` records as measured fact rather than preference, and it was
  measured again here: this sandbox accepts a file-backed `stderr` and rejects a
  piped one.
- **Data comes back through files, never through stdout.** `--print-to-file`
  writes its rows with stdout and stderr both discarded (measured: exit 0, one
  tab-separated row per playlist entry, `%(…)j` emitting valid JSON).
  `--write-info-json` is **not** a data channel here: combined with
  `--flat-playlist --simulate` it writes zero files (measured), and it produces a
  file only for a single video resolved with `--skip-download`.
- Timeout → `SIGTERM` → grace → `SIGKILL`, resolving rather than hanging, exactly
  as `runFfmpeg` does (`DEFAULT_RUN_TIMEOUT_MS`, `KILL_GRACE_MS`). A download
  timeout is much longer than a probe's, so it is a distinct exported constant.
- **Failure reasons come from the captured stderr file plus the exit code.** The
  wrapper reads back the stderr log it opened, and maps its text and the exit code
  onto the reason set below. Measured exit codes: `0` success; `1` extraction or
  download failure, stderr `ERROR: [youtube] <id>: This video is unavailable`; `2`
  invalid invocation. The exact mapping is pinned by tests against fixtures.
  A failed item leaves **nothing** on disk, so no reason may be derived from a
  leftover file.

Reasons, joining the existing set (`timeout`, `cancelled`, `cookie-expired`,
`rate-limit`, `no-confident-match`, `io-error`):

| Reason | Cause |
|---|---|
| `ytdlp-missing` | the binary could not be located — the user has not run `fetch-ytdlp.mjs` |
| `video-unavailable` | yt-dlp reports the video is gone, private, region-blocked or age-gated |
| `live-unsupported` | a live stream has no finite audio track |
| `no-audio-format` | yt-dlp resolved the video but produced no audio file |
| `rate-limit` | yt-dlp reports throttling or a bot check (it does not distinguish these cleanly; both mean "back off and retry once") |

`ytdlp-missing` is the one that must be loud and specific, because it is the
failure a user is most likely to hit and the only one they can fix themselves.

## Source resolution

`src/core/download/parse.ts` recognises, and nothing else:

- **Spotify** — unchanged: `open.spotify.com/{track,album,playlist}/<id>` (with or
  without `intl-xx` prefix and query string) and `spotify:track:<id>` URIs.
- **YouTube** —
  - `https://www.youtube.com/watch?v=<id>`, with or without extra query params
  - `https://youtu.be/<id>`
  - `https://music.youtube.com/watch?v=<id>`
  - `https://www.youtube.com/shorts/<id>`
  - `https://(www|music).youtube.com/playlist?list=<id>` — covers `PL…`
    playlists and `OLAK5uy_…` album track lists
  - `https://music.youtube.com/browse/MPREb_…` — album page

`detectPlatform(url)` returns `'spotify' | 'youtube' | null`; a `null` is a 400.

A `watch?v=…&list=…` URL resolves to the **single track**; the list is ignored,
because that is what pasting a *video* URL means. Channel pages, `@handle` URLs
and search-result pages are rejected — they are not a track list.

`resolveYouTubeSource(url)` runs
`yt-dlp --flat-playlist --simulate --no-warnings --print-to-file "<template>" <file> <url>`,
where the template emits `id`, `title`, `uploader`, `duration` and `thumbnails`
(JSON-encoded) as tab-separated columns, and maps the rows to `TrackMeta`:

| `TrackMeta` field | Source |
|---|---|
| `title` | `title` |
| `artists` | `uploader ?? channel` |
| `album` | `''` — **yt-dlp does not populate `album` or `artist`**, not even for `music.youtube.com` URLs (measured; it routes them to the `youtube` extractor) |
| `durationSec` | `duration` (0 when absent) |
| `coverUrl` | last entry of `thumbnails[]` |
| `sourceId` | `id` |
| `platform` | `'youtube'` |

The 200-track cap applies here too, reusing the existing user-facing
"split the playlist" message. `ResolvedSource` gains `platform` so the API and UI
can tell the caller what they pasted.

## Providers

- **`youtubeDirect`** (`id: 'youtube-direct'`, `rawExtensions: ['.webm', '.m4a']`) —
  `resolve()` uses the URL layer; `download()` runs

  ```
  yt-dlp -f bestaudio/best --no-playlist --force-overwrites
         -o "<dest>/<sanitized name>.%(ext)s" -- <videoId>
  ```

  - **`--force-overwrites` is required, not cosmetic.** yt-dlp's default is
    skip-if-exists. The queue's own skip rule is *"an existing raw larger than
    1 KB counts as done"*, so a leftover stub below that threshold must be
    replaced — without this flag yt-dlp silently declines and the track hangs as
    a file that never appears.
  - **No `--write-info-json` on this path.** Metadata comes from the resolve step
    and the tagger writes the tags, so a sidecar `.info.json` would only litter the
    destination folder — and it cannot double as an error channel, because a failed
    item writes nothing at all (measured; see the evidence table above). The
    wrapper discovers the landed file by scanning for `<name>.*` beside the
    partial.
  - yt-dlp writes `<final>.part` and renames on success (the same `.part` +
    rename discipline Route B already uses), but its partial name includes the
    extension, so cancellation must delete `<dest>/<name>.*.part`, not
    `<dest>/<name>.part`.
  - Cancellation is cooperative: `opts.signal` aborts, the child is killed, and
    the partials are removed.
- **`youtubeMatch`** (`id: 'youtube-match'`, `rawExtensions: ['.webm', '.m4a']`) —
  its **scoring logic, duration gate and `no-confident-match` behaviour are
  unchanged, and nothing else in that module moves except its two I/O calls.**
  The confidence *floor* is a calibration value rather than logic, and it is the
  one number that R8 requires re-validating against yt-dlp's result population —
  treating "the code is untouched" as "the constant is still correct" would be
  exactly the unverified assumption this document exists to avoid.
  `searchYouTubeMusic()`
  becomes the same `--print-to-file` invocation with `ytsearch5:<query>` as the
  URL, and the audio fetch
  becomes `youtubeDirect`'s command. The mapping is direct:
  `id → videoId`, `uploader/channel → artistName` (used by the existing "Topic
  channel" bonus), `duration → durationSec`, `thumbnails[last] → thumbnailUrl`,
  and `albumName → null` because search rows carry no album.
- **`spotifyDirect`** — untouched. Still `node-spdl`, still `.ogg`, still
  `re-unplayplay` shipped beside the executable.

## Audio format and cover art

Best available audio, preferring Opus/webm (`itag 251` on every probed video).
Two consequences, stated plainly:

- **YouTube-sourced files carry no embedded cover art.** `.webm` cannot hold a
  picture stream, `CONTAINER_SUPPORT['.webm'].cover` is already `false`, and the
  tagger therefore never fetches a cover for them. The UI must not promise
  artwork on this path. (`coverUrl` is still populated from the thumbnail, so the
  track list can *display* it.)
- When only m4a is offered, the file is `.m4a` — which **can** hold cover art, and
  the tagger will embed it. The provider does not pretend otherwise.

## Packaging and pinning

Following `fetch-deep-filter.mjs` exactly:

- `tools/fetch-ytdlp.mjs` downloads the pinned release and verifies it before
  writing. Constants, verified on this machine:

  | Constant | Value |
  |---|---|
  | `VERSION` | `2026.08.19` |
  | `ASSET` | `yt-dlp.exe` |
  | `URL` | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe` |
  | `EXPECTED_SIZE` | `17840399` |
  | `EXPECTED_SHA256` | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` |

  Same shape as its predecessor: Node `fetch`, `--out` override, `.part` → rename
  so a crash never leaves a half-written "valid" exe, and distinct non-zero exit
  codes for mkdir / fetch / size / hash / write failures.
- `tools/bin/yt-dlp.exe` is **gitignored** with a comment naming the fetch
  command, matching the policy already written into `tools/bin/.gitignore`.
- `tools/README.md` records the release, size and sha256 to verify against.
- `tools/build-exe.mjs` step 5 copies `yt-dlp.exe` next to the executable, beside
  ffmpeg — where `findYtDlp()`'s app-local lookup finds it.
- `tools/unblock-release.mjs` already strips the download tag from every file in
  the release folder; no change needed, but the release acceptance test must
  confirm `yt-dlp.exe` is present and hash-matching.

## Testing

- **Everything that touches YouTube is mocked.** No automated test invokes
  `yt-dlp` — not merely by convention but because the binary verifiably cannot
  run under this sandbox (see the evidence limitation above). Tests inject a
  `runYtDlp` double that returns recorded JSON and writes fixture files.
- Unit tests for `parse.ts`: the accepted-URL table for both platforms plus
  hostile input; `detectPlatform` boundaries.
- Unit tests for `src/core/ytdlp.ts`: resolution order (explicit → env →
  app-local → PATH) using a fake filesystem, argument construction, timeout →
  kill escalation, and non-zero exit → reason mapping.
- Fixture tests for the JSON mapping: playlist rows → `TrackMeta`, search rows →
  the row shape `youtubeMatch`'s scorer consumes, and the field-absence cases
  (`duration` missing, `uploader` missing, empty `thumbnails`).
- Existing suites carry through mechanical edits: `spotifyId` → `sourceId`,
  `rawExtensions` in provider fixtures, and the third entry in
  `QueueDeps.providers`.
- **Manual only, never CI**: `tools/smoke-download.mjs` gains
  `--route youtube-direct --url <youtube-url>` and is the only place a real
  yt-dlp runs, per the original spec's rule that real-network checks stay manual.

## Risks

- **R6 (replaces the old R5) — yt-dlp is an external dependency now.**
  "YouTube changed" is no longer a library bug; it is a version bump. Mitigations:
  the version, size and hash are pinned in one file; `docs/download-maintenance.md`
  documents the bump as three steps (change `VERSION`/size/sha256 → re-run
  `fetch-ytdlp.mjs` → run the route smoke); and a missing binary fails with the
  named reason `ytdlp-missing` plus an actionable message rather than a silent
  no-op. The cost is that a user who never runs the fetch script gets no YouTube
  at all — which is why the failure must be loud.
- **R7 — cover art is absent on webm output, and its m4a fallback is
  unverified.** On the primary (webm) path there is no artwork at all — a visible
  quality difference versus the Spotify route, and it must be surfaced in the UI
  rather than discovered after export. The m4a fallback *can* carry a cover, but
  the URL yt-dlp reports is a **`.webp`** thumbnail on `i.ytimg.com`
  (`vi_webp/<id>/maxresdefault.webp`), whereas the tagger was built around
  Spotify's JPEG CDN. Whether `fetchCover()` + ffmpeg embed a webp correctly into
  m4a is **not established**; it must be verified during implementation, and if it
  does not work the honest outcome is to skip artwork on YouTube sources entirely
  rather than to emit a broken tag.
- **R8 — `youtube-match`'s scoring was tuned against `ytmusic-api`'s result set**
  and now consumes yt-dlp's. The fields line up (verified), but the result
  *population* differs, so the confidence floor must be re-validated against real
  yt-dlp search results before the route is declared working. This is the one
  place where "tests pass" is not sufficient evidence.
- **R9 — an `.exe` in a release folder is exactly what SmartScreen flags.**
  Already-mitigated infrastructure exists (`unblock-release.mjs`), but the release
  acceptance check must actually verify the tag was cleared.
- The original spec's **R1–R4** are unchanged and still apply.

## Non-goals

- Any platform other than Spotify and YouTube (SoundCloud, Bandcamp, …).
- Channel pages, `@handle` URLs, search-result pages, and `watch?v=…&list=…`
  treated as a playlist.
- Implementing PO tokens, signature (`cipher`) decryption, `BgUtils`, or any
  InnerTube client of our own — that approach was measured and abandoned; yt-dlp
  exists precisely so we do not do this.
- Bundling Python. The shipped artifact is `yt-dlp.exe`; the zipapp was a
  verification tool only.
- Embedding cover art in webm output, live streams, podcasts, video streams,
  lossless anything.

## Milestone sketch (orientation for the plan, not a plan)

1. `src/core/ytdlp.ts` + tests with an injected runner; `findYtDlp` resolution.
2. `tools/fetch-ytdlp.mjs`, `tools/bin/.gitignore`, `tools/README.md`; verify the
   real download matches size and sha256.
3. Interface changes (`DownloadRoute`, `sourceId`/`platform`, `rawExtensions`,
   `errors.ts`) and carry the existing suites through the mechanical edits, green.
4. `parse.ts` + `sources/youtube.ts` + `providers/youtubeDirect.ts`, all offline
   fixture-tested.
5. `youtubeMatch` rewiring onto yt-dlp; re-validate its confidence floor against
   real search results (R8), then hand-run the route smoke.
6. Remove both npm packages, regenerate the vendor bundle, re-pin the façade test.
7. Then the original plan's **Tasks 7–9** (server API, 下載 tab, packaging) apply
   with `youtube-direct` folded in: the API's `resolve` response gains
   `platform`, and the UI offers the route radio only for Spotify sources while a
   pasted YouTube URL selects `youtube-direct` automatically.
