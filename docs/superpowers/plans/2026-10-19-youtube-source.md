# YouTube Source — Implementation Plan

> **For agentic workers:** Steps use `- [ ]`. Each step is one action with a
> checkable result. Do not batch steps. Run the command, read the output, then
> continue. Never commit before `npm run typecheck` exits 0.

**Goal:** Let the user paste a YouTube URL (single video, playlist, or album) and
download it into the same tagging + USB conversion pipeline the Spotify routes
already feed — and repair `youtube-match`, which is currently broken because its
two vendored libraries no longer work.

**Architecture:** `yt-dlp.exe` is a shipped binary, handled exactly like ffmpeg:
located by a lookup chain, spawned with file-backed stdio only, exchanged with
through files. Our own code never parses YouTube's API. The previous design — a
hand-written InnerTube client — was measured against the live service and
abandoned: it resolved 1 of 10 videos.

**Tech Stack:** TypeScript (Node >= 22.6, NodeNext ESM, no build step), the
existing `node test/run.ts` runner, `yt-dlp` 2026.08.19 as a shipped `.exe`, the
existing vendor bundle for the Spotify path only.

**Spec:** `docs/superpowers/specs/2026-10-19-youtube-source-design.md` (approved,
commit `0828e4d`). It supersedes the "Other platforms" non-goal in
`docs/superpowers/specs/2026-10-18-cross-platform-download-design.md`.

## Global Constraints

- Tests run with **`node test/run.ts`** (auto-discovers `test/*.test.ts`).
  `node --test` is forbidden — it needs child processes this sandbox denies.
- Typecheck: `npm run typecheck` at the root **and** `cd web && npm run typecheck`.
  Both must be exit 0 before any commit.
- **Never pipe a child's stdio.** Every child is spawned with
  `stdio: ['ignore', 'ignore', <fd>]` where `<fd>` is a file the caller opened,
  or `stdio: 'ignore'`. This is measured fact in this repo (`src/core/ffbin.ts:4-9`),
  not style.
- **No test invokes `yt-dlp`.** It cannot run under this sandbox (PyInstaller
  self-extraction is blocked). All tests inject a `runYtDlp` double.
