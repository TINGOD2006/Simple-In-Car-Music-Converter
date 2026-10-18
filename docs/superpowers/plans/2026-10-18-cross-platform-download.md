# Cross-Platform Music Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a Spotify URL, preview tracks, download via Route A (node-spdl, sp_dc cookie) or Route B (YouTube Music match, no account), then tag + auto-convert through the existing batch engine so files appear in the USB tab.

**Architecture:** New engine module `src/core/download/` (resolve → queue → provider → tagger), a flush-batched conversion pass that reuses `runBatch`, 7 new API routes in the existing if-block handler, and one new 下載 tab. Third-party packages are bundled once into a checked-in vendor file so the SEA exe build (`tools/build-exe.mjs`) keeps its "zero third-party imports" property.

**Tech Stack:** Node >=22.6 (running 24.20), TypeScript NodeNext ESM, ffmpeg via `src/core/ffbin.ts`, React + Vite web UI, new deps `node-spdl` / `@distube/ytdl-core` / `@tnfangel/ytmusic-api` (exact pins, bundled by esbuild into `src/vendor/download-deps.js`).

**Spec:** `docs/superpowers/specs/2026-10-18-cross-platform-download-design.md` — read it first; this plan argues from it.

## Planning-time verifications already done (R2/R3 facts, do not re-guess)

- ffmpeg 8.1 cover attach: **MP3 ✅ and M4A ✅** in one `-c copy` pass with tags (`-map 0:a -map 1 -c copy -id3v2_version 3 -disposition:v attached_pic` → `attached_pic=mjpeg`). **OGG ❌** (`[ogg] Unsupported codec id in stream 1`) — ogg gets text tags only.
- OGG text tags need `-map_metadata -1` + `-metadata k=v` and surface in ffprobe **stream** tags, not `format.tags` (both variants verified empirically).
- `readTags` (`src/core/tags.ts:61`) reads only `info.format.tags` → Task 5 extends probe/readTags to merge stream tags, or every tagged .ogg loses its tags during conversion.
- R3 is already satisfied: `AUDIO_EXTENSIONS` (`src/server/files.ts:27-33`) contains `.ogg`, `.oga`, `.webm`, `.m4a` — Task 5 adds a pinning test only.
- Packaging (R4): `tools/build-exe.mjs` tsc→SEA-assets pipeline only collects `build/**/*.js` and the launcher materializes every asset key into a temp dir with `{"type":"module"}` — so one checked-in vendor bundle at `src/vendor/download-deps.js`, copied to `build/vendor/`, is importable in both dev and packaged builds.

## Global Constraints

- Exact pins, never `^`: `node-spdl`, `@distube/ytdl-core`, `@tnfangel/ytmusic-api` (`npm i --save-exact`). Bumps are a deliberate, tested act (spec R5).
- Engine source imports third-party packages **only** through `src/core/download/deps.ts` → `src/vendor/download-deps.js`. Pinned by a scan test (Task 2).
- Never log, echo, return, or error-embed the sp_dc cookie; GET settings returns `{spotifyCookieSet, cookieHint: "sp_dc=****<last4>"}` only.
- All user-facing copy Traditional Chinese.
- Queue numbers (spec-mandated): concurrency **2**; start jitter **500–1500 ms**; per-track timeout **5 min**; rate-limit backoff **30 s**, retry **once**; skip-if-exists threshold **> 1 KB**; playlist cap **200 tracks**; ID3v2.3 (`-id3v2_version 3`) for MP3.
- Tests run via `node test/run.ts` (auto-discovers `test/*.test.ts`; `node --test` is forbidden — sandbox denies child processes). Typecheck: `npm run typecheck` at repo root and inside `web/`.
- No new system components; everything pure JS/Node.
- Real-network checks are manual only (`tools/smoke-download.mjs`, Task 9) — never in the automated suite.
- Dev ffmpeg lives at `C:\ffmpeg-8.1-full_build\bin\ffmpeg.exe`; engine code always gets binaries from the server (`findBinaries`), never hardcoded.

## Review Focus

