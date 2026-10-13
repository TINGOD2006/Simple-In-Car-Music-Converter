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

/**
 * Engine answered 501 on `/api/pick`: this platform has no native dialog, so the
 * UI must degrade to browser upload instead of reporting a crash.
 */
export function isNoNativeDialog(err: unknown): boolean {
  return err instanceof ApiError && err.status === 501;
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
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
  pick(req: PickRequest): Promise<PickResponse> {
    return request<PickResponse>('/api/pick', postInit(req));
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
