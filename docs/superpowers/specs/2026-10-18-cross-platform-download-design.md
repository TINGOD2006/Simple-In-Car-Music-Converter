# Cross-Platform Music Download — Design Spec

Date: 2026-10-18
Status: Design approved in chat; spec under review
Next artifact: implementation plan (writing-plans), only after spec approval

## Goal

Let the user paste a Spotify URL (track / album / playlist), preview the resolved
track list, download the audio through one of two selectable routes, and have the
downloaded files flow into the existing USB conversion pipeline automatically —
the same loudness normalization, tagging and verification every other source gets.

Two routes, both approved by the user:

- **Route A — Spotify Direct** (`spotify-direct`): the user's own Spotify account,
  authenticated with the browser's `sp_dc` cookie, downloading Spotify's real
  stream via `node-spdl`. OGG Vorbis 160 kbps (free account) or 320 kbps
  (Premium). Technically against Spotify ToS; personal-use grey area. The UI
  says so plainly.
- **Route B — YouTube Match** (`youtube-match`): no account of any kind. Spotify
  supplies metadata (title / artists / duration / cover); the audio comes from
  YouTube Music, found by search and picked by a scoring function, downloaded
  with `@distube/ytdl-core`.

Both routes converge on the same post-download path: raw file → tag → convert
with the chosen USB preset → scan-visible in the USB tab.

## Non-goals (v0.3)

- Other platforms (YT Music direct, SoundCloud, …). The `DownloadProvider`
  interface is the extension point; adding a provider must not touch queue, API
  or UI logic. **Superseded for YouTube only** by
  `docs/superpowers/specs/2026-10-19-youtube-source-design.md`, which also
  records that the extension point turned out to be insufficient: adding a real
  second platform changed `DownloadRoute`, `TrackMeta` and the vendor façade,
  and replaced the two YouTube packages this spec pinned because live probing
  showed neither could produce playable formats.
- Lossless downloads from Spotify (no supported tool does this).
- Persisting the download queue across engine restarts (same in-memory semantics
  as the batch job registry; files already on disk survive, and re-starting a
  download skips existing files).
- Lyrics, videos, or podcast video formats.

## Dependencies (all pure JavaScript, no system components)

| Package | Used for | Pinned |
|---|---|---|
| `node-spdl` | Route A stream + Spotify internal API wrapper | exact |
| `@distube/ytdl-core` | Route B audio stream | exact |
| `@tnfangel/ytmusic-api` | Route B search | exact |

Exact pins, never `^`: YouTube extraction breaks quietly across minor versions
and we want upgrades to be a deliberate, tested act (Risk R5).

## Engine module: `src/core/download/`

```
src/core/download/
  types.ts                    — TrackMeta, DownloadRoute, per-track state machine,
                                DownloadProvider interface, progress events
  resolve.ts                  — Spotify URL parsing (track / album / playlist,
                                with ?si= and friends), metadata fetch
  queue.ts                    — in-process download queue: bounded concurrency,
                                jitter, per-track timeout, cancel, retry, skip
  tagger.ts                   — ID3/Vorbis tags + cover art onto the raw file
  providers/
    spotifyDirect.ts          — Route A provider
    youtubeMatch.ts           — Route B provider (search + score + download)
```

### Key shapes

```ts
interface TrackMeta {
  title: string;
  artists: string;          // joined ", "
  album: string;
  durationSec: number;      // Spotify's own number; scoring target
  coverUrl: string;
  spotifyId: string;
}

type TrackState =
  | 'queued' | 'downloading' | 'tagging' | 'converting'
  | 'done' | 'failed' | 'skipped' | 'cancelled';

interface DownloadProvider {
  readonly id: DownloadRoute;
  resolve(url: string): Promise<ResolvedSource>;      // shared, in resolve.ts
  download(track: TrackMeta, destPath: string, opts: DownloadOpts): Promise<void>;
}
```

### `resolve.ts` — URL → track list

- Accepts `open.spotify.com/{track,album,playlist}/<id>` (with or without query
  string) and `spotify:track:<id>` URIs.
- Metadata comes from `node-spdl`'s Spotify API wrapper (it already talks to
  Spotify's internal endpoints for Route A; Route B reuses the same wrapper so
  both routes see identical metadata). If the wrapper cannot list a playlist
  (Risk R1), the fallback is Spotify's public embed/oEmbed data — degraded
  metadata (album cover, no per-track artists) and the UI says the source is
  partially resolved.
- Playlist cap: 200 tracks per resolve, hard, with a clear message. Beyond that
  the user splits the playlist — this bounds queue memory and abuse exposure.

