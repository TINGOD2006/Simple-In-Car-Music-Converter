/**
 * Thin `fetch` wrapper over the frozen HTTP contract.
 *
 * Every failure path is converted into an `ApiError` carrying a human-readable
 * message, so no caller can accidentally render a blank screen because a rejected
 * promise escaped.
 */

import type {
  BatchRequest,
  BatchStartResponse,
  DenoiseAvailabilityResponse,
  DenoiseRequest,
  DenoiseResponse,
  HealthResponse,
  JobEnvelope,
  JobStatusResponse,
  MeasureResponse,
  MediaInfo,
  PickRequest,
  PickResponse,
  PreviewRequest,
  ProbeResponse,
  RenderRequest,
  RenderResponse,
  ScanResult,
  UploadResponse,
  WaveformResponse,
} from './api-types.ts';

import { bridgePick, detectNativeTransport, type NativeTransport } from './native-bridge.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly detail: string;

  constructor(url: string, status: number, detail: string) {
    super(
      status === 0
        ? `連線失敗 — ${url}${detail ? `: ${detail}` : ''}`
        : `HTTP ${status} — ${url}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.detail = detail;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pull a readable reason out of an error response.
 *
 * The engine answers failures with `{ok:false, error:"..."}`; showing the raw
 * JSON envelope to the user is noise, so the `error` (or `message`) field wins
 * when the body parses. Anything else is passed through verbatim, truncated.
 */
async function readDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 800);
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
        const field =
          typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.message === 'string'
              ? parsed.message
              : null;
        if (field && field.trim()) return field.trim();
      } catch {
        /* not JSON after all — fall through to the raw text */
      }
    }
    return text;
  } catch {
    return '';
  }
}

/**
 * `GET /api/file?path=...` — the ONLY way the browser can play a file that lives
 * on the engine machine (a page cannot read `C:\...`). Used as an `<audio src>`.
 */
export function fileUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

/** Marker carried by {@link NoNativeDialogError}; the UI keys the upload fallback on it. */
export const NO_NATIVE_DIALOG = 'no-native-dialog';

/**
 * No route can offer a native dialog.
 *
 * Distinct from `ApiError(501)`, which only says the engine cannot: this is also
 * raised when a bridge exists but failed and the engine then answered 501.
 */
export class NoNativeDialogError extends Error {
  readonly code = NO_NATIVE_DIALOG;

  constructor(detail: string) {
    super(`${NO_NATIVE_DIALOG}: ${detail}`);
    this.name = 'NoNativeDialogError';
  }
}

/**
 * True when there is no native file dialog on any route, so the UI must degrade
 * to a browser upload instead of reporting a crash.
 */
export function isNoNativeDialog(err: unknown): boolean {
  if (err instanceof NoNativeDialogError) return true;
  return err instanceof ApiError && err.status === 501;
}

/**
 * The slice of `fetch` this module uses.
 *
 * Structural on purpose: a test double can then be a plain function without
 * having to implement the whole DOM signature.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injection points for `api.pick`; both default to the real environment. */
export interface PickDeps {
  /**
   * The desktop shell's bridge. Omit to auto-detect; pass `null` to force the
   * "plain browser" path.
   */
  transport?: NativeTransport | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function request<T>(
  url: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    // Network-level failure (engine not running, DNS, connection refused...).
    throw new ApiError(url, 0, `無法連線到 Node 引擎，請確認引擎已啟動。(${describe(err)})`);
  }

  if (!res.ok) {
    throw new ApiError(url, res.status, await readDetail(res));
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // Guard against an HTML error page being parsed as JSON.
    const text = await readDetail(res);
    throw new ApiError(url, res.status, `回應不是 JSON（content-type=${contentType}）：${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  /**
   * `POST /api/pick` — a NATIVE file/folder dialog on the engine machine.
   *
   * Rejects with an `ApiError` whose `status` is 501 when this platform has no
   * native dialog; callers check `isNoNativeDialog(err)` and fall back to a
   * browser upload instead of showing a crash.
   */
  /**
   * Ask for files or a folder, using whichever route this environment offers.
   *
   * 1. The desktop shell's bridge, when the page runs inside it. It is the only
   *    route that can hand back a real engine-side path.
   * 2. `POST /api/pick` — the engine's own native dialog (a browser on Windows).
   * 3. Neither: rejects with {@link NoNativeDialogError}, and the caller uploads.
   *
   * A cancellation is reported as `{ok:true, paths:[]}` on every route, so no
   * caller needs a second shape to tell "cancelled" from "failed".
   */
  async pick(req: PickRequest, deps: PickDeps = {}): Promise<PickResponse> {
    const transport = deps.transport !== undefined ? deps.transport : detectNativeTransport();
    let bridgeFailure = '';

    if (transport) {
      try {
        const paths = await bridgePick(transport, req.mode, {
          title: req.title,
          multiple: req.multiple,
          timeoutMs: deps.timeoutMs,
        });
        return { ok: true, paths: paths ?? [] };
      } catch (err) {
        // The shell is present but broken. That is a reason to fall back, not a
        // reason to give up: the engine may still have a dialog of its own.
        bridgeFailure = describe(err);
      }
    }

    try {
      return await request<PickResponse>('/api/pick', postInit(req), deps.fetchImpl);
    } catch (err) {
      if (isNoNativeDialog(err)) {
        throw new NoNativeDialogError(
          bridgeFailure
            ? `the page bridge failed (${bridgeFailure}) and the engine has no dialog`
            : 'the engine has no native dialog on this platform',
        );
      }
      throw err;
    }
  },

  /** `<audio src>` for a file that lives on the engine machine. */
  fileUrl(path: string): string {
    return fileUrl(path);
  },

  /**
   * `POST /api/upload?name=<filename>` — RAW bytes, NOT multipart.
   *
   * The engine stores the upload and answers with an absolute path, which is then
   * fed through the ordinary probe/waveform flow. This is the fallback for every
   * environment where the native dialog is unavailable.
   */
  async upload(file: File, name?: string): Promise<UploadResponse> {
    const url = `/api/upload?name=${encodeURIComponent(name ?? file.name)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
    } catch (err) {
      throw new ApiError(url, 0, `上傳失敗，無法連線到 Node 引擎。(${describe(err)})`);
    }
    if (!res.ok) throw new ApiError(url, res.status, await readDetail(res));

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new ApiError(
        url,
        res.status,
        `回應不是 JSON（content-type=${contentType}）：${await readDetail(res)}`,
      );
    }
    return (await res.json()) as UploadResponse;
  },

  /**
   * `GET /api/library` takes `?dir=`, NOT `?root=` — the frozen task-4 text says
   * `root`, but `src/server/index.ts` reads `url.searchParams.get('dir')` and
   * answers 400 "dir is required" otherwise. Verified live.
   */
  library(root: string): Promise<ScanResult> {
    return request<ScanResult>(`/api/library?dir=${encodeURIComponent(root)}`);
  },

  /**
   * `POST /api/probe` answers `{ok:true, info:{...}}`. The pre-verification code
   * returned the whole envelope typed as `MediaInfo`, so every caller read
   * `info.format.durationSec` off `undefined` and crashed. Unwrap it here.
   */
  async probe(path: string): Promise<MediaInfo> {
    const res = await request<ProbeResponse>('/api/probe', postInit({ path }));
    return res.info;
  },

  async waveform(path: string, buckets: number): Promise<number[]> {
    const n = Math.max(1, Math.floor(buckets));
    const res = await request<WaveformResponse>(
      `/api/waveform?path=${encodeURIComponent(path)}&buckets=${n}`,
    );
    return res.peaks ?? [];
  },

  render(req: RenderRequest): Promise<RenderResponse> {
    return request<RenderResponse>('/api/render', postInit(req));
  },

  /**
   * Effect audition.
   *
   * Returns raw WAV bytes when the engine honours the specified contract. The
   * engine as built routes `/api/preview` through the `/api/render` branch instead:
   * it requires `outputPath`, writes a file, and answers JSON. Both shapes are
   * accepted here; the JSON case falls back to fetching the written file from the
   * site root, and if that is not served either, the caller gets an explicit
   * `ApiError` naming the divergence instead of a silent failure.
   */
  async preview(req: PreviewRequest, outputPath?: string): Promise<Blob> {
    const body: PreviewRequest = outputPath ? { ...req, outputPath } : req;
    let res: Response;
    try {
      res = await fetch('/api/preview', postInit(body));
    } catch (err) {
      throw new ApiError('/api/preview', 0, `無法連線到 Node 引擎。(${describe(err)})`);
    }
    if (!res.ok) {
      throw new ApiError('/api/preview', res.status, await readDetail(res));
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      // Contract as specified: raw audio bytes.
      return await res.blob();
    }

    const envelope = (await res.json()) as RenderResponse;
    if (!envelope.ok) {
      throw new ApiError(
        '/api/preview',
        res.status,
        envelope.error ?? '引擎未回傳可播放的音訊，且未說明原因。',
      );
    }
    // The engine wrote a WAV to disk. Read it back through `GET /api/file`,
    // which takes the ABSOLUTE path. The previous code fetched `/<basename>`
    // off the static root, which never resolved for a scratch file — the
    // audition was silently a dead end.
    const written = envelope.outputPath ?? outputPath;
    if (written) {
      let fileStatus = 0;
      try {
        const fileRes = await fetch(fileUrl(written));
        if (fileRes.ok) return await fileRes.blob();
        fileStatus = fileRes.status;
      } catch {
        /* fall through to the explicit divergence error below */
      }
      throw new ApiError(
        '/api/preview',
        res.status,
        `引擎以 JSON 回應並寫入 ${written}，但 GET /api/file 取不回該檔` +
          `${fileStatus ? `（HTTP ${fileStatus}）` : ''}。` +
          `POST /api/preview 目前與 /api/render 共用分支、要求 outputPath 並回傳 JSON，` +
          `而非契約所述的 audio/wav 位元組 —— 需要引擎端改為直接回傳 WAV，` +
          `或讓 outputPath 指向引擎可讀回的絕對路徑。`,
      );
    }
    throw new ApiError(
      '/api/preview',
      res.status,
      '引擎以 JSON 回應但未提供 outputPath，無法取回試聽音訊。',
    );
  },

  batch(req: BatchRequest): Promise<BatchStartResponse> {
    return request<BatchStartResponse>('/api/batch', postInit(req));
  },

  /**
   * `GET /api/measure?path=<encodeURIComponent(path)>` — loudness of ONE file.
   *
   * One ffmpeg pass per call, so the caller is expected to run a few at a time and
   * fill a table in progressively. A 404 (no such file) or a 422 (no audio stream /
   * unreadable) arrives as an `ApiError` like every other method; the caller must
   * render that as "unmeasurable", never as a loudness of zero.
   */
  measure(path: string): Promise<MeasureResponse> {
    return request<MeasureResponse>(`/api/measure?path=${encodeURIComponent(path)}`);
  },

  /**
   * `GET /api/jobs/:id` answers `{ok:true, job:{...}}`. The pre-verification
   * code read `body.state`, which is always `undefined` — polling never saw
   * `done`/`failed`, so the progress bar hung forever. Unwrap `job` here.
   */
  async job(id: string): Promise<JobStatusResponse> {
    const res = await request<JobEnvelope>(`/api/jobs/${encodeURIComponent(id)}`);
    return res.job;
  },

  denoise(req: DenoiseRequest): Promise<DenoiseResponse> {
    return request<DenoiseResponse>('/api/denoise', postInit(req));
  },

  /**
   * `GET /api/denoise-availability` — hyphenated. The frozen task-4 text says
   * `/api/denoise/availability`, which the server answers with 404.
   */
  denoiseAvailability(): Promise<DenoiseAvailabilityResponse> {
    return request<DenoiseAvailabilityResponse>('/api/denoise-availability');
  },
};