- Real-network checks are **manual only**, never in CI.
- All user-facing copy is Traditional Chinese.
- Dev ffmpeg/ffprobe: `C:\ffmpeg-8.1-full_build\bin\`.
- `src/` may import third-party packages **only** through
  `src/core/download/deps.ts`. New files in `src/core/ytdlp.ts` and
  `src/core/download/parse.ts` use Node builtins and global `fetch` only.
- Removing `@distube/ytdl-core` and `@tnfangel/ytmusic-api` is in scope. Adding
  any npm package is **not**.
- Pinned yt-dlp artifact: `2026.08.19`, 17,840,399 bytes, sha256
  `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`.
- Queue numbers are unchanged: concurrency 2, jitter 500–1500 ms, per-track
  timeout 5 min, rate-limit backoff 30 s retry once, skip-if-exists > 1 KB,
  200-track cap, ID3v2.3.

## Review Focus

Five failure modes the spec implies but no task's happy-path test would catch.
Each gets a test in the owning task; a plan is not done until all five exist.

1. **Absent row fields** (Task 5) — a `--print-to-file` row with an empty
   `duration`, an empty `uploader` *and* `channel`, or `thumbnails` as `[]` must
   produce `durationSec: 0`, a non-empty `artists` fallback, and `coverUrl: ''` —
   never the string `"undefined"` in a filename.
2. **Exit 0 with zero rows** (Task 5) — an empty or fully-unavailable playlist
   returns exit 0 and an empty file. That must be a 400 with a readable message,
   never a silent "success" that starts a download of nothing.
3. **Stale stderr log** (Task 1) — the report file must be created fresh per
   invocation; a dirty log from a previous run must not be read as this run's
   failure reason.
4. **Extension-bearing partials + sub-1 KB stubs** (Task 6) — yt-dlp's partial is
   `<name>.webm.part`, not `<name>.part`, so cancellation deleting the wrong name
   leaves orphans; and a leftover 500-byte `<name>.webm` must be replaced, not
   treated as done.
5. **Cover art on the m4a fallback (R7)** (Task 6) — yt-dlp reports a `.webp`
   thumbnail and the tagger was built around Spotify's JPEG CDN. Whether the
   embed works is **unestablished**; the task must settle it with a real file and
   either make it work or skip artwork entirely. Emitting a broken tag is not an
   acceptable outcome.

---

### Task 1: The yt-dlp runner

**Files:**
- Create: `src/core/ytdlp.ts`
- Test: `test/ytdlp.test.ts`

**Interfaces:**
- Consumes: `appRoot()` from `src/core/approot.ts`; the spawn/timeout shape of
  `runFfmpeg` in `src/core/ffbin.ts`.
- Produces:

  ```ts
  export const YTDLP_EXE: 'yt-dlp.exe';
  export const YTDLP_DIR_ENV: 'AUS_YTDLP_DIR';
  export const DEFAULT_YTDLP_TIMEOUT_MS: number;   // 10 * 60_000
  export const YTDLP_KILL_GRACE_MS: number;        // 5_000
  export type YtDlpFailureReason =
    | 'ytdlp-missing' | 'video-unavailable' | 'live-unsupported'
    | 'no-audio-format' | 'rate-limit' | 'io-error';

  export function findYtDlp(explicitDir?: string): string;

  export interface RunYtDlpOptions {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }
  export interface RunYtDlpResult {
    code: number;
    timedOut?: boolean;
    cancelled?: boolean;
    stderr: string;          // the report file's contents, always read back
  }
  export function runYtDlp(
    bin: string, args: string[], opts: RunYtDlpOptions,
  ): Promise<RunYtDlpResult>;

  export function classifyYtDlpFailure(
    code: number, stderr: string,
  ): YtDlpFailureReason;
  ```

- `findYtDlp` order: `explicitDir` → `process.env[YTDLP_DIR_ENV]` →
  `appRoot()/bin` → `appRoot()/tools/bin` → PATH. Throws
  `Could not locate yt-dlp.exe.\nRun: node tools/fetch-ytdlp.mjs\nOr set AUS_YTDLP_DIR.`
- `runYtDlp` spawns `spawn(bin, argv, { cwd, stdio: ['ignore', 'ignore', fd], windowsHide: true })`
  where `fd = openSync(reportPath, 'w')` and `reportPath` is a fresh
  `join(cwd, 'ytdlp-report.log')`. It closes the fd and reads the file back on
  close. Timeout: `SIGTERM`, then `SIGKILL` after `YTDLP_KILL_GRACE_MS`, resolving
  with `timedOut: true`. `opts.signal` abort → kill, resolve with `cancelled: true`.
  A spawn `error` event rejects with `Failed to start ${bin}: ${message}`.

- [ ] **Step 1: Write the failing tests.** House pattern is
      `test/ffbin-timeout.test.ts` — use `process.execPath` as the "binary" with
      `-e` scripts, so no real yt-dlp is needed:
      (a) `runYtDlp(process.execPath, ['-e', "process.stderr.write('ERROR: [youtube] x: This video is unavailable'); process.exit(1)"], {cwd: dir})`
      → `code === 1` and `res.stderr` contains `This video is unavailable`;
      (b) same but writing nothing and `process.exit(0)` → `code === 0`, `stderr === ''`;
      (c) `['-e', 'setTimeout(() => {}, 600000)']` with `timeoutMs: 400` →
      `timedOut === true`, `code !== 0`, elapsed < 8000;
      (d) **Review Focus 3**: pre-create a dirty `ytdlp-report.log` in `cwd`
      containing `ERROR: stale failure`, then run the exit-0 script and assert
      `res.stderr === ''` — the file is truncated per run, not appended to;
      (e) `classifyYtDlpFailure` table: `(1, 'ERROR: [youtube] x: This video is unavailable')`
      → `video-unavailable`; `(1, 'ERROR: Sign in to confirm you’re not a bot')`
      → `rate-limit`; `(1, 'ERROR: HTTP Error 429: Too Many Requests')` → `rate-limit`;
      `(1, 'ERROR: This live event will begin in 3 hours')` → `live-unsupported`;
      `(1, 'ERROR: Requested format is not available')` → `no-audio-format`;
      `(1, 'ERROR: something else entirely')` → `io-error`; `(0, '')` → `io-error`;
      (f) `findYtDlp` order: create a real dir with a file named `yt-dlp.exe` and
      assert an explicit dir wins over `AUS_YTDLP_DIR`; assert a dir with no
      `yt-dlp.exe` is skipped; assert the message names `tools/fetch-ytdlp.mjs`.

- [ ] **Step 2: Run `node test/run.ts`** — the new tests FAIL with
      `Cannot find module '../src/core/ytdlp.ts'`. Paste the failure.

- [ ] **Step 3: Implement `src/core/ytdlp.ts`.** Mirror `ffbin.ts`: header comment
      stating the piped-stdio ban and the measured file-descriptor fact, one
      named constant block, no magic strings inline. `classifyYtDlpFailure`
      matches patterns in this order: bot/429 → `rate-limit`; unavailable family
      (`This video is unavailable`, `Video unavailable`, `Private video`,
      `not available in your country`, `age`-restricted, `Premieres`) →
      `video-unavailable`; live family → `live-unsupported`; format family →
      `no-audio-format`; else `io-error`.

- [ ] **Step 4: Run `node test/run.ts` then `npm run typecheck`** — all pass,
      exit 0.

- [ ] **Step 5: Commit** — `feat: yt-dlp runner with file-backed stderr and reason mapping`

---

### Task 2: Fetch the pinned binary

**Files:**
- Create: `tools/fetch-ytdlp.mjs`
- Modify: `tools/bin/.gitignore` (comment only — the existing `*` already covers it),
  `tools/README.md`
- Test: `test/fetch-ytdlp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the same surface as `tools/fetch-deep-filter.mjs` —
  `export const VERSION = '2026.08.19'`, `export const URL`,
  `export const EXPECTED_SIZE = 17840399`, `export const EXPECTED_SHA256`,
  `export function parseArgs(argv)`, and a `main()` guarded by
  `if (import.meta.url === pathToFileURL(process.argv[1]).href)` so tests can
  import the constants without running a download.

  `URL` must be
  `https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe`.
  Exit codes: 2 mkdir, 3 fetch/HTTP, 4 size, 5 sha256, 6 write. Writes
  `${out}.part`, then `rmSync(out)`, then `renameSync`. Prints
  `verify: "<out>" --version` at the end.

