# tools/ — DeepFilterNet (external AI denoise stage)

This directory holds AudioUsbStudio's **external binaries**: how to obtain them,
and the measured evidence behind how they are used. The bulk of this file covers
the **AI denoise** integration (`deep-filter.exe`) and why it is *not* part of the
batch pipeline; §6 covers `yt-dlp.exe`, the YouTube audio downloader.

---

## 1. Why DeepFilterNet is not an ffmpeg filter

Both facts below were measured in this project's environment; see
`docs/ENVIRONMENT.md` §4.1.

| Attempt | Result |
|---|---|
| ffmpeg `arnndn` filter | Filter exists, but the whole ffmpeg build directory contains **no `.rnnn` model file** — unusable. |
| DeepFilterNet **LADSPA** plugin | `Failed to load '=deep_filter_mono'` — the DLL will not load. |
| `ffmpeg → WAV → deep-filter.exe → ffmpeg` | ✅ **Works.** This is the only supported path. |

So AI denoise is implemented as an **external process stage**, not a graph node:
`src/core/denoise.ts` → `denoiseFile()`.

---

## 2. Getting `deep-filter.exe`

The binary is **not committed** (27 MB, and it is a platform-specific release
artifact). Fetch it once per machine:

```powershell
$p='C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio'; Set-Location $p
node tools/fetch-deep-filter.mjs
```

It downloads the official asset into `tools/bin/deep-filter.exe`:

| Field | Value |
|---|---|
| Release | `v0.5.6` (Rikorose/DeepFilterNet) |
| Asset | `deep-filter-0.5.6-x86_64-pc-windows-msvc.exe` |
| Size | `26,912,256` bytes |
| sha256 | `75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915` |

The script verifies both size and sha256 and deletes a partial download, so a
truncated file can never masquerade as a valid install. Use `--out <path>` to place
it elsewhere (e.g. a shared tools directory), and point the app at it with the
`AUS_DEEP_FILTER` environment variable.

### Why a Node script instead of `curl`

Measured in this sandbox: PowerShell's `curl`, `Invoke-WebRequest` and .NET
`HttpClient` **all fail** against GitHub release redirects, while Node's global
`fetch` succeeds. `tools/fetch-deep-filter.mjs` is therefore the working download
path.

### Verify the install

```powershell
& .\tools\bin\deep-filter.exe --version
# deep_filter 0.5.6
```

`denoiseFile()` also treats a missing, zero-byte or non-file path as "not
available", so a broken download degrades to a clean `{ ok: false }` instead of a
crash.

---

## 3. ⚠️ Why DeepFilterNet must never be a batch default

**DeepFilterNet is a speech enhancement model.** It does not merely fail to improve
music — it removes it, because a sustained musical tone looks to the model like
stationary noise to be suppressed.

### 3.1 Original measurement (docs/ENVIRONMENT.md §4.2)

Synthetic "440 Hz sine + white noise":

| Band | Input | Output | Verdict |
|---|---|---|---|
| Full band | −20.2 dB | −59.2 dB | −39 dB |
| 4 kHz+ (noise) | −22.1 dB | −90.3 dB | ✅ noise removed |
| **440 Hz (the signal)** | **−26.9 dB** | **−84.3 dB** | ❌ **signal killed, −57 dB** |

### 3.2 Re-measured for this module (`test/denoise.test.ts`)

Synthetic 440 Hz sine + white noise, 10 s @ 48 kHz mono, via
`denoiseFile()` with default options. `mean_volume` per band, measured with ffmpeg
`volumedetect`:

| Band | Input | Output | Change |
|---|---|---|---|
| Full band | −20.6 dB | −54.7 dB | −34.1 dB |
| **440 Hz (music)** | **−21.1 dB** | **−56.7 dB** | ❌ **−35.6 dB** |
| 4 kHz+ (noise) | −31.7 dB | −79.9 dB | −48.2 dB |

### 3.3 The decisive test: a real musical chord