1. **URL forms**: uppercase host, trailing `?si=…` junk, `spotify:track:<id>` URI, extra path segments — must resolve or 400 politely, never crash. Pinned: Task 3 URL-table test.
2. **Duplicate 開始下載** (double click): a second start of the same source+destination while one is running returns the same `downloadId`, never two queues. Pinned: Task 7 idempotent-start test.
3. **Filesystem-hostile names** (`AC/DC`, `?:*"<>|`, emoji, 200-char titles): sanitized filenames, download still succeeds. Pinned: Task 3 `sanitizeFilename` table test + Task 6 filename usage.
4. **Playlist > 200 tracks**: resolve fails with a clear Traditional-Chinese cap message; nothing starts. Pinned: Task 3 cap test.
5. **Cookie leakage**: no response body, log line, or error message ever contains the raw cookie. Pinned: Task 1 mask test + Task 7 settings-GET and "no-cookie-substring" sweep.

---

### Task 1: Settings storage — `src/core/appsettings.ts`

**Files:**
- Create: `src/core/appsettings.ts`
- Test: `test/appsettings.test.ts`

**Interfaces:**
- Produces: `readDownloadSettings(baseDirs?: string[]): { spotifyCookie: string | null; destination: string | null }`; `writeDownloadSettings(patch: { spotifyCookie?: string | null; destination?: string | null }, baseDirs?: string[]): void`; `maskCookie(cookie: string): string`; `configBaseDirs(): string[]` (`%LOCALAPPDATA%/AudioUsbStudio` then `%APPDATA%/AudioUsbStudio`, mirroring `approot.ts` candidate philosophy at `src/core/approot.ts:146`).
- Consumers: Task 6 (destination default), Task 7 (settings routes), Task 8 (UI hint).

- [ ] **Step 1: Write the failing test** — `test/appsettings.test.ts` with a temp-dir base: roundtrip write→read of `{spotifyCookie:"sp_dc=abcdef123456", destination:"D:\\Music"}`; `maskCookie("sp_dc=abcdef123456")` returns `"sp_dc=****3456"` (last 4, and the full value appears nowhere); missing file → `{spotifyCookie:null, destination:null}`; corrupt JSON file → defaults, no throw; second `baseDirs` candidate used when the first has no file; `writeDownloadSettings` preserves unknown sibling keys already in config.json.
- [ ] **Step 2: Run** `node test/run.ts` — expect the new suite FAILS (module not found).
- [ ] **Step 3: Implement** `src/core/appsettings.ts`: JSON file `config.json` = `{ download: { spotifyCookie, destination } }`; reads merge candidates in order, first existing file wins; writes go to the FIRST writable candidate (use `probeWritable` philosophy); never log cookie values.
- [ ] **Step 4: Run** `node test/run.ts` — expect PASS (281 + new).
- [ ] **Step 5: Commit** `git add src/core/appsettings.ts test/appsettings.test.ts && git commit -m "feat: app settings storage for download module"`

### Task 2: Vendor bundle + deps façade (R4 foundation)

**Files:**
- Modify: `package.json` (three exact-pinned deps)
- Create: `tools/bundle-download-vendor.mjs`, `src/vendor/download-deps.js` (generated, checked in), `src/vendor/download-deps.d.ts`, `src/core/download/deps.ts`
- Modify: `tools/build-exe.mjs` (copy vendor into `build/vendor/` after tsc, before asset collection)
- Test: `test/download-deps.test.ts`

**Interfaces:**
- Produces (the façade contract — adapt .d.ts internals to the real package exports, never the façade names):
  ```ts
  // src/vendor/download-deps.d.ts (hand-written types over the bundle)
  export interface SpotifyApiTrack { id: string; name: string; artists: { name: string }[]; album: { name: string; images: { url: string }[] }; duration_ms: number }
  export interface SpotifyClient {
    download(url: string): NodeJS.ReadableStream;
    getTrack(id: string): Promise<SpotifyApiTrack>;
    getAlbum(id: string): Promise<{ name: string; tracks: SpotifyApiTrack[]; images: { url: string }[] }>;
    getPlaylist(id: string): Promise<{ name: string; tracks: SpotifyApiTrack[] }>;
  }
  export declare function createSpotifyClient(cookie: string): Promise<SpotifyClient>;
  export interface YtmSong { videoId: string; name: string; artistNames: string; album: string | null; durationSec: number }
  export declare function searchYtmSongs(query: string): Promise<YtmSong[]>;
  export declare function ytdlDownloadAudio(videoId: string, destPath: string): Promise<{ container: 'webm' | 'm4a' }>
  ```
- Produces: `src/core/download/deps.ts` re-exports the façade (the ONLY third-party import in `src/`).
- Consumers: Tasks 3, 4, 6.