- [ ] **Step 1: Write the failing test `test/fetch-ytdlp.test.ts`** —
      `await import('../tools/fetch-ytdlp.mjs')` and assert: `URL` contains
      `VERSION` and ends `/yt-dlp.exe`; `EXPECTED_SHA256` is 64 lowercase hex;
      `EXPECTED_SIZE === 17840399`; `parseArgs(['--out','x.exe'])` returns
      `{out: 'x.exe'}` and defaults to `tools/bin/yt-dlp.exe`; and the text of
      `tools/bin/.gitignore` names `tools/fetch-ytdlp.mjs`. Also assert
      `tools/README.md` mentions the sha256.

- [ ] **Step 2: Run** — FAIL (`Cannot find module '../tools/fetch-ytdlp.mjs'`).

- [ ] **Step 3: Implement** by copying `tools/fetch-deep-filter.mjs` and changing
      the pins. Its header comment already explains why this is a Node script and
      not `curl`/`Invoke-WebRequest` — keep that reasoning verbatim, because it is
      still true here. Add the `yt-dlp.exe` line to `tools/bin/.gitignore`'s
      comment and a `## yt-dlp` section to `tools/README.md` recording the
      release, size and sha256. **The pins are measurements taken 2026-10-19 from
      the real artifact; do not re-derive them from the spec.**

- [ ] **Step 4: Run** — PASS; `npm run typecheck` exit 0. Then, once, for real:
      `node tools/fetch-ytdlp.mjs` and confirm it reports the size and hash match
      (the script downloads 17.8 MB; this is the one network step, run manually).

- [ ] **Step 5: Commit** — `feat: pinned yt-dlp fetch script and binary policy`
      (the `.exe` itself is gitignored — confirm with `git status --porcelain`
      that it is NOT staged).

---

### Task 3: URL parsing

**Files:**
- Create: `src/core/download/parse.ts`
- Test: `test/download-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

  ```ts
  export type Platform = 'spotify' | 'youtube';
  export interface ParsedUrl {
    platform: Platform;
    kind: 'video' | 'playlist';
    id: string;              // YouTube video id, or playlist/album list id
  }
  export function detectPlatform(url: string): Platform | null;
  export function parseYouTubeUrl(url: string): ParsedUrl | null;
  ```

  Accepted, and nothing else (spec table): `www.youtube.com/watch?v=<11>`,
  `youtu.be/<11>`, `music.youtube.com/watch?v=<11>`, `www.youtube.com/shorts/<11>`,
  `(www|music).youtube.com/playlist?list=<id>`, `music.youtube.com/browse/MPREb_…`.
  A `watch?v=…&list=…` URL is `kind: 'video'`. A bare 11-character id is rejected.
  Channel pages, `@handle` URLs and search-result pages are rejected.

- [ ] **Step 1: Write the failing tests** — the accepted table above, each mapping
      to the exact `{platform, kind, id}`; plus rejects: a bare
      `dQw4w9WgXcQ`, `https://www.youtube.com/@RickAstleyYT`, a channel URL,
      `https://www.youtube.com/results?search_query=x`, `example.com`, `''`,
      and `spotify:track:…` (which `detectPlatform` must call `spotify` while
      `parseYouTubeUrl` returns null). Include a `watch` URL carrying both `v` and
      `list` and assert `kind === 'video'`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** with `new URL()` plus an explicit host allowlist and
      an 11-character `[A-Za-z0-9_-]{11}` check for video ids. No regex-only
      parsing; `URL` is what makes `youtu.be` vs `youtube.com` honest.

- [ ] **Step 4: Run** — PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit** — `feat: youtube url parsing and platform detection`

---

### Task 4: Interface moves and the skip-path

**Files:**
- Create: `src/core/download/errors.ts`
- Modify: `src/core/download/types.ts` (`spotifyId` → `sourceId`,
  `rawExtension` → `rawExtensions`, `ResolvedSource.platform`),
  `src/core/download/queue.ts` (skip-path), `src/core/download/resolve.ts`
  (set `platform: 'spotify'`), `src/core/download/providers/youtubeMatch.ts`
  (import `DownloadFailure` from `errors.ts`)
