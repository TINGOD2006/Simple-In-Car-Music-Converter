/**
 * UI-side type declarations.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * The UI is a *pure data* client: it never touches a sample. Everything it knows
 * about audio lives in the frozen HTTP contract implemented by the Node engine
 * (`src/server/**`), so the UI only needs the wire shapes.
 *
 * `Timeline` / `Clip` / `EffectInstance` / `MediaInfo` / `ExportPreset` are
 * mirrored from `src/core/types.ts`. `LibraryEntry` / `BatchReport` / `TagSet`
 * belong to `src/core/library.ts`, `src/core/batch.ts` and `src/core/tags.ts`,
 * which are being implemented in parallel by another teammate; the web package
 * deliberately does NOT import from `../src/**` so that `vite build` stays
 * self-contained and cannot be broken by an in-flight sibling file. Keep these in
 * sync with the frozen contract in task-4 / docs.
 */

/* ------------------------------------------------------------------ */
/* Mirrored from src/core/types.ts                                     */
/* ------------------------------------------------------------------ */

export type ChannelCount = 1 | 2;

export interface StreamInfo {
  index: number;
  codecName: string;
  codecLongName: string;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  bitsPerRawSample: number | null;
  bitRate: number | null;
  durationSec: number | null;
}

export interface FormatInfo {
  formatName: string;
  formatLongName: string;
  durationSec: number;
  sizeBytes: number;
  bitRate: number | null;
  tags: Record<string, string>;
}

export interface MediaInfo {
  path: string;
  streams: StreamInfo[];
  audio: StreamInfo | null;
  format: FormatInfo;
  probedAt: string;
}

export type EffectType =
  | 'gain'
  | 'normalize'
  | 'eq'
  | 'reverb'
  | 'echo'
  | 'reverse'
  | 'denoise'
  | 'declick'
  | 'declip'
  | 'highpass'
  | 'lowpass'
  | 'compressor'
  | 'limiter'
  | 'speed';

interface EffectCommon {
  id: string;
  enabled: boolean;
}

export interface GainEffect extends EffectCommon {
  type: 'gain';
  gainDb: number;
}
export interface NormalizeEffect extends EffectCommon {
  type: 'normalize';
  targetPeakDb: number;
}
export interface EqBand {
  freq: number;
  gainDb: number;
  widthOctaves: number;
}
export interface EqEffect extends EffectCommon {
  type: 'eq';
  bands: EqBand[];
}
export interface ReverbEffect extends EffectCommon {
  type: 'reverb';
  preset: 'small-room' | 'large-hall' | 'plate' | 'cathedral';
  mix: number;
}
export interface EchoEffect extends EffectCommon {
  type: 'echo';
  delayMs: number;
  decay: number;
}
export interface ReverseEffect extends EffectCommon {
  type: 'reverse';
}
export type DenoiseStrength = 'gentle' | 'moderate' | 'strong';
export interface DenoiseEffect extends EffectCommon {
  type: 'denoise';
  strength: DenoiseStrength;
}
export interface DeclickEffect extends EffectCommon {
  type: 'declick';
  threshold: number;
}
export interface DeclipEffect extends EffectCommon {
  type: 'declip';
}
export interface HighpassEffect extends EffectCommon {
  type: 'highpass';
  freq: number;
}
export interface LowpassEffect extends EffectCommon {
  type: 'lowpass';
  freq: number;
}
export interface CompressorEffect extends EffectCommon {
  type: 'compressor';
  thresholdDb: number;
  ratio: number;
}
export interface LimiterEffect extends EffectCommon {
  type: 'limiter';
  limitDb: number;
}
export interface SpeedEffect extends EffectCommon {
  type: 'speed';
  factor: number;
}

export type EffectInstance =
  | GainEffect
  | NormalizeEffect
  | EqEffect
  | ReverbEffect
  | EchoEffect
  | ReverseEffect
  | DenoiseEffect
  | DeclickEffect
  | DeclipEffect
  | HighpassEffect
  | LowpassEffect
  | CompressorEffect
  | LimiterEffect
  | SpeedEffect;

export interface Clip {
  id: string;
  sourceId: string;
  srcIn: number;
  srcOut: number;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  crossfadeInSec: number;
  effects: EffectInstance[];
  label?: string;
}

export interface Timeline {
  clips: Clip[];
  sampleRate: number;
  channels: ChannelCount;
}

export interface LoudnessTarget {
  enabled: boolean;
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

export type ContainerFormat =
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'ogg'
  | 'm4a'
  | 'aac'
  | 'opus'
  | 'wma'
  | 'aiff';

export interface ExportPreset {
  container: ContainerFormat;
  codec: string;
  bitrateKbps: number | null;
  sampleRate: number;
  channels: ChannelCount;
  loudness: LoudnessTarget;
  id3v2Version: 3 | 4 | null;
  denoise: 'off' | 'gentle' | 'moderate';
}

export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  info: MediaInfo;
  measured: LoudnessMeasurement | null;
}

/* ------------------------------------------------------------------ */
/* M2 shapes (owned by src/core/{library,tags,batch}.ts on the engine)  */
/* ------------------------------------------------------------------ */

export interface TagSet {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: string;
  year?: string;
  genre?: string;
  comment?: string;
}

export interface LibraryEntry {
  id: string;
  path: string;
  info: MediaInfo;
}

export interface ScanError {
  path: string;
  message: string;
}