### `queue.ts` — the download queue

- Singleton per server process, in-memory, mirroring `src/server/jobs.ts`
  philosophy: a download is a foreground user action; a restart legitimately
  loses it.
- Concurrency: **2** parallel downloads (both providers rate-limit aggressively).
  Between track starts a 500–1500 ms random jitter.
- Per-track timeout: **5 minutes** wall clock, enforced the same way the ffmpeg
  timeout fix works (timer → abort the stream → settle the promise) — a hung
  socket must fail a track, never wedge the queue.
- Global pause-and-retry-once on rate-limit signals (HTTP 429, YouTube
  "confirm you're not a bot" responses): back off 30 s, retry once, then fail
  the track with that reason.
- States advance `queued → downloading → tagging → converting → done`; failures
  carry a machine reason plus a Traditional-Chinese user message.
- `retry(downloadId, trackIndices)` re-queues failed tracks.
- Skip-if-exists: when the target file already exists with size > 1 KB, the
  track becomes `skipped` — this is what makes re-running a playlist cheap.
- Cancellation: cooperative, at the current stream; a cancelled track's partial
  file is deleted.

### `providers/youtubeMatch.ts` — search + score

Query: `<artists> <title>` against YouTube Music (`searchSongs`). Candidate
scoring, all normalized first:

1. **Duration gate**: `|candidate - spotify| > 3 s` → disqualified unless every
   candidate fails the gate, in which case the closest wins *only* if within
   10 s.
2. **Channel bonus**: official artist channel / "Topic" channel ranks above
   random uploads.
3. **Title similarity**: token-overlap on the normalized title (lowercase,
   strip parenthetical qualifiers like `(Official Audio)`, `(Lyrics)`).
4. **Confidence floor**: if the best candidate scores below the floor, the track
   fails with reason `no-confident-match` — a wrong song is worse than no song.

Download: audio-only stream, highest audio bitrate available (`@distube/ytdl-core`
format filter), container whatever YouTube yields (`.webm`/`.m4a`); the
conversion pass re-encodes to the USB preset anyway, so the raw container is
transport, not deliverable.

### `providers/spotifyDirect.ts` — the cookie route

- Client created lazily from the stored `sp_dc` cookie; one client reused
  across the queue.
- Auth failures map to a typed `CookieExpiredError`; the queue fails the
  *remaining* tracks fast with reason `cookie-expired` instead of grinding
  through 200 failures.
- Output: `.ogg` as delivered. 320 kbps only appears with Premium — the UI
  reports the actual bitrate detected, it does not promise.

### `tagger.ts` — tags on the raw file

- Writes `title`, `artist`, `album`, track number, and embeds the cover JPEG
  fetched from Spotify's CDN.