- Test: `test/download-queue.test.ts`, `test/download-resolve.test.ts`,
  `test/download-tagger.test.ts`, `test/youtube-match.test.ts` (mechanical edits)

**Interfaces:**
- Consumes: nothing new.
- Produces:

  ```ts
  // src/core/download/errors.ts
  export class DownloadFailure extends Error {
    readonly reason: string;
    constructor(reason: string, message: string);
  }
  ```

  `TrackMeta.sourceId: string`. `DownloadProvider.rawExtensions:
  readonly ('.ogg' | '.webm' | '.m4a')[]`. `ResolvedSource.platform:
  'spotify' | 'youtube'`. The queue's skip-path at `queue.ts:430` becomes: for
  each `ext` in `provider.rawExtensions`, the candidate
  `join(destination, sanitizeFilename(\`${artists} - ${title}\`) + ext)` is
  checked; the first existing one above `SKIP_ABOVE_BYTES` wins.

- [ ] **Step 1: Write the failing test** — extend `test/download-queue.test.ts`
      with a provider whose `rawExtensions` is `['.webm', '.m4a']`:
      (a) a pre-created 2048-byte `<name>.m4a` → state `skipped`, provider never
      called; (b) a pre-created 500-byte `<name>.webm` → downloads; (c) neither
      present → downloads. Everything else in that suite stays as-is except the
      renames.

- [ ] **Step 2: Run** — FAIL (`rawExtensions` is not a property of the fixture
      provider; `sourceId` not accepted).

- [ ] **Step 3: Implement** the moves. Do the renames with a real search, not by
      hand: `grep -rn "spotifyId\|rawExtension\b" src test web/src`. Every hit is
      either a declaration or must become the new name. `DownloadFailure` moves
      with its body unchanged; `queue.ts:32` changes its import to `../errors.ts`.
      Set `platform: 'spotify'` at every existing `ResolvedSource` return site in
      `resolve.ts`. This task must leave the suite green with **no** YouTube code
      present yet — it is a pure refactor.

- [ ] **Step 4: Run `node test/run.ts` and `npm run typecheck`** — all pass, 0.
      The suite count must go UP by the tests from Step 1 and nothing may be
      skipped.

- [ ] **Step 5: Commit** — `refactor: platform-neutral track ids, multi-extension providers, shared failure type`

---

### Task 5: Resolving a YouTube URL to tracks

**Files:**
- Create: `src/core/download/sources/youtube.ts`
- Modify: `src/core/download/resolve.ts` (add a `resolveAnySource` dispatcher that
  routes on `detectPlatform`)
- Test: `test/youtube-source.test.ts`

**Interfaces:**
- Consumes: `runYtDlp`/`classifyYtDlpFailure`/`RunYtDlpResult` (Task 1),
  `detectPlatform`/`parseYouTubeUrl` (Task 3), `DownloadFailure` plus the
  `sourceId` and `platform` fields (Task 4), `sanitizeFilename`/`PLAYLIST_CAP`
  from `src/core/download/resolve.ts`.
- Produces:

  ```ts
  export type YtDlpRunner = (args: string[], opts: {cwd: string}) => Promise<RunYtDlpResult>;

  export interface YouTubeResolveDeps {
    bin: string;
    scratch: string;
    run?: YtDlpRunner;             // injected by tests
  }
  export function resolveYouTubeSource(
    url: string, deps: YouTubeResolveDeps,
  ): Promise<ResolvedSource>;

  // src/core/download/resolve.ts
  export function resolveAnySource(
    url: string, client: SpotifyClient | null, deps: YouTubeResolveDeps,
  ): Promise<ResolvedSource>;
  ```

  Invocation, exactly:

  ```
  <bin> --flat-playlist --simulate --no-warnings
        --print-to-file "<id>\t<title>\t<uploader>\t<duration>\t<thumbnails>j" <out.tsv> <url>
  ```

  where `<out.tsv>` is a fresh path under `deps.scratch`. Row → `TrackMeta`:
  `title → title`; `uploader || channel || 'YouTube'` → `artists`;
  `album → ''`; `duration → durationSec` (`0` when absent/non-numeric);
  `thumbnails` parsed as JSON, last entry's `url` → `coverUrl` (`''` on empty or
  malformed); `id → sourceId`. Returns
  `{platform: 'youtube', kind: 'video'|'playlist', name, tracks}`.
  Over `PLAYLIST_CAP` rows → the existing `PlaylistTooLargeError` copy.
  An unrecognised URL throws `DownloadFailure('unsupported-url', …)`, which
  Task 9 maps to a 400.

