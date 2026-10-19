# YouTube as a Download Source + Self-Hosted InnerTube Layer — Design Spec

Date: 2026-10-19
Status: Design approved in chat (approach A; audio format decided); spec under review
Next artifact: implementation plan (writing-plans), only after spec approval

**Amends** `docs/superpowers/specs/2026-10-18-cross-platform-download-design.md`:
its non-goal *"Other platforms (YT Music direct, …)"* is superseded **for YouTube
only**, and the shared interfaces it froze (`DownloadRoute`, `TrackMeta`,
`DownloadProvider`) change shape. Everything else in that spec still stands.

## Why this exists

The user asked to implement YouTube as a source (paste a YouTube / YouTube Music
URL, single track or playlist / album) — the explicit v0.3 non-goal. While
scoping it, live probing on the target machine showed the already-committed
YouTube stack does not work at all. That turned "add a provider" into "replace
the extraction layer", and the replacement is what makes both the new
`youtube-direct` route *and* the existing `youtube-match` route (Route B)
functional.

## Evidence (live probes, target machine, 2026-10-19)

| Probe | Result |
|---|---|
| `fetch('https://www.youtube.com/watch?v=…')` | **200 `text/html`** — network, DNS and TLS are fine |
| `@tnfangel/ytmusic-api@5.3.0` `searchSongs()` | **HTTP 400** |
| `@tnfangel/ytmusic-api@5.3.0` after `initialize()` | `initialize()` resolves, then **every** call 400s |
| `@distube/ytdl-core@4.16.12` `getInfo()` | throws `Failed to find any playable formats` |
| Raw InnerTube `WEB_REMIX` `/search` | **200**, real results (`musicResponsiveListItemRenderer`) |
| Raw InnerTube `WEB` `/player` | `UNPLAYABLE` — **original `ytdl-core`'s failure is the same bot / PO-token gate** |
| Raw InnerTube **`ANDROID_VR 1.60.19`** `/player` | **`playabilityStatus: OK`, `streamingData` present, 4 audio formats, every `url` direct (`cipher: 0`, no `pot`)** |
| `GET` (Range) on that format's URL | **206**, `audio/webm`, `content-range bytes 0-65535/3433755`, body starts with EBML magic `1a45dfa3` |
| Raw InnerTube `WEB_REMIX` `/browse` on `VL<PL…>` | **66 track rows, every one with `videoId`**, plus a continuation token for paging |
| Raw InnerTube `WEB_REMIX` `/browse` on `VL<OLAK5uy_…>` | 20 track rows (this is how YouTube Music album URLs address an album) |

Conclusions that drive the design:

- The breakage is **inside both third-party packages**, not the environment.
- The `WEB` client family is gated; the **`ANDROID_VR` client family returns
  direct, cipher-free audio URLs** today, verified end-to-end down to the bytes.
- Playlists and albums are reachable without any package.
- Therefore the two packages are **removable**, replaced by ~250 lines we own.

## Decision: the InnerTube client lives in `src/`, not in the vendor bundle

The client is **our own code** and imports nothing but the global `fetch` and
Node built-ins, so it is not third-party and the vendoring rule does not apply
to it. Two consequences:

1. It is unit-testable offline against recorded fixtures — and extraction drift
   is the single largest long-term risk of this feature, so being able to pin
   parsers with tests matters more than anything else here.
2. The vendor bundle collapses back to the Spotify/`spdl` graph only, and
   `@distube/ytdl-core` + `@tnfangel/ytmusic-api` leave `package.json`.

## Modules

```
src/core/youtube/                 (new — our code, no third-party imports)
  types.ts      — YouTubeRow, YouTubeTrackInfo, YouTubePlaylistInfo, InnerTubeError
  parse.ts      — PURE: InnerTube JSON → our rows / formats / continuation token
  client.ts     — HTTP + the client configurations; search / track / playlist / audio-url
  url.ts        — parseYoutubeUrl()

src/core/download/
  types.ts           (modified — DownloadRoute, TrackMeta.sourceId)
  errors.ts          (new — DownloadFailure moves here from providers/youtubeMatch.ts)
  resolve.ts         (unchanged — Spotify, already committed and tested)
  sources/youtube.ts (new — resolveYoutubeSource(), + resolveAnySource() dispatcher)
  providers/youtubeDirect.ts (new)
  providers/youtubeMatch.ts  (modified — import paths + rawExtension only; scoring untouched)
  deps.ts            (modified — Spotify surface only)

vite/vendor side:
  tools/vendor/download-entry.ts   (modified — drop both YouTube packages)
  src/vendor/download-deps.d.ts    (modified — drop the YouTube declarations)
  package.json                     (modified — drop both dependencies)
  src/vendor/download-deps.js      (regenerated, much smaller)
```

`src/core/youtube/` is a sibling of `src/core/download/`, not a child of it: it
is a general YouTube access layer, and `youtube-match` only happens to be one
consumer.

## Interface changes (the part that makes this architectural)