- [ ] **Step 1: Install exact pins** — `npm i --save-exact node-spdl @distube/ytdl-core @tnfangel/ytmusic-api`; verify `package.json` shows no `^` on the three.
- [ ] **Step 2: Write the failing test** — `test/download-deps.test.ts`: (a) dynamic-import `src/core/download/deps.ts` and assert `typeof createSpotifyClient === 'function'`, `typeof searchYtmSongs === 'function'`, `typeof ytdlDownloadAudio === 'function'`; (b) scan test: walk `src/**/*.ts`, regex `from '(?!\.?\.?/|node:|~)` finds zero bare imports outside `deps.ts` (pins the zero-third-party rule).
- [ ] **Step 3: Run** `node test/run.ts` — expect FAIL.
- [ ] **Step 4: Implement** — `tools/bundle-download-vendor.mjs`: esbuild `--bundle --format=esm --platform=node` over an entry re-exporting the three packages (external: `node:*`), output `src/vendor/download-deps.js`; run it; hand-write `download-deps.d.ts` matching the façade after inspecting each package's real `.d.ts` under `node_modules` (record deviations in the façade file header); write `deps.ts`.
- [ ] **Step 5: Patch `tools/build-exe.mjs`** — after step 1 (tsc) and before asset collection: `cpSync('src/vendor/download-deps.js', 'build/vendor/download-deps.js')` (mkdir first); log the vendor size.
- [ ] **Step 6: Run** `node test/run.ts` — PASS; `npm run typecheck` — exit 0 (d.ts satisfies NodeNext `.js` import).
- [ ] **Step 7: Commit** all of the above + `package.json` + lockfile — `feat: vendor-bundled download dependencies behind a typed facade`

### Task 3: Types + Spotify resolve — `src/core/download/types.ts`, `resolve.ts`

**Files:**
- Create: `src/core/download/types.ts`, `src/core/download/resolve.ts`
- Test: `test/download-resolve.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DownloadRoute = 'spotify-direct' | 'youtube-match';
  export interface TrackMeta { title: string; artists: string; album: string; durationSec: number; coverUrl: string; spotifyId: string }
  export type TrackState = 'queued' | 'downloading' | 'tagging' | 'converting' | 'done' | 'failed' | 'skipped' | 'cancelled';
  export interface ResolvedSource { kind: 'track' | 'album' | 'playlist'; name: string; partial?: boolean; tracks: TrackMeta[] }
  export interface DownloadOpts { destination: string; signal: AbortSignal; timeoutMs: number; onStage?: (s: TrackState) => void }
  export interface DownloadProvider {
    readonly id: DownloadRoute;
    readonly rawExtension: '.ogg' | '.webm' | '.m4a';
    resolve(url: string): Promise<ResolvedSource>;
    download(track: TrackMeta, destBase: string, opts: DownloadOpts): Promise<{ rawPath: string }>;
  }
  export function parseSpotifyUrl(url: string): { kind: 'track' | 'album' | 'playlist'; id: string } | null;
  export async function resolveSource(url: string, client: SpotifyClient | null): Promise<ResolvedSource>;
  export function sanitizeFilename(name: string, maxLength?: number): string;
  ```
- Consumers: Task 4 (provider), Task 6 (queue), Task 7 (API).