- MP3/ID3 uses ID3v2.3 (matching the USB preset's existing `id3v2v3` choice).
  Implementation reuses the render pipeline's existing tag handling where it
  can; cover art is the one bit that likely needs one direct ffmpeg call per
  file (Risk R2) — verify during planning, not guessed.

## Server endpoints (`src/server/index.ts`)

Same if-block + `send()` conventions as every existing route; the download
module is imported directly (it ships as a real dependency — the
`optionalModule` dance stays reserved for the modules that predate their own
dependencies).

| Route | Body / params | Returns |
|---|---|---|
| `POST /api/download/resolve` | `{url}` | `{ok, source:{kind, name, tracks: TrackMeta[]}}`, 400 on unparseable URL, 502 on upstream failure |
| `POST /api/download/start` | `{source, route, destination, trackIndices?}` | `{ok, downloadId}` 202-style, 400 when destination missing or route unknown |
| `GET /api/download/status` | `?downloadId=` | per-track states + counts; 404 unknown id |
| `POST /api/download/cancel` | `{downloadId}` | `{ok}` |
| `POST /api/download/retry` | `{downloadId, trackIndices}` | `{ok}` |
| `GET /api/download/settings` | — | `{spotifyCookieSet: boolean, cookieHint: "sp_dc=****abcd", destination?}` — **never the cookie itself** |
| `PUT /api/download/settings` | `{spotifyCookie?, destination?}` | `{ok}`; cookie validated for shape only, never logged |

The engine reuses the generic `/api/jobs` registry **only** where it fits; the
per-track download status is richer than `JobProgress {stage, done, total}`,
so the queue owns its own state and `/api/download/status` reads it directly.

## Settings storage (new): `src/core/appsettings.ts`

- File: `%LOCALAPPDATA%/AudioUsbStudio/config.json`, fallback
  `%APPDATA%/AudioUsbStudio/config.json` — the same candidate philosophy as
  `approot.ts`'s scratch resolution.
- Contents: `{ download: { spotifyCookie: string | null, destination: string | null } }`.
- The cookie is the only secret this app has ever stored. Rules: never logged,
  never echoed back through any GET, never included in an error message. A
  future doctor command may report `cookie: set/unset` and nothing more.

## Destination and the path into the existing pipeline

- Default destination: the USB tab's working folder + `Downloads/<source name,
  sanitized>/`, remembered in config. If no working folder is known, the UI
  asks once via the existing folder picker and stores the answer.
- Raw files land with their true extensions (`.ogg`, `.webm`, `.m4a`) — the
  library scanner must accept these as streamable sources (Risk R3: confirm
  `isStreamableAudio` coverage; extend the list if needed).
- Conversion is part of the per-track pipeline (`converting` state): after
  tagging, the queue invokes the existing batch engine over the finished
  tracks, so staging-sweep, verify, and manifest machinery come for free and
  the output is exactly what a hand-scanned file would get.

## UI (web)

- New `web/src/components/DownloadTab.tsx`; `App.tsx` gains the 下載 tab
  following the existing tab-dispatch pattern.
- Sections, top to bottom:
  1. URL input + 解析 button; resolved source header (kind, name, cover).
  2. Route radio: 路線 B 無需帳號（預設） / 路線 A 登入 Spotify（需先在設定貼上
     cookie；音質較高；違反 Spotify 條款，請自行斟酌）.
  3. Destination row (path + change button).
  4. Track list with checkboxes, 全選, per-row duration and artist.
  5. 開始下載 → progress table with per-track state pills and failure reasons;
     per-track and batch retry; 取消.
  6. Settings row: cookie input (paste-only, value never rendered back),
     destination.
- Polling: `/api/download/status` at 1 s while a download is active — same
  rhythm the USB tab uses for jobs.
- After a download finishes: a button jumps to the USB tab where the files are
  already scannable.

## Error handling summary

| Failure | Behaviour |
|---|---|
| Cookie expired (A) | Remaining tracks fail fast (`cookie-expired`); UI offers re-paste in settings |
| No confident match (B) | Track fails `no-confident-match`; batch continues; retry available |
| YouTube rate limit / bot check | Global 30 s back-off, one retry, then per-track failure with the reason |
| Hung stream | 5-min per-track timeout kills it; track fails, queue survives |
| Disk full / permission | fs error becomes per-track failure; queue survives |
| Engine restart | Queue gone; files persist; re-run skips existing files |

## Testing

- Unit (mock providers injected into the queue): URL parsing across every
  accepted form; scoring table (duration gate, channel bonus, similarity,
  confidence floor); queue state machine — concurrency cap, jitter presence,
  cancel mid-flight, timeout kill, retry, skip-if-exists; appsettings
  read/write/fallback; cookie masking in the settings GET.
- Integration: mock provider drives resolve → start → status → files on disk →
  conversion via the real batch engine on a temp folder → done; failure
  injection (timeout, truncated stream, cookie expiry).
- Real-network checks stay manual: a documented smoke script (scratch, like the
  existing engine probes) exercises both routes against a known track before a
  release. Never in CI.
- Everything runs through `node test/run.ts` and both typechecks, as the house
  rules require.

## Risks

- **R1** Spotify metadata access relies on `node-spdl`'s internal-API wrapper;
  it may break. Fallback: embed/oEmbed metadata (degraded) with a visible
  warning.
- **R2** Cover-art embedding may need one direct ffmpeg call per file; verify
  the existing tag machinery before planning the task.
- **R3** The scanner's accepted-extension list must include the raw download
  containers, or downloaded files never reach the USB tab.
- **R4** The packaged single-file exe must bundle the three new packages;
  `tools/build-desktop-release.mjs` acceptance check gets a bundle-verification
  step (byte-search pattern already exists from previous releases).
- **R5** YouTube extraction drift: exact pins + a documented "bump and re-test
  smoke script" procedure.

## Milestones (orientation for the plan, not a plan)

1. M1 — settings storage + resolve + API skeleton (resolve/status 501s)
2. M2 — Route B end-to-end (search, score, download, tag)
3. M3 — queue + DownloadTab UI
4. M4 — Route A (cookie storage, node-spdl provider)
5. M5 — auto-conversion into the batch pipeline + UX polish
6. M6 — packaging verification and release build