```ts
// before → after
type DownloadRoute = 'spotify-direct' | 'youtube-match'
                  → 'spotify-direct' | 'youtube-match' | 'youtube-direct';

interface TrackMeta {
  …
  spotifyId: string;   →   sourceId: string;   // the platform's own id
}
```

- `sourceId` is Spotify's track id for Spotify sources and the YouTube
  `videoId` for YouTube sources — the field feeds `download()`, and it was only
  ever *written* at `resolve.ts:73` and *read* by tests, so the rename is
  mechanical.
- `DownloadRoute` gains a third member, so `QueueDeps.providers`
  (`Record<DownloadRoute, DownloadProvider>`) forces every construction site to
  supply all three — a compile-time guarantee rather than a convention.
- `DownloadFailure` moves from `providers/youtubeMatch.ts` to
  `download/errors.ts`; today `queue.ts` has to import a *provider* module to
  get a shared error type, which will not survive a third provider.
- `rawExtension` stays a single static `.webm` per YouTube provider (see the
  audio-format decision below), so `queue.ts`'s skip-path arithmetic at `:428`
  is unchanged.

## The extraction layer (`src/core/youtube/`)

Two client configurations, both needed, both pinned as named constants:

| Purpose | Client | Notes |
|---|---|---|
| Search, playlist/album listing | `WEB_REMIX` (host `music.youtube.com`) | the only family observed to accept a plain `musicResponsiveListItemRenderer` search without bot gating |
| Audio URLs | `ANDROID_VR` `1.60.19` | the only family observed to return `playabilityStatus: OK` with **direct, cipher-free** audio URLs |

Nothing in this layer decrypts signatures, and no PO token is minted: the
design deliberately rides on a client family that does not require either. That
is also its fragility — see Risks.

Public surface:

```ts
class InnerTubeError extends Error { readonly reason: string }

interface InnerTubeClient {
  searchMusic(query: string): Promise<YouTubeRow[]>;
  getTrack(videoId: string): Promise<YouTubeTrackInfo>;
  getPlaylist(id: string): Promise<YouTubePlaylistInfo>;   // pages via continuation
  getAudioUrl(videoId: string): Promise<{ url: string; container: '.webm'; bitrate: number }>;
}
function createInnerTubeClient(opts?: { fetch?, maxPages? }): InnerTubeClient;
```

- `parse.ts` holds every JSON-shape assumption and is pure, so the fixtures that
  pin the fragile part are plain objects passed to plain functions.
- The client throws `InnerTubeError` with a machine `reason`; the queue already
  duck-types a string `reason` property (`queue.ts:173`), so no shared import is
  needed between the YouTube layer and the download module.
- Playlist paging is capped at **200 tracks**, matching the Spotify route's cap
  and reusing its user-facing "split the playlist" message.

Failure reasons introduced here, joining the existing set:

| Reason | Cause |
|---|---|
| `rate-limit` | HTTP 429, or a bot-check / `LOGIN_REQUIRED` playability status |
| `video-unavailable` | `playabilityStatus.status !== 'OK'` for any other reason |
| `no-audio-format` | the player response offers no `audio/webm` format |
| `live-unsupported` | live streams have no finite audio track |
| `network-error` | fetch/transport failure |

## Source resolution

`parseYoutubeUrl()` accepts, and nothing else:

- `https://www.youtube.com/watch?v=<id>`, with or without extra query params
- `https://youtu.be/<id>`
- `https://music.youtube.com/watch?v=<id>`
- `https://www.youtube.com/shorts/<id>`
- `https://(www|music).youtube.com/playlist?list=<id>` — covers `PL…` playlists
  and `OLAK5uy_…` album track lists
- `https://music.youtube.com/browse/MPREb_…` — album page

A `watch?v=…&list=…` URL resolves to the **single track**; the list is ignored,
because that is what the user pasted a *video* URL for. `youtube.com/@channel`
and search-result pages are rejected — they are not a track list.

`resolveAnySource(url, { spotifyClient, youtubeClient })` returns
`{ platform: 'spotify' | 'youtube', source: ResolvedSource }`. Unrecognised URLs
are a 400; the Spotify path keeps its existing oEmbed degradation.

## Providers

- `youtubeDirect` — `id: 'youtube-direct'`, `rawExtension: '.webm'`. `resolve()`
  uses the URL layer; `download()` calls `getAudioUrl(track.sourceId)`, streams
  the response body to `<dest>/<sanitized>.webm.part`, renames on a clean
  finish, and deletes the partial on abort or failure (the same `.part` + rename
  discipline Route B already uses). Honours `opts.signal`.
- `youtubeMatch` — unchanged in behaviour, including scoring, the confidence
  floor and the `no-confident-match` reason. Only its imports and its default
  dependency wiring move to `src/core/youtube/`.

## Audio format: prefer webm/Opus, no embedded cover art (user's decision)

The audio format is the best available **`audio/webm`** (Opus — `itag 251` on
the probed videos), chosen by bitrate. Consequences, stated plainly:

