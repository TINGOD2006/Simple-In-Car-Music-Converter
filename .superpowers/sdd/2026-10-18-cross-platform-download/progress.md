# SDD ledger — plan: docs/superpowers/plans/2026-10-18-cross-platform-download.md

Spec: docs/superpowers/specs/2026-10-18-cross-platform-download-design.md (read; binding authority)

## Rulings (pre-flight)

- Ruling: implement directly on master — this repo's established workflow all session (every feature committed and pushed to master with the user's approval; user chose Native 直作 for speed). Cost if wrong: history not isolated per branch — mitigated by per-task commits.

## Pre-flight scan (shared interfaces)

- Task 3 → Task 2: resolveSource types client as SpotifyClient from vendor façade — consistent (façade contract in Task 2 Interfaces; adapt .d.ts internals only).
- Task 4 → Task 3+2: provider implements DownloadProvider (Task 3) using searchYtmSongs/ytdlDownloadAudio (Task 2) — download returns {rawPath} per Task 3 interface — consistent.
- Task 5 → ffbin: runFfmpeg RunOptions.timeoutMs exists (timeout fix shipped) — consistent. Task 5 readTags change (merge stream tags) is consumed by Task 6 integration test (i) — dependency noted, order correct.
- Task 6 → batch: runBatch BatchOptions.includePaths + preset: ExportPreset exist — consistent. rawKbps added to TrackEntry this task (plan edit applied pre-commit).
- Task 7 → Tasks 1,3,4,6 + produces spotifyDirect (consumes Task 2 façade) — consistent; server scope has bins/scratchRoot.
- Task 8 → Task 7 wire contract; store.ts:89 tab union gains 'download' — consistent.
- Task 9 → all + build-exe vendor copy from Task 2 — consistent.

Pre-flight: no conflicts found.

## Task log

(none yet — no task complete; entries are appended ONLY with real commit ranges and a test run watched in this session)

## Final review

(not reached)
- Task 1 (appsettings) DONE: commit 062d551 — src/core/appsettings.ts + test/appsettings.test.ts (6 tests); suite 287/287; typecheck exit 0. Deviation: initial commit made before typecheck; 11 assertEq calls lacked the required msg argument; repaired and amended into the same commit.