- [ ] **Step 1: Write the failing tests** with an injected `run` that writes a
      fixture TSV and returns a chosen exit code:
      (a) an 11-row album fixture → 11 tracks, first `title`/`artists`/`durationSec`
      matching, `coverUrl` taken from the last thumbnail,
      `platform === 'youtube'`;
      (b) **Review Focus 1**: a row with `\t\t` in the duration column and no
      uploader → `durationSec === 0`, `artists === 'YouTube'`, and
      `sanitizeFilename(\`${artists} - ${title}\`)` contains no `undefined`;
      a row with `thumbnails` = `[]` → `coverUrl === ''`; a row with a truncated
      `thumbnails` value → `coverUrl === ''` and no throw;
      (c) **Review Focus 2**: exit 0 with a zero-byte TSV → rejects with a
      `DownloadFailure` carrying a zh-TW message containing `沒有可下載的曲目`;
      (d) exit 1 with `ERROR: [youtube] x: This video is unavailable` →
      rejects with reason `video-unavailable`;
      (e) 201 fixture rows → `PlaylistTooLargeError`, message contains `200` and
      `拆分播放清單`;
      (f) the command actually built contains `--print-to-file`, `--flat-playlist`
      and `--simulate`, and does **not** contain `-J` — assert on the args array
      the injected runner received;
      (g) `resolveAnySource` sends a Spotify URL to the Spotify path and a YouTube
      URL to `resolveYouTubeSource`, and throws `unsupported-url` for
      `example.com`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Read the TSV with `readFileSync(..., 'utf8').split('\n')`,
      drop empty lines, and split on `\t` with a defensive length check — never
      assume five columns. Parse the thumbnails column with `JSON.parse` inside a
      `try`, treating any failure as `''`.

- [ ] **Step 4: Run** — PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit** — `feat: resolve youtube urls through yt-dlp print-to-file`

---

### Task 6: `youtube-direct`

**Files:**
- Create: `src/core/download/providers/youtubeDirect.ts`
- Modify: `src/core/download/types.ts` (`DownloadRoute` gains `'youtube-direct'`),
  all `QueueDeps.providers` construction sites
- Test: `test/youtube-direct.test.ts`

**Interfaces:**
- Consumes: `resolveYouTubeSource` and `YtDlpRunner` (Task 5),
  `runYtDlp`/`findYtDlp` (Task 1), `DownloadFailure` (Task 4).
- Produces:

  ```ts
  export interface YoutubeDirectDeps {
    bin: string; scratch: string;
    run?: YtDlpRunner;
    find?: (explicit?: string) => string;
  }
  export function createYoutubeDirectProvider(deps: YoutubeDirectDeps): DownloadProvider;
  ```

  `id: 'youtube-direct'`, `rawExtensions: ['.webm', '.m4a']`.
  `download()` runs

  ```
  <bin> -f bestaudio/best --no-playlist --force-overwrites
        -o "<destBase>.%(ext)s" -- <sourceId>
  ```

  then finds the landed file by scanning `dirname(destBase)` for
  `basename(destBase)` + any of `.webm`, `.m4a`, `.ogg`, `.mp4`, `.mkv`,
  returning `{rawPath}`. No `--write-info-json`.