A lone sine could be dismissed as "not real music". So the same measurement was run
on an **A-major triad** (A3 220 Hz, C#4 277.18 Hz, E4 329.63 Hz, A4 440 Hz) plus
broadband noise — unambiguously musical content:

| Band | Input | Output | Change |
|---|---|---|---|
| **Music (< 1200 Hz)** | **−15.1 dB** | **−43.1 dB** | ❌ **−28.0 dB** |
| Noise (> 4 kHz) | −31.6 dB | −80.8 dB | −49.2 dB |

**The noise drops ~49 dB and the music drops ~28 dB.** There is no setting that
separates them, because the model was trained on speech, not music. Run over a whole
library, every track would come out roughly 28–46 dB quieter — effectively silent.

### 3.4 Conclusion

> **DeepFilterNet is a manual, single-track opt-in only. It is never a batch
> default and never part of an `ExportPreset`.**

The batch pipeline uses the ffmpeg-native gentle chain instead:
`adeclick` + `afftdn=nr=6:nf=-40:tn=1` (see `BATCH_DENOISE_DEFAULT` in
`src/core/denoise.ts`).

This is enforced by code, not by convention:

- `describeDenoisePolicy()` returns the policy as data, with the measured dB figures
  in `reason`, so the CLI / HTTP API / UI all quote the same numbers.
- `assertNotInBatchPipeline(graph)` throws on any graph containing `arnndn`,
  `deep-filter`, `deep_filter`, `deepfilternet`, `dfn` or `.rnnn`.
- `test/denoise.test.ts` locks the rule: the graph produced by `compile()` for the
  USB preset — with no effects, with each denoise strength, and with the whole effect
  catalogue — must contain **no AI denoise trace**, and the guard is proven to catch
  DFN spliced into a *real* compiled graph.

---

## 4. Using it on a single track

```ts
import { findDeepFilter, denoiseFile } from '../src/core/denoise.ts';

const exePath = findDeepFilter();
const r = await denoiseFile(
  { exePath },
  {
    ffmpeg: bins.ffmpeg,
    inputPath: 'C:\\music\\noisy-interview.mp3',
    outputPath: 'C:\\out\\interview-clean.mp3',
    scratch: 'C:\\scratch',
    postFilter: false,     // --pf  : stronger, more artefacts
    attenLimDb: 12,        // -a   : cap the attenuation (0 = no reduction)
    compensateDelay: true, // -D   : compensate STFT/model lookahead
  },
);
if (!r.ok) console.warn(r.message);
```

`denoiseFile()` **never throws**: a missing binary, an undecodable source, a failed
process or a missing output file all return `{ ok: false, outputPath: null, message }`.

### Pipeline it runs

```
input --ffmpeg(-ar 48000)--> stage1.wav --deep-filter.exe--> out/stage1.wav --ffmpeg--> outputPath
```

Every child process is spawned with `stdio: 'ignore'` — piped stdio fails in this
environment with `spawn EPERM` (docs/ENVIRONMENT.md §2.1) — so all data crosses the
process boundary through files. Each call gets a private scratch subdirectory and
removes it afterwards.

`deep-filter.exe` behaviour confirmed by direct probing (useful when debugging):

| Probe | Result |
|---|---|
| `-o <missing dir>` | Exit 0 — **it creates the directory itself** |
| Output naming | Output file is named after the *input* basename, in `-o`'s directory |
| Re-run over an existing output | Exit 0 — overwrites |
| Nonexistent input | Exit 1 |
| `--pf`, `-a <n>`, `-D` | All accepted |
| Several inputs in one call | Exit 0 — one output per input |

### Output format

The final re-encode is chosen from the output extension. `.mp3` uses the project's
CBR convention — `-b:a 320k -minrate 320k -maxrate 320k -bufsize 640k` — because
`-b:a` alone plus `-abr 1` silently produces ~158 kbps
(docs/ENVIRONMENT.md §4.3). Verified: a `denoiseFile()` MP3 probes at
`bit_rate = 320000`.

---

## 5. Tests

```powershell
$p='C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio'; Set-Location $p
npm run typecheck
node test/run.ts
```

Unit tests always run. Integration tests (including the measurements above) **skip with
a printed notice** when `deep-filter.exe` or ffmpeg is absent, so the suite stays green
on a machine that has not downloaded the binary.

---

## 6. `yt-dlp.exe` — YouTube audio download

Both download routes that touch YouTube (`youtube-direct` and `youtube-match`) shell out
to `yt-dlp.exe`. It is **not committed**; fetch it once per machine:

```powershell
$p='C:\Users\TINGOD\Desktop\CodeHome\AudioUsbStudio'; Set-Location $p
node tools/fetch-ytdlp.mjs
```

It downloads the pinned release into `tools/bin/yt-dlp.exe`:

| Field | Value |
|---|---|
| Release | `2026.08.19` (yt-dlp/yt-dlp) |
| Asset | `yt-dlp.exe` |
| Size | `17,840,399` bytes |
| sha256 | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` |

The script verifies both size and sha256 and deletes a partial download, so a truncated
file can never masquerade as a valid install. Use `--out <path>` to place it elsewhere,
and point the app at it with the `AUS_YTDLP_DIR` environment variable.

### Why a Node script instead of `curl`

The same measurement as §2: PowerShell's `curl`, `Invoke-WebRequest` and .NET
`HttpClient` **all fail** against GitHub release redirects, while Node's global `fetch`
succeeds.

### Why a separate binary at all

The pure-JS extractors this project previously bundled are both dead against YouTube's
current bot gate. Measured on this machine on the same ten popular music videos:
`@distube/ytdl-core`'s `getInfo()` throws `Failed to find any playable formats` for
**every** video, and a hand-written InnerTube client using the `ANDROID_VR` player
returns playable formats for **1 of 10** — the other nine answer `LOGIN_REQUIRED`,
`Sign in to confirm you're not a bot`. `yt-dlp` resolves **10 of 10**, and a real
download was probing-verified: `kJQP7kiw5Fk.webm`, 4,605,080 bytes, ffprobe
`codec_name=opus sample_rate=48000 channels=2 format_name=matroska,webm
bit_rate=130862`.

### ⚠️ It cannot be executed in this sandbox

The official asset is a PyInstaller one-file executable, and this project's sandbox
denies it the temp-directory self-extraction it needs:

```
[PYI-33408:ERROR] Failed to create parent directory structure.
```

That is an environment limitation, not a defect in the binary — but it means every
automated test must **inject a runner double** and no test may invoke `yt-dlp`. Coverage
of the real binary is the manual smoke script (`tools/smoke-download.mjs`), never CI.
The wrapper's own stderr capture is unit-tested against `process.execPath` instead.

### How the wrapper talks to it

`src/core/ytdlp.ts`. This sandbox denies *piped* stdio to child processes
(`spawn EPERM`), so stdout is discarded and stderr is redirected to a **file
descriptor** the wrapper opens itself — `stdio: ['ignore', 'ignore', <fd>]`. Structured
data never comes back on stdout either: `yt-dlp -J` would print into the void, so
resolution uses `--print-to-file`, which still writes its file with stdout discarded.

### Bumping the release

See `docs/download-maintenance.md`. In short: change `VERSION`, `EXPECTED_SIZE` and
`EXPECTED_SHA256` together in `tools/fetch-ytdlp.mjs`, re-run the fetch, then run the
smoke script — the three pins are one unit and a partial update is worse than a stale
pin.

