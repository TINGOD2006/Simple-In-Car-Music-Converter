# tools/ — DeepFilterNet (external AI denoise stage)

This directory holds the **AI denoise** integration for AudioUsbStudio: how to
obtain `deep-filter.exe`, and the measured evidence for why it is *not* part of the
batch pipeline.

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