- [ ] **Step 1: Write the failing tests** with an injected `run`:
      (a) the args array contains `--force-overwrites`, `-f bestaudio/best`,
      `--no-playlist`, and does **not** contain `--write-info-json`;
      (b) the fake runner writes `<destBase>.webm` → `rawPath` points at it;
      (c) **Review Focus 4**: the fake runner writes `<destBase>.webm.part` and
      then the real download is cancelled via `opts.signal` → the provider rejects
      with reason `cancelled` and `<destBase>.webm.part` no longer exists;
      (d) **Review Focus 4**: a pre-existing 500-byte `<destBase>.webm` plus a
      fake runner that writes a 3000-byte replacement → `rawPath` is that file and
      its size is 3000 (i.e. the flag's behaviour is relied on, not the stub);
      (e) exit 1 with an unavailable message → rejects with reason
      `video-unavailable`;
      (f) a `find()` that throws → rejects with reason `ytdlp-missing` and the
      message names `tools/fetch-ytdlp.mjs`;
      (g) multiple candidate extensions present → picks the newest, and the choice
      is asserted explicitly.

- [ ] **Step 2: Run** — FAIL (the new test cannot resolve
      `providers/youtubeDirect.ts`).

- [ ] **Step 3: Implement.** Widen `DownloadRoute` to three members. That
      immediately breaks every `Record<DownloadRoute, DownloadProvider>` — the
      compiler names each one. **Fix each site; never widen the type to
      `Partial`.** At minimum that is `test/download-queue.test.ts`'s `stubDeps`
      and, later, Task 9's real deps. The provider
      must not import `src/core/ytdlp.ts` at module scope if that would pull the
      filesystem lookup into tests — take `bin`/`find` as injected deps with real
      defaults resolved lazily inside `download()`.

- [ ] **Step 4: Run** — PASS; both typechecks exit 0.

- [ ] **Step 5: Commit** — `feat: youtube-direct provider with force-overwrite and partial cleanup`

---

### Task 7: Repair `youtube-match` onto yt-dlp (R8)

**Files:**
- Modify: `src/core/download/providers/youtubeMatch.ts`,
  `src/core/download/sources/youtube.ts` (add `searchYouTubeRows`)
- Test: `test/youtube-match.test.ts`

**Interfaces:**
- Consumes: Task 5's runner plumbing and `YtDlpRunner`, Task 6's download command.
- Produces: `searchYouTubeRows(query: string, deps): Promise<YouTubeSongRow[]>` in
  `sources/youtube.ts`, running the **same** `--print-to-file` invocation with
  `ytsearch5:<query>` as the URL, mapping `id → videoId`, `uploader || channel →
  artistName`, `'' → albumName` (search rows carry no album), `duration →
  durationSec`, last thumbnail → `thumbnailUrl`. `YouTubeSongRow` **moves into
  `sources/youtube.ts`** — it must no longer be imported from the vendor
  declarations (Task 8 deletes them). `youtubeMatch.ts`'s scoring, duration gate,
  `pickCandidate` and `no-confident-match` behaviour are **not touched**; only its
  two I/O calls and its import path change. `rawExtension: '.webm'` becomes
  `rawExtensions: ['.webm', '.m4a']`.

- [ ] **Step 1: Write the failing tests** — keep every existing scoring test
      byte-identical except the import path and the `sourceId` rename. Add:
      (a) `searchYouTubeRows` maps a 5-row fixture TSV to five `YouTubeSongRow`s
      with `albumName === ''` and a numeric `durationSec`;
      (b) a row with no uploader → `artistName === 'YouTube'`;
      (c) the provider's download call is the same command Task 6 asserts.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** The `search` default becomes
      `(query) => searchYouTubeRows(query, {bin, scratch})`, with `bin`/`scratch`
      added to `createYoutubeMatchProvider`'s options object (defaults resolved
      lazily, as in Task 6). Keep the `overrides` parameter shape so the existing
      tests' injection still works.

- [ ] **Step 4: Run** — PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Manual re-validation (R8) — do not skip, do not automate.**
      Run the real search for five known tracks and compare the resolved
      candidates' scores against `CONFIDENCE_FLOOR`. Record the observed scores
      and the verdict (floor stays, or the new value and why) in the commit
      message. This is the one step where a green suite is not evidence.

- [ ] **Step 6: Commit** — `fix: youtube-match on yt-dlp search, floor re-validated (R8)`

---

### Task 8: Remove the two dead libraries

**Files:**
- Modify: `tools/vendor/download-entry.ts` (delete the whole YouTube section,
  `:122-195`), `src/vendor/download-deps.d.ts` (delete the YouTube declarations),
  `src/core/download/deps.ts` (delete the four YouTube re-exports),
  `package.json` (remove `@distube/ytdl-core`, `@tnfangel/ytmusic-api`)
- Regenerate: `src/vendor/download-deps.js`
- Test: `test/download-deps.test.ts`

**Interfaces:**
- Consumes: Task 7 (which removed the last consumers).
- Produces: a façade whose only exports are the Spotify surface
  (`Spotify`, `downloadTrackStream`, `SPDL_FORMATS`, the five error classes,
  `SpotifyUserSub`) plus `createSpotifyClient`. `YouTubeSongRow` is gone from both
  the `.d.ts` and `deps.ts`.