- [ ] **Step 1: Write the failing tests** — URL table: `https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC`, same + `?si=abc`, `HTTPS://OPEN.SPOTIFY.COM/TRACK/<id>/`, `spotify:track:<id>`, album/playlist forms → parsed; `https://example.com/track/x`, `https://open.spotify.com/genre/x`, empty → null. Cap: 201-track input → `resolveSource` throws message containing `200` and `拆分播放清單`. Sanitize table: `AC/DC: Back In Black?` → `AC DC Back In Black` (no `/:?`), control chars stripped, 200-char input → ≤120 chars, emoji preserved-but-trimmed, empty result → `"track"`. Meta mapping: fake `SpotifyApiTrack` → `TrackMeta{artists joined ", ", durationSec = ms/1000, coverUrl = first image}`. (resolveSource network paths are exercised through injected client doubles here; the real client is Task 9's smoke script.)
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — `parseSpotifyUrl` regex over both forms; `resolveSource` maps client.getTrack/getAlbum/getPlaylist (playlist slices to 200 AFTER the cap check); R1 fallback: client null OR `getPlaylist` rejects with unsupported-metadata → Spotify public oEmbed `https://open.spotify.com/oembed?url=<url>` via global `fetch` for `{title, thumbnail_url}`, return `{kind, name: title, partial: true, tracks: []}` — callers treat partial as "degraded, UI must warn".
- [ ] **Step 4: Run** — PASS; typecheck exit 0.
- [ ] **Step 5: Commit** — `feat: spotify url parsing, metadata resolve, filename sanitizing`

### Task 4: Route B provider — `providers/youtubeMatch.ts`

**Files:**
- Create: `src/core/download/providers/youtubeMatch.ts`
- Test: `test/youtube-match.test.ts`

**Interfaces:**
- Consumes: `deps.searchYtmSongs`, `deps.ytdlDownloadAudio` (injected in tests), types from Task 3.
- Produces: `scoreCandidates(cands: YtmSong[], meta: TrackMeta): Array<{ cand: YtmSong; score: number; passedGate: boolean }>`; `pickCandidate(cands, meta): YtmSong | null`; `createYoutubeMatchProvider(overrides?: { search?, download? }): DownloadProvider`.
- Consumers: Task 6 (via providers registry), Task 9 smoke.

- [ ] **Step 1: Write the failing scoring-table test** (pure, no network) — normalize = lowercase + strip parenthetical qualifiers (`(Official Audio)`, `(Lyrics)`, `(HD)`) + collapse spaces. Cases: candidate within ±3 s passes gate, farther fails; ALL fail gate but best is within 10 s → closest wins; ALL fail gate and best >10 s → null; official/`- Topic` channel beats equal upload (+bonus constant); token-overlap tiebreak (`Neon Lights Live` loses to `Neon Lights` for meta `Neon Lights`); best score below `CONFIDENCE_FLOOR` → null (`no-confident-match`). Pin `CONFIDENCE_FLOOR` as an exported constant chosen by this table (state the value in a comment once tests pass).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** scoring + provider: query = `"<artists> <title>"`; download = `ytdlDownloadAudio(videoId, destBase)` then rename/choose `.webm`/`.m4a` per returned container → `{ rawPath }`; honor `opts.signal` (abort rejects) and `opts.timeoutMs` (provider-level guard is Task 6's job; provider only propagates abort).
- [ ] **Step 4: Run** — PASS; typecheck 0.
- [ ] **Step 5: Commit** — `feat: youtube-match provider with scored song selection`

### Task 5: Tagger + stream-tag fix — `tagger.ts`, `tags.ts`, `probe.ts`

**Files:**
- Create: `src/core/download/tagger.ts`
- Modify: `src/core/types.ts:11` (`StreamInfo` gains `tags?: Record<string, string>`), `src/core/probe.ts` (populate stream tags from ffprobe), `src/core/tags.ts:60` (`readTags` merges format + stream tags, format wins per field)
- Test: `test/download-tagger.test.ts`

**Interfaces:**
- Produces: `writeTags(rawPath: string, meta: TrackMeta, opts: { ffmpeg: string; trackNumber?: number; coverPath?: string | null; timeoutMs?: number }): Promise<string>` (returns the tagged path); `fetchCover(coverUrl: string, dir: string, timeoutMs?: number): Promise<string | null>`; `CONTAINER_SUPPORT = { '.mp3': {cover:true}, '.m4a': {cover:true}, '.ogg': {cover:false}, '.webm': {cover:false} }`.
- Consumers: Task 6.

- [ ] **Step 1: Write the failing tests** (real ffmpeg via `findBinaries()`-style discovery — reuse the helper existing suites use) — (a) generate 1 s sine `.m4a` + red 300×300 `.jpg` (both via ffmpeg lavfi), run `writeTags` with cover → ffprobe asserts `attached_pic=1` + stream/format tag `title` equals meta.title (m4a: format-level); (b) same on `.mp3` → attached_pic + `-id3v2_version 3` readable; (c) same on `.ogg` → tags present at **stream** level, no picture stream, exit 0; (d) **readTags regression**: probe the tagged `.ogg` and assert `readTags(info).title === meta.title` (this pins the stream-tags merge — fails before the tags.ts/probe.ts change); (e) `fetchCover` with a `file://`-less bogus URL → null, no throw.
- [ ] **Step 2: Run** — (a)(b)(c)(e) fail on missing module; (d) fails on un-merged readTags.
- [ ] **Step 3: Implement** — arg tables straight from the planning-time probe: mp3/m4a = `-i raw -i cover -map 0:a -map 1 -c copy -map_metadata -1 -metadata … -id3v2_version 3 (mp3 only) -disposition:v attached_pic`; ogg/webm = `-i raw -c copy -map_metadata -1 -metadata …` (no cover input); run through `runFfmpeg` with `timeoutMs` (default 60 s) from `src/core/ffbin.ts`; `fetchCover` uses global fetch → temp `<dir>/cover-<n>.jpg`.
- [ ] **Step 4: Run** full suite — PASS; typecheck 0.
- [ ] **Step 5: Commit** — `feat: download tagger (per-container tags+cover) and stream-level tag reading`

### Task 6: The queue — `src/core/download/queue.ts`

**Files:**
- Create: `src/core/download/queue.ts`
- Test: `test/download-queue.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5 + `runBatch` (`src/core/batch.ts:702`, `includePaths` at `:69`) + `defaultConcurrency` for nothing (queue has its own cap of 2).
- Produces:
  ```ts
  export interface TrackEntry { index: number; meta: TrackMeta; state: TrackState; reason?: string; rawPath?: string; outputPath?: string; rawKbps?: number }
  export interface DownloadRecord { id: string; route: DownloadRoute; destination: string; sourceName: string; preset: ExportPreset; createdAt: string; tracks: TrackEntry[]; finished: boolean }
  export interface QueueDeps { providers: Record<DownloadRoute, DownloadProvider>; ffmpeg: string; ffprobe: string; scratch: string; jitterMs?: [number, number]; trackTimeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
  export interface DownloadQueue {
    start(source: ResolvedSource, route: DownloadRoute, destination: string, preset: ExportPreset, trackIndices?: number[]): string;
    get(id: string): DownloadRecord | null;
    list(): DownloadRecord[];
    cancel(id: string, trackIndices?: number[]): boolean;
    retry(id: string, trackIndices: number[]): boolean;
  }
  export function createDownloadQueue(deps: QueueDeps): DownloadQueue;
  ```
  Failure reasons (machine constants): `cookie-expired`, `no-confident-match`, `timeout`, `cancelled`, `rate-limit`, `io-error`.
- Consumers: Task 7 wires it with real providers; Task 8 renders it.

- [ ] **Step 1: Write the failing tests** (scripted mock providers + injected `sleep`/`now`; one real-engine integration) —
  (a) concurrency never exceeds 2 (mock tracks in-flight count, peak ≤ 2 over 5 tracks); (b) jitter called between starts with value within `[500,1500]` (via injected sleep recorder); (c) hanging provider + `trackTimeoutMs: 200` → track fails `timeout`, queue continues to next track; (d) cancel mid-flight → track `cancelled`, its partial file deleted (mock writes a partial file then blocks; assert gone); (e) skip-if-exists: pre-create `<dest>/Art - Title.ogg` size 2048 → state `skipped`; size 500 → downloads; (f) retry(downloadId, [i]) re-queues only failed indices; (g) provider error `CookieExpiredError` (provider rejects with reason `cookie-expired`) → remaining queued tracks fail fast with the same reason, in-flight one finishes; (h) filenames: 3 tracks with hostile titles → files at `<destination>/<sanitized artists> - <sanitized title>.ogg`; (i) **conversion flush integration** (real ffmpeg): 2 tracks of 1 s sine raw from a scripted provider → after both tag, ONE `runBatch` call with `includePaths` = both raws, `outputDir` = destination, `preset` passed through; final states `done`, outputs exist, `readTags(output).title` survives (Task 5 fix at work); states observed pass through `converting`; (j) `no-confident-match` failure does not stop other tracks.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — worker loop with a 2-slot semaphore; per-track `AbortController` + `Promise.race` timeout (5 min default) settled the same way the ffmpeg timeout fix works; rate-limit: provider rejection reason `rate-limit` → global 30 s pause (injected sleep), retry that track once, then fail; conversion = **single flush**: when every non-terminal track has finished tagging (or the last in-flight track settles), one `runBatch` over all tagged raws; map report items back to tracks by `sourcePath` → `done`/`failed` + set `outputPath`; record each track's `rawKbps` from the conversion scan probe so the UI can report the actual delivered bitrate (spec: report, never promise); `finished=true` when no track is queued/downloading/tagging/converting.
- [ ] **Step 4: Run** — PASS; typecheck 0.
- [ ] **Step 5: Commit** — `feat: download queue with bounded concurrency, timeout, cancel, retry, batched conversion`

### Task 7: Server API — 7 routes in `src/server/index.ts`

**Files:**
- Modify: `src/server/index.ts` (new if-blocks after the `/api/denoise` block at `:782-806`, before the Static UI guard at `:808`; imports near `:29`)
- Test: `test/download-api.test.ts`

**Interfaces:**
- Consumes: `createDownloadQueue` (Task 6), `readDownloadSettings/writeDownloadSettings/maskCookie` (Task 1), `resolveSource/parseSpotifyUrl` (Task 3), `createYoutubeMatchProvider` (Task 4).
- Produces: `src/core/download/providers/spotifyDirect.ts` with `createSpotifyDirectProvider(): DownloadProvider` — thin node-spdl client wrapper: lazily `createSpotifyClient(settings.spotifyCookie)` (one client reused across the queue), `download()` streams to `destBase + '.ogg'`, rejects `{reason:'cookie-expired'}` when the cookie is unset or client auth fails; `.ogg` extension; cover handled by the tagger. Plus `src/server/download-runtime.ts` owning the singleton queue + deps and exporting `setDownloadOverridesForTests({resolve?, providers?})` (test-only; server imports from it).
- Produces (wire contract, all via existing `send()`/`readBody()`):
  | Route | In | Out |
  |---|---|---|
  | `POST /api/download/resolve` | `{url}` | 200 `{ok, source: ResolvedSource}`; 400 unparseable; 502 upstream failure |
  | `POST /api/download/start` | `{source, route, destination, preset, trackIndices?}` | 202 `{ok, downloadId}` (idempotent: same source+destination while active → same id); 400 missing destination / unknown route / missing preset |
  | `GET /api/download/status?downloadId=` | — | 200 `{ok, download: DownloadRecord}` with per-track `state`/`reason`; 404 unknown |
  | `POST /api/download/cancel` | `{downloadId}` | `{ok}` |
  | `POST /api/download/retry` | `{downloadId, trackIndices}` | `{ok}` |
  | `GET /api/download/settings` | — | `{ok, spotifyCookieSet, cookieHint, destination}` — never the cookie |
  | `PUT /api/download/settings` | `{spotifyCookie?, destination?}` | `{ok}`; cookie validated shape-only `/^sp_dc=[A-Za-z0-9_%-]+$/` |
  Destination default when body omits it: `<settings.destination ?? null>`; if still null → 400 with message telling the user to pick a folder. Test-only hook: `setDownloadOverridesForTests({resolve?, providers?})` exported from a new `src/server/download-runtime.ts` that owns the singleton queue + deps (server imports from it; tests reset it).
- Consumers: Task 8.

- [ ] **Step 1: Write the failing tests** (`startServer({port: 0})` + `fetch`, house style of `test/api-pick.test.ts`) — resolve 400 on `not-a-url`; resolve 200 via injected override returning a 2-track source; start → 202 `{downloadId}`; **idempotent start**: repeat with same source+destination → SAME id; status 404 for `nope`; status shows states advancing (override provider writes real 1 s files, real queue); cancel → terminal states; settings GET on fresh state → `{spotifyCookieSet:false}` and PUT `{spotifyCookie:"sp_dc=abcdef123456"}` → GET shows `spotifyCookieSet:true`, `cookieHint:"sp_dc=****3456"`, and a sweep asserting the string `sp_dc=abcdef123456` appears in NO response body of any endpoint; start with missing destination → 400 with zh-TW message.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** routes + `src/server/download-runtime.ts` + `providers/spotifyDirect.ts`; queue deps use the server's `bins.ffmpeg/bins.ffprobe/scratchRoot` (already in handler scope); settings PUT persists via Task 1.
- [ ] **Step 4: Run** — PASS; both typechecks 0.
- [ ] **Step 5: Commit** — `feat: download HTTP API (resolve/start/status/cancel/retry/settings)`

### Task 8: Web UI — 下載 tab

**Files:**
- Modify: `web/src/store.ts:89` (tab union gains `'download'`), `web/src/App.tsx` (nav button after USB 轉換 at `:662-667`; render `<DownloadTab />` when active in the body at `:716`), `web/src/api-types.ts`, `web/src/api.ts` (methods on `export const api` at `:175`, using the existing `request<T>` helper at `:149`)
- Create: `web/src/components/DownloadTab.tsx`, `web/src/download-helpers.ts`
- Test: `test/download-web-api.test.ts`

**Interfaces:**
- Consumes: Task 7 wire contract.
- Produces: `api.resolveDownload(url)`, `api.startDownload(source, route, destination, preset, trackIndices?)`, `api.downloadStatus(downloadId)`, `api.cancelDownload(downloadId)`, `api.retryDownload(downloadId, trackIndices)`, `api.getDownloadSettings()`, `api.putDownloadSettings(patch)` + matching `api-types.ts` interfaces mirroring Task 7's table; `download-helpers.ts` pure functions: `statusPill(state): string` (zh-TW label per state), `countByState(tracks): Record<TrackState, number>`, `defaultDestinationFor(workingFolder: string, sourceName: string): string` (workingFolder + `\Downloads\` + sanitized source name), `looksLikeSpotifyUrl(url): boolean` (client-side pre-check mirroring Task 3 acceptance, used to disable 解析).
- Consumers: none downstream.

- [ ] **Step 1: Write the failing test** (node-only, house style — fetchSpy like `test/api-pick.test.ts`) — each api method hits its exact URL/method/body; `defaultDestinationFor('E:\\USB', 'Top Hits 2026')` → `E:\\USB\\Downloads\\Top Hits 2026`; `statusPill('failed')` → contains `失敗`; `looksLikeSpotifyUrl` mirrors the Task 3 table (accepts `spotify:` URIs, rejects example.com).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — api-types + api methods + helpers, then `DownloadTab.tsx` sections in spec order (URL+解析 → resolved header → route radio with 路線 B 預設 and the ToS warning line for 路線 A → destination row with 變更 (native picker via `api.pick({mode:'folder'})`) → track checkboxes + 全選 → 開始下載 → progress table with per-track state pills + failure reasons + 來源位元率 (`rawKbps`, shown as 「來源 NNN kbps」 when present) + per-track/batch 重試 + 取消 → settings row: paste-only cookie input (value never rendered back after save) + destination). Polling: 1 s `downloadStatus` while a download is active (same rhythm as USB job polling); 完成後 button 跳到 USB 分頁 (`dispatch({type:'tab', tab:'usb'})`). Partial-resolved sources show the warning banner.
- [ ] **Step 4: Run** — PASS; `cd web && npm run typecheck` exit 0; `cd web && npx vite build` succeeds.
- [ ] **Step 5: Commit** — `feat: download tab UI (resolve, routes, progress, settings)`

### Task 9: Route A provider completion, packaging verification, smoke script (R4/R5)

**Files:**
- Create: `tools/smoke-download.mjs`
- Modify: `tools/build-desktop-release.mjs` (acceptance step), `docs/download-maintenance.md`
- Test: `test/download-packaging.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `tools/smoke-download.mjs [--route a|b] [--url <spotify-url>]` — manual real-network script: resolve → start against a temp destination → wait for `finished` → print per-track states + verify results; exits non-zero on any failure. Used before releases ONLY (spec: never CI).

- [ ] **Step 1: Write the failing packaging test** — after `tools/build-exe.mjs --no-tools --out <tmp>`: byte-search the produced exe for (a) `download-deps` marker string present in the vendor bundle (pick a stable literal from `src/vendor/download-deps.js` at test time), (b) the web bundle hash file list unchanged. Skip gracefully (with a loud note) when the exe was not built — the full build runs in the release step, not per test-suite run.
- [ ] **Step 2: Run** — FAIL or SKIP.
- [ ] **Step 3: Implement** — `build-desktop-release.mjs` gains an acceptance line byte-searching the released exe for the same markers (pattern already exists from previous releases); write `tools/smoke-download.mjs`; write `docs/download-maintenance.md` documenting the R5 bump procedure: `npm i --save-exact <pkg>@<newer>` → re-run `node tools/bundle-download-vendor.mjs` → `node test/run.ts` → run smoke script route B → commit vendor + lockfile together.
- [ ] **Step 4: Run** — suite PASS; `node tools/build-desktop-release.mjs` completes; the byte-search acceptance reports FOUND for all markers.
- [ ] **Step 5: Commit** — `feat: packaging acceptance + manual download smoke script + bump docs`

## Out of scope (v0.3, per spec Non-goals)

Other platforms beyond the `DownloadProvider` seam; lossless Spotify; queue persistence across restarts; lyrics/video; chunked mid-run conversion flushes (single flush is the v0.3 contract).