- Source fidelity is the best YouTube offers, and `.webm` is already Route B's
  declared container, so nothing about `rawExtension` or the queue changes.
- **YouTube-sourced files will carry no embedded cover art.** `.webm` cannot
  hold a picture stream, `CONTAINER_SUPPORT['.webm'].cover` is already `false`,
  and the tagger therefore never fetches a cover for them. This must be visible
  in the UI rather than silently disappointing: the YouTube path must not
  promise artwork. (`coverUrl` is still populated from the thumbnail so the UI
  can *display* it in the track list.)
- If the player response offers no webm audio at all, the track fails
  `no-audio-format` rather than writing a file whose extension lies about its
  container.

## Removals

- `package.json`: `@distube/ytdl-core`, `@tnfangel/ytmusic-api` (and their
  transitive weight) leave; `node-spdl`, `@spdl/*`, `re-unplayplay` stay — Route
  A is untouched.
- `src/vendor/download-deps.d.ts`: the `YouTubeSongRow`, `searchYouTubeMusic`,
  `getYouTubeStream`, `getYouTubeAudio`, `getYouTubeInfo` declarations go.
- `getYouTubeStream` and `getYouTubeInfo` have **zero consumers** in `src/`
  today — only `deps.ts` re-exports them and `test/download-deps.test.ts:28-30`
  asserts they exist. They are dropped rather than ported, and that assertion
  is rewritten to pin the new, smaller façade.
- `tools/vendor/download-entry.ts` loses both imports and the whole YouTube
  section (`:122-195`).

## Testing

- **Offline fixture tests** for `parse.ts` (search rows, playlist rows +
  continuation, player audio-format selection, every failure status) and
  `url.ts` (the accepted-forms table plus hostile inputs). This is the part that
  protects against drift and it runs in CI — unlike the network.
- **Client tests** with an injected `fetch` double: header/body construction,
  the two client configurations, paging cap, abort propagation, and each
  `InnerTubeError` reason.
- Existing suites keep passing with mechanical updates: `spotifyId` →
  `sourceId`, the third provider in `QueueDeps.providers` fixtures, and the
  `download-deps` façade assertions.
- **Manual only**, never CI: a real-network check in `tools/smoke-download.mjs`
  that resolves a known track and a known playlist and downloads one track.
  Real-network checks stay manual per the original spec.

## Risks

- **R6 (new, the big one)** `ANDROID_VR`'s client version is the load-bearing
  constant. When YouTube retires it, audio URLs stop being returned and every
  YouTube route fails with `video-unavailable`/`no-audio-format` — loudly, per
  track, not silently. Mitigations: the version and both client ids live in one
  named constant block with a comment pointing at this risk; the failure is a
  distinct reason the UI names; and `docs/download-maintenance.md` (Task 9)
  gains the bump procedure — raise the version, re-run the fixture tests, then
  run `tools/smoke-download.mjs` route B — since a version bump is exactly the
  kind of change the fixture tests cannot catch on their own.
- **R7** Search-row metadata is thinner than `ytmusic-api`'s was: rows carry
  title, artist, duration and thumbnail, but **not an album name** for ordinary
  songs. `album` is therefore `''` for search-derived matches, which is honest
  rather than wrong. Playlist/album listings do carry album context.
- **R8** The `youtube-match` route's scoring was tuned against
  `ytmusic-api`'s `searchSongs` result set; the new search returns a
  slightly different population (and duration must be parsed out of the row's
  metadata text). The scoring thresholds and the confidence floor must be
  re-validated against the new search before the route is declared working.
- Superseded: the original spec's **R5** (relying on exact npm pins to survive
  YouTube drift) is replaced by R6 — there is no package left to pin, so drift
  now lands on a constant we own and a smoke test we run.
- The original spec's R1–R4 are unchanged and still apply.

## Non-goals

- Any platform other than Spotify and YouTube (SoundCloud, Bandcamp, …).
- Channel pages, YouTube search-result pages, and `watch?v=…&list=…` treated as
  a playlist.
- Signature (`cipher`) decryption, PO-token minting, and any Widevine-style
  work on the YouTube path — the design picks a client family that needs none.
- Embedding cover art in YouTube-sourced output (see the format decision).
- Live streams, podcasts, video streams, lossless anything.

## Milestone sketch (orientation for the plan, not a plan)

1. `src/core/youtube/` — types, pure parsers + fixtures, URL table (offline, CI).
2. Client + injected-fetch tests; abort and both failure families pinned.
3. Interface changes (`DownloadRoute`, `sourceId`, `errors.ts`) + carry the
   existing suites through the mechanical edits, green.
4. `sources/youtube.ts`, `providers/youtubeDirect.ts`, `youtubeMatch` rewiring.
5. Drop the two dependencies, regenerate the vendor bundle, re-pin the façade
   test, hand-run the route-B smoke check.
6. Then the original plan's Task 7–9 (server API, 下載 tab, packaging) apply with
   `youtube-direct` folded in — the API contract gains `platform` on resolve and
   the UI shows the route radio only for Spotify sources.