- [ ] **Step 1: Write the failing test** — re-pin
      `test/download-deps.test.ts`: the surface test asserts only the Spotify
      exports; a new assertion walks `src/**/*.ts` and fails if any file imports
      `YouTubeSongRow` from `vendor/download-deps.js` or calls
      `searchYouTubeMusic`/`getYouTubeAudio`/`getYouTubeStream`/`getYouTubeInfo`.
      The static-import scan keeps its `node:builtin` allowlist and its
      `re-unplayplay` whitelist unchanged.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement the removals**, then regenerate the bundle. **The
      esbuild CLI works from PowerShell; the JS API does not** (`spawn EPERM`).
      Two measured constraints: pass a **relative** `--outfile`, and an
      **absolute** `--alias` path. Run it as the script
      `tools/bundle-download-vendor.mjs` already does — that script spawns its own
      child, so run it via `node tools/bundle-download-vendor.mjs` and if it fails
      with `EPERM`, use the CLI form directly:

      ```
      node_modules\@esbuild\win32-x64\esbuild.exe tools/vendor/download-entry.ts ^
        --bundle --platform=node --format=esm --target=node22 ^
        --external:re-unplayplay ^
        --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" ^
        --alias:supports-color=<ABSOLUTE path to tools\vendor\stubs\supports-color.cjs> ^
        --outfile=src/vendor/download-deps.js
      ```

      Then remove both packages with `npm uninstall @distube/ytdl-core @tnfangel/ytmusic-api --cache .npm-cache`
      (the `--cache` flag is required — npm's default cache is outside the sandbox).

- [ ] **Step 4: Run `node test/run.ts` and `npm run typecheck`** — all pass, 0.
      Confirm the bundle shrank substantially and that `git diff --stat` shows the
      regenerated `src/vendor/download-deps.js`.

- [ ] **Step 5: Commit** — `chore: drop the broken ytdl-core and ytmusic-api from the vendor bundle`

---

### Task 9: Server API — 7 routes

**Files:**
- Modify: `src/server/index.ts` (new if-blocks after the `/api/denoise` block at
  `:782-806`, before the Static UI guard at `:808`; imports near `:29`)
- Create: `src/server/download-runtime.ts`,
  `src/core/download/providers/spotifyDirect.ts`
- Test: `test/download-api.test.ts`

**Interfaces:**
- Consumes: `createDownloadQueue` (queue), `readDownloadSettings`/`writeDownloadSettings`/`maskCookie`
  (appsettings), `resolveSource`/`resolveAnySource` (Tasks 4–5),
  `createYoutubeMatchProvider` (Task 7), `createYoutubeDirectProvider` (Task 6).
- Produces: `createSpotifyDirectProvider(): DownloadProvider` — lazily
  `createSpotifyClient(settings.spotifyCookie)`, one client reused, rejects
  `{reason: 'cookie-expired'}` when the cookie is unset or auth fails, `.ogg`.
  `src/server/download-runtime.ts` owns the singleton queue + deps and exports
  `setDownloadOverridesForTests({resolve?, providers?})`.
  Routes:

  | Route | In | Out |
  |---|---|---|
  | `POST /api/download/resolve` | `{url}` | 200 `{ok, source: ResolvedSource}`; 400 unparseable; 502 upstream |
  | `POST /api/download/start` | `{source, route, destination, preset, trackIndices?}` | 202 `{ok, downloadId}` (idempotent while active); 400 missing destination / unknown route / missing preset |
  | `GET /api/download/status?downloadId=` | — | 200 `{ok, download}`; 404 unknown |
  | `POST /api/download/cancel` | `{downloadId}` | `{ok}` |
  | `POST /api/download/retry` | `{downloadId, trackIndices}` | `{ok}` |
  | `GET /api/download/settings` | — | `{ok, spotifyCookieSet, cookieHint, destination}` — never the cookie |
  | `PUT /api/download/settings` | `{spotifyCookie?, destination?}` | `{ok}`; shape-only `/^sp_dc=[A-Za-z0-9_%-]+$/` |

  `resolve` dispatches on `detectPlatform`: Spotify → the `v1` path as today;
  YouTube → `resolveYouTubeSource`. When the platform is YouTube the response's
  `route` is forced to `youtube-direct` regardless of what the client sent.

- [ ] **Step 1: Write the failing tests** (`startServer({port: 0})` + `fetch`, the
      house style of `test/api-pick.test.ts`) — resolve 400 on `not-a-url`; resolve
      200 via an injected override returning a 2-track source; start → 202;
      **idempotent start** → same id; status 404 for `nope`; status advances
      through states with a real queue and a 1-second file provider; cancel →
      terminal; settings GET fresh → `{spotifyCookieSet: false}`, PUT
      `{spotifyCookie: 'sp_dc=abcdef123456'}` → GET shows `spotifyCookieSet: true`
      and `cookieHint: 'sp_dc=****3456'`, plus a sweep asserting the literal
      `sp_dc=abcdef123456` appears in **no** response body of any endpoint; a
      YouTube URL resolve with an injected source returns `platform: 'youtube'`
      and a `route` of `youtube-direct` even when the request asks for
      `spotify-direct`; missing destination → 400 with a zh-TW message.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** the routes, the runtime and `spotifyDirect`. Queue deps
      use the server's existing `bins.ffmpeg`/`bins.ffprobe`/`scratchRoot` and
      `findYtDlp()` for the YouTube providers; a `findYtDlp` throw must surface as
      an `ytdlp-missing` reason on the affected tracks, not as a 500.

- [ ] **Step 4: Run** — PASS; both typechecks exit 0.

- [ ] **Step 5: Commit** — `feat: download HTTP API (resolve/start/status/cancel/retry/settings)`

---

### Task 10: Web UI — 下載 tab

**Files:**
- Modify: `web/src/store.ts:89` (tab union gains `'download'`),
  `web/src/App.tsx` (nav button after USB 轉換 at `:662-667`; render
  `<DownloadTab />` in the body at `:716`), `web/src/api-types.ts`,
  `web/src/api.ts` (methods on `export const api` at `:175`, via `request<T>` at
  `:149`)
- Create: `web/src/components/DownloadTab.tsx`, `web/src/download-helpers.ts`
- Test: `test/download-web-api.test.ts`

**Interfaces:**
- Consumes: Task 9's wire contract.
- Produces: `api.resolveDownload`, `api.startDownload`, `api.downloadStatus`,
  `api.cancelDownload`, `api.retryDownload`, `api.getDownloadSettings`,
  `api.putDownloadSettings` + matching `api-types.ts` mirrors; helpers
  `statusPill(state): string`, `countByState(tracks)`,
  `defaultDestinationFor(workingFolder, sourceName)` (workingFolder +
  `\Downloads\` + sanitized name), `looksLikeYoutubeUrl(url): boolean`.

- [ ] **Step 1: Write the failing test** (node-only, fetchSpy style) — each api
      method hits its exact URL/method/body;
      `defaultDestinationFor('E:\\USB', 'Top Hits 2026')` →
      `E:\\USB\\Downloads\\Top Hits 2026`; `statusPill('failed')` contains `失敗`;
      `looksLikeYoutubeUrl` mirrors Task 3's accepted table and rejects
      `example.com`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** api types + methods + helpers, then `DownloadTab.tsx`
      in spec order: URL + 解析 → resolved header → **route radio shown only for
      Spotify sources** (路線 B 預設, ToS warning on 路線 A); a pasted YouTube URL
      selects `youtube-direct` automatically and shows no radio → destination row
      with 變更 via `api.pick({mode:'folder'})` → track checkboxes + 全選 →
      開始下載 → progress table with per-track state pills, failure reasons,
      and 來源位元率 (`rawKbps` as 「來源 NNN kbps」) + per-track/batch 重試 + 取消
      → settings row (paste-only cookie, value never rendered back) + destination.
      Poll `downloadStatus` every 1 s while active; on completion offer a jump to
      the USB tab. Partial sources show the warning banner.
      **Review Focus 5:** do not promise artwork for YouTube sources — the copy
      must say the cover is unavailable on webm rather than showing a placeholder
      that never fills.

- [ ] **Step 4: Run** — PASS; `cd web && npm run typecheck` exit 0;
      `cd web && npx vite build` succeeds.

- [ ] **Step 5: Commit** — `feat: download tab UI (resolve, routes, progress, settings)`

---

### Task 11: Packaging, acceptance and smoke

**Files:**
- Modify: `tools/build-exe.mjs` (step 5 copies `yt-dlp.exe` beside ffmpeg when
  `withTools`), `tools/build-desktop-release.mjs` (acceptance markers),
  `docs/download-maintenance.md` (bump procedure)
- Create: `tools/smoke-download.mjs`
- Test: `test/download-packaging.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `tools/smoke-download.mjs [--route a|b|youtube-direct] [--url <url>]`
  — resolve → start against a temp destination → wait for `finished` → print
  per-track states and verify each output with ffprobe. Exits non-zero on any
  failure. **Manual only, never CI.**

- [ ] **Step 1: Write the failing packaging test** — assert that
      `tools/build-exe.mjs`'s source text copies `yt-dlp.exe` in the `withTools`
      branch, that `tools/bin/.gitignore` still covers it, and that
      `docs/download-maintenance.md` names the three bump steps (change the pinned
      version/size/sha256 → re-run `node tools/fetch-ytdlp.mjs` → run the route
      smoke). Skip the exe byte-search gracefully with a loud note when no build
      exists — the full build runs at release time, not per suite run.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** the build hook, the acceptance line, the maintenance
      doc and the smoke script.

- [ ] **Step 4: Run** — suite PASS; `node tools/build-desktop-release.mjs`
      completes; the acceptance check reports FOUND for `yt-dlp.exe` and a
      hash match, and confirms `unblock-release.mjs` cleared the download tag.

- [ ] **Step 5: Commit** — `feat: package yt-dlp with the desktop release, smoke script and bump docs`

---

## Final verification (the Lead runs this, not a worker)

- [ ] `npm run typecheck` exit 0; `cd web && npm run typecheck` exit 0.
- [ ] `node test/run.ts` — every test passes; record the final count and compare
      it against the pre-plan baseline.
- [ ] `grep -rn "@distube/ytdl-core\|@tnfangel/ytmusic-api" src tools package.json`
      returns nothing.
- [ ] `grep -rn "spotifyId\|rawExtension\b" src test web/src` returns nothing.
- [ ] `git status --porcelain` is clean and `yt-dlp.exe` is not tracked.
- [ ] One manual `tools/smoke-download.mjs --route youtube-direct --url <a real playlist URL>`
      on a machine where `yt-dlp.exe` can execute. **This is the only step that
      proves the shipped binary works** — every automated test mocks it, by
      necessity. Report its result honestly, including a failure.

## Out of scope (per spec Non-goals)

SoundCloud/Bandcamp and any third platform; channel, `@handle` and search-result
URLs; `watch?v=…&list=…` as a playlist; PO tokens, `cipher` decryption, `BgUtils`
or any InnerTube client of our own; bundling Python; cover art in webm; live
streams, podcasts, video streams, lossless; queue persistence; chunked mid-run
conversion flushes.