export interface ScanResult {
  entries: LibraryEntry[];
  errors: ScanError[];
}

export interface BatchReportItem {
  id: string;
  sourcePath: string;
  outputPath: string | null;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  verify?: VerifyResult;
}

/**
 * `DuplicateGroup` from `src/core/batch.ts`: one kept file plus every file that
 * was dropped in its favour. The pre-verification UI declared `drop` as a single
 * `string`, which would have rendered only the first character of an array.
 */
export interface DuplicateGroup {
  keep: string;
  drop: string[];
  reason: string;
}

export interface BatchReport {
  items: BatchReportItem[];
  duplicates: DuplicateGroup[];
  totalBytes: number;
  durationMs: number;
  preset: ExportPreset;
}

/* ------------------------------------------------------------------ */
/* HTTP contract payloads (frozen — see task-4)                         */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/health`.
 *
 * The engine answers with its own discovery result, not a bare version string:
 * `{ok, ffmpeg, ffprobe, ffmpegSource, scratchRoot, node}`. Verified live
 * against `src/server/index.ts` — see web/CONTRACT-VERIFICATION.md.
 */
export interface HealthResponse {
  ok: true;
  ffmpeg: string;
  ffprobe?: string;
  ffmpegSource?: string;
  scratchRoot?: string;
  node?: string;
  version?: string;
}

/** `POST /api/probe` wraps the MediaInfo in an envelope — it is NOT the info itself. */
export interface ProbeResponse {
  ok: true;
  info: MediaInfo;
}

export interface WaveformResponse {
  peaks: number[];
}

export interface RenderRequest {
  timeline: Timeline;
  preset: ExportPreset;
  sourcePaths: Record<string, string>;
  outputPath: string;
  loudness?: LoudnessTarget | null;
}

/**
 * `POST /api/render` result.
 *
 * The engine answers with the full render outcome (`error`, not `message`), plus
 * `verification` when `doVerify` was requested. Verified live.
 */
export interface RenderResponse {
  ok: boolean;
  outputPath: string;
  durationSec?: number;
  sizeBytes?: number;
  measured?: LoudnessMeasurement | null;
  warnings?: string[];
  error?: string | null;
  verification?: VerifyResult | null;
}

/**
 * `POST /api/preview`.
 *
 * CONTRACT DIVERGENCE (documented, not silently patched over): task-4 specifies
 * that preview returns `audio/wav` bytes, but `src/server/index.ts` routes
 * `/api/preview` through the same branch as `/api/render` — it *requires*
 * `outputPath`, writes a file, and answers JSON. The UI sends `outputPath` and
 * accepts either a JSON envelope or a binary audio body, so it works against
 * both the specified and the shipped shape. See web/CONTRACT-VERIFICATION.md.
 */
export interface PreviewRequest {
  timeline: Timeline;
  preset: ExportPreset;
  sourcePaths: Record<string, string>;
  startSec: number;
  endSec: number;
  /** Required by the engine as built; ignored if a future build returns raw WAV. */
  outputPath?: string;
}

export interface BatchRequest {
  roots: string[];
  outputDir: string;
  preset: ExportPreset;
  loudness?: LoudnessTarget | null;
  filenamePattern?: string;
  dedup?: boolean;
  targetCapacityBytes?: number | null;
}

export interface BatchStartResponse {
  ok?: boolean;
  jobId: string;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobProgress {
  stage: string;
  done: number;
  total: number;
  path?: string;
}

export interface JobStatusResponse {
  id: string;
  state: JobState;
  progress: JobProgress;
  report: BatchReport | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * `GET /api/jobs/:id` wraps the job in an envelope: `{ok:true, job:{...}}`.
 * Reading `body.state` directly (the pre-verification assumption) yields
 * `undefined`, so the UI would poll forever and never notice completion.
 */
export interface JobEnvelope {
  ok: true;
  job: JobStatusResponse;
}

export interface DenoiseRequest {
  path: string;
  outputPath: string;
  postFilter?: boolean;
}

export interface DenoiseResponse {
  ok: boolean;
  outputPath: string | null;
  message?: string;
}

export interface DenoisePolicy {
  batchDefault: string;
  singleTrackOnly: string;
  reason: string;
}

export interface DenoiseAvailabilityResponse {
  available: boolean;
  exePath: string | null;
  policy: DenoisePolicy;
}

/* ------------------------------------------------------------------ */
/* Local-file intake (frozen contract — pick / upload / file)           */
/* ------------------------------------------------------------------ */

/** `POST /api/pick` opens a NATIVE dialog on the engine machine. */
export type PickMode = 'files' | 'folder';

export interface PickRequest {
  mode: PickMode;
  title?: string;
  multiple?: boolean;
}

/**
 * `POST /api/pick` 200 body.
 *
 * An empty `paths` array is a normal outcome: the user cancelled the dialog.
 * A 501 answers `{ok:false, error}` instead — the platform has no native dialog
 * (e.g. a non-Windows build), and callers are expected to fall back to upload.
 */
export interface PickResponse {
  ok: true;
  paths: string[];
}

/**
 * `POST /api/upload?name=<urlencoded-filename>` 200 body.
 *
 * The request body is RAW file bytes (`application/octet-stream`), never
 * multipart. `path` is absolute on the engine machine, so it can be fed straight
 * into `/api/probe`, `/api/waveform` and `/api/library`.
 */
export interface UploadResponse {
  ok: true;
  path: string;
  bytes: number;
}
