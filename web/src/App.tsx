/**
 * Application shell: owns the reducer, the engine calls, the intake pipeline
 * (native dialog / browser upload / drag & drop) and the tab switch.
 *
 * Reminder of the architecture rule: this package performs NO DSP. It displays
 * engine results, sends edit intent (pure `Timeline` data), and plays back audio.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, ApiError, isNoNativeDialog } from './api.ts';
import type { DenoiseAvailabilityResponse, LibraryEntry, MediaInfo, PickMode } from './api-types.ts';
import { AppContext } from './app-context.ts';
import type { AppActions, BatchStartOptions } from './app-context.ts';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import UsbTab from './components/UsbTab.tsx';
import { collectDroppedFiles, dropHasFiles, formatBytes, joinEnginePath } from './file-intake.ts';
import { initialState, reducer } from './store.ts';

const PREVIEW_POLL_MS = 800;

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function Shell(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  // `setLocalFile` still creates and revokes the object URL, but the USB page
  // renders no <audio> preview, so nothing reads the value any more — hence the
  // hole. Removing the state outright would mean deleting the whole audition path.
  const [, setLocalUrl] = useState<string | null>(null);
  // Kept for the same reason: the startup `/api/denoise-availability` probe and
  // `actions.refreshDenoise` still run, they just have no panel to report into.
  const [, setDenoiseInfo] = useState<DenoiseAvailabilityResponse | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const pollRef = useRef<number | null>(null);
  /** Double-submit guards: React state updates are async, refs are not. */
  const pickBusyRef = useRef(false);
  const uploadBusyRef = useRef(false);

  /* ---------------------------------------------------------------- */
  /* Engine connectivity                                              */
  /* ---------------------------------------------------------------- */

  const checkHealth = useCallback(async () => {
    try {
      const health = await api.health();
      dispatch({ type: 'engineOk', ok: true, scratchRoot: health.scratchRoot ?? null });
    } catch (err) {
      dispatch({ type: 'engineOk', ok: false });
      dispatch({ type: 'error', message: `引擎未連線：${errText(err)}` });
    }
  }, []);

  const refreshDenoise = useCallback(async () => {
    try {
      setDenoiseInfo(await api.denoiseAvailability());
    } catch {
      // Availability is advisory; a failure here must not break the UI.
      setDenoiseInfo(null);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    void refreshDenoise();
  }, [checkHealth, refreshDenoise]);

  /* ---------------------------------------------------------------- */
  /* Failure visibility: nothing may reject silently                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent): void => {
      // Deliberately NOT calling preventDefault(): the console keeps the full
      // stack for debugging while the banner tells the user something broke.
      dispatch({ type: 'error', message: `未處理的 Promise 拒絕：${errText(e.reason)}` });
    };
    const onWindowError = (e: ErrorEvent): void => {
      // Resource load failures (an <audio src> that 404s) carry no `error`
      // object and are surfaced by that element's own onError instead.
      if (!e.error) return;
      dispatch({ type: 'error', message: `未捕捉的例外：${errText(e.error)}` });
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onWindowError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onWindowError);
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Local (zero-latency) audition of the original file               */
  /* ---------------------------------------------------------------- */

  const setLocalFile = useCallback((file: File | null) => {
    setLocalUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });
    setLocalFileName(file ? file.name : null);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Loading sources: probe + waveform (both engine calls)            */
  /* ---------------------------------------------------------------- */

  const ingestSource = useCallback(
    async (path: string, replaceTimeline: boolean): Promise<void> => {
      const info: MediaInfo = await api.probe(path);
      const id = `src:${path}`;
      const src = { id, path, info, peaks: [] as number[] };
      dispatch({ type: 'loadSource', source: src, replaceTimeline });
      dispatch({ type: 'notice', message: `已載入 ${path}` });
      try {
        const peaks = await api.waveform(path, 1400);
        dispatch({ type: 'sourcePeaks', sourceId: id, peaks });
      } catch (err) {
        // A missing waveform is a degraded view, not a fatal error.
        dispatch({ type: 'notice', message: `波形取得失敗（仍可編輯）：${errText(err)}` });
      }
    },
    [],
  );

  /**
   * Probe + load several paths in order. The FIRST success replaces the
   * timeline; later ones are added as sources (otherwise a failing first file
   * would leave the editor with no clip at all). Every failure is surfaced —
   * one bad file in a multi-select must not hide the others.
   */
  const loadPaths = useCallback(
    async (paths: readonly string[]): Promise<number> => {
      let loaded = 0;
      setProbeBusy(true);
      try {
        for (const raw of paths) {
          const path = raw.trim();
          if (!path) continue;
          try {
            await ingestSource(path, loaded === 0);
            loaded += 1;
          } catch (err) {
            dispatch({ type: 'error', message: `載入失敗 ${path}：${errText(err)}` });
          }
        }
      } finally {
        setProbeBusy(false);
      }
      return loaded;
    },
    [ingestSource],
  );

  const loadPath = useCallback(
    async (path: string, replaceTimeline: boolean) => {
      const trimmed = path.trim();
      if (!trimmed) {
        dispatch({ type: 'error', message: '請先填寫引擎端的檔案路徑（引擎機器上的絕對路徑）。' });
        return;
      }
      setProbeBusy(true);
      try {
        await ingestSource(trimmed, replaceTimeline);
      } catch (err) {
        dispatch({ type: 'error', message: `載入失敗：${errText(err)}` });
      } finally {
        setProbeBusy(false);
      }
    },
    [ingestSource],
  );

  const loadLibraryEntry = useCallback(
    async (entry: LibraryEntry) => {
      await loadPath(entry.path, true);
    },
    [loadPath],
  );

  const scanLibrary = useCallback(async (root: string): Promise<LibraryEntry[]> => {
    const trimmed = root.trim();
    if (!trimmed) {
      dispatch({ type: 'error', message: '請填寫要掃描的資料夾路徑。' });
      return [];
    }
    setScanning(true);
    try {
      const res = await api.library(trimmed);
      const entries = res.entries ?? [];
      const errors = res.errors ?? [];
      dispatch({ type: 'library', root: trimmed, entries, errors });
      dispatch({
        type: 'notice',
        message: `掃描完成：${entries.length} 個檔案${errors.length ? `，${errors.length} 個錯誤` : ''}`,
      });
      return entries;
    } catch (err) {
      dispatch({ type: 'error', message: `掃描失敗：${errText(err)}` });
      return [];
    } finally {
      setScanning(false);
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Intake 1: native dialog on the engine machine (POST /api/pick)    */
  /* ---------------------------------------------------------------- */

  const pickAndLoad = useCallback(
    async (mode: PickMode) => {
      if (pickBusyRef.current) {
        dispatch({ type: 'notice', message: '系統對話框已開啟，請先完成或取消它。' });
        return;
      }
      pickBusyRef.current = true;
      setPickBusy(true);
      dispatch({
        type: 'notice',
        message:
          mode === 'files'
            ? '已開啟系統檔案對話框，請在對話框中選擇音訊檔…'
            : '已開啟系統資料夾對話框，請在對話框中選擇資料夾…',
      });

      try {
        const res = await api.pick(
          mode === 'files'
            ? { mode, title: '選擇音訊檔案', multiple: true }
            : { mode, title: '選擇資料夾' },
        );
        const paths = (res.paths ?? []).filter((p) => typeof p === 'string' && p.trim().length > 0);
        if (paths.length === 0) {
          dispatch({ type: 'notice', message: '未選擇任何項目（對話框已取消）。' });
          return;
        }

        if (mode === 'folder') {
          const root = paths[0];
          if (!root) return;
          const entries = await scanLibrary(root);
          const first = entries[0];
          if (!first) {
            dispatch({ type: 'notice', message: `資料夾中沒有可用的音訊檔案：${root}` });
            return;
          }
          const loaded = await loadPaths([first.path]);
          if (loaded === 0) return;
          dispatch({
            type: 'notice',
            message: `已載入 ${basename(first.path)}；此資料夾共 ${entries.length} 個音訊檔，其餘列在「資料庫掃描」清單。`,
          });
          return;
        }

        const loaded = await loadPaths(paths);
        if (loaded === 0) return;
        const first = paths[0];
        dispatch({
          type: 'notice',
          message:
            loaded === 1 && first
              ? `已載入 ${basename(first)}`
              : `已載入 ${loaded}/${paths.length} 個檔案（第一個取代時間軸，其餘加入來源）`,
        });
      } catch (err) {
        if (isNoNativeDialog(err)) {
          dispatch({
            type: 'error',
            message: `此平台沒有原生檔案對話框，請改用「拖放檔案到這裡」或瀏覽器上傳。（${errText(err)}）`,
          });
        } else {
          dispatch({ type: 'error', message: `選擇檔案失敗：${errText(err)}` });
        }
      } finally {
        pickBusyRef.current = false;
        setPickBusy(false);
      }
    },
    [loadPaths, scanLibrary],
  );

  /* ---------------------------------------------------------------- */
  /* Intake 2: browser upload (POST /api/upload, raw bytes)            */
  /* ---------------------------------------------------------------- */

  const uploadFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      const list = files.filter((f): f is File => f instanceof File);
      if (list.length === 0) {
        dispatch({ type: 'error', message: '沒有收到任何檔案，請重新選擇或拖放。' });
        return;
      }
      if (uploadBusyRef.current) {
        dispatch({ type: 'notice', message: '已有上傳正在進行，請稍候再試。' });
        return;
      }

      uploadBusyRef.current = true;
      setUploadBusy(true);

      const uploaded: string[] = [];
      const failures: string[] = [];
      try {
        for (const file of list) {
          dispatch({
            type: 'notice',
            message: `上傳中（${uploaded.length + failures.length + 1}/${list.length}）：${file.name}（${formatBytes(file.size)}）`,
          });
          try {
            const res = await api.upload(file);
            if (!res.path) throw new Error('引擎未回傳檔案路徑');
            uploaded.push(res.path);
          } catch (err) {
            failures.push(`${file.name}：${errText(err)}`);
          }
        }
      } finally {
        uploadBusyRef.current = false;
        setUploadBusy(false);
      }

      // Keep zero-latency local playback for the first chosen file — the engine
      // load below is what actually populates the editor.
      const firstFile = list[0];
      if (firstFile) setLocalFile(firstFile);

      if (uploaded.length === 0) {
        if (failures.length > 0) {
          dispatch({ type: 'error', message: `上傳失敗（${failures.length} 個檔案）：\n${failures.join('\n')}` });
        }
        return;
      }

      const loaded = await loadPaths(uploaded);

      if (failures.length > 0) {
        dispatch({
          type: 'error',
          message: `${failures.length} 個檔案上傳失敗（其餘 ${uploaded.length} 個已上傳）：\n${failures.join('\n')}`,
        });
      }
      if (loaded > 0) {
        const first = uploaded[0];
        dispatch({
          type: 'notice',
          message:
            uploaded.length === 1 && first
              ? `已上傳並載入 ${basename(first)}（${formatBytes(firstFile?.size ?? 0)}）`
              : `已上傳並載入 ${loaded}/${uploaded.length} 個檔案`,
        });
      }
    },
    [loadPaths, setLocalFile],
  );

  /* ---------------------------------------------------------------- */
  /* Intake 3: whole-window drag & drop                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let depth = 0;

    const hasFiles = (dt: DataTransfer | null): boolean =>
      dropHasFiles(dt) || (dt?.files?.length ?? 0) > 0;

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      setDragActive(true);
    };

    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      // Without preventDefault the browser navigates to the dropped file and the
      // whole app is replaced by a media player.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };

    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer;
      if (!dt || !hasFiles(dt)) return;
      e.preventDefault();
      depth = 0;
      setDragActive(false);

      void (async () => {
        // `collectDroppedFiles` reads `webkitGetAsEntry()` synchronously before
        // its first await, so the entries are still valid when it is called here.
        const intake = await collectDroppedFiles(dt);

        if (intake.files.length === 0) {
          const reasons: string[] = [];
          if (intake.unreadableDirs > 0) reasons.push(`${intake.unreadableDirs} 個資料夾無法列舉`);
          if (intake.skipped.length > 0) reasons.push(`非音訊檔：${intake.skipped.join('、')}`);
          dispatch({
            type: 'error',
            message:
              `拖放的內容裡沒有可上傳的音訊檔${reasons.length > 0 ? `（${reasons.join('；')}）` : ''}。` +
              `若拖入的是資料夾，請改用「選擇資料夾」的原生對話框，或先開啟資料夾後拖放其中的檔案。`,
          });
          return;
        }

        await uploadFiles(intake.files);

        const notes: string[] = [];
        if (intake.skipped.length > 0) notes.push(`略過 ${intake.skipped.length} 個非音訊檔`);
        if (intake.truncated) notes.push('檔案過多，只處理前 400 個');
        if (notes.length > 0) dispatch({ type: 'notice', message: notes.join('；') });
      })();
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [uploadFiles]);

  /* ---------------------------------------------------------------- */
  /* Preview (effect audition = actual engine output)                  */
  /* ---------------------------------------------------------------- */

  const preview = useCallback(async (range?: { startSec: number; endSec: number } | null) => {
    const s = stateRef.current;
    if (s.timeline.clips.length === 0) {
      dispatch({ type: 'error', message: '時間軸是空的，沒有可試聽的內容。' });
      return;
    }
    setPreviewBusy(true);
    dispatch({ type: 'notice', message: '試聽＝實際輸出，需要 1–3 秒…' });
    try {
      // The engine as built requires `outputPath` on /api/preview (it shares the
      // /api/render branch), so pass a scratch WAV path alongside the specified
      // `startSec`/`endSec` shape. `api.preview` accepts either response form.
      // Use the engine's own scratch dir when health reported one: a bare file
      // name is not an absolute path and `GET /api/file` cannot read it back.
      const name = `aus-preview-${Date.now().toString(36)}.wav`;
      const scratchOut = s.scratchRoot ? joinEnginePath(s.scratchRoot, name) : name;
      const blob = await api.preview(
        {
          timeline: s.timeline,
          preset: s.exportPreset,
          sourcePaths: sourcePathMap(s),
          startSec: range?.startSec ?? 0,
          endSec: range?.endSec ?? 0, // 0 = whole timeline
        },
        scratchOut,
      );
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      dispatch({ type: 'notice', message: '試聽已就緒（此檔即為引擎實際輸出）。' });
    } catch (err) {
      dispatch({ type: 'error', message: `試聽失敗：${errText(err)}` });
    } finally {
      setPreviewBusy(false);
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Render                                                          */
  /* ---------------------------------------------------------------- */

  const render = useCallback(async (outputPath: string) => {
    const s = stateRef.current;
    if (!outputPath.trim()) {
      dispatch({ type: 'error', message: '請先填寫輸出檔案路徑。' });
      return;
    }
    setRenderBusy(true);
    try {
      const res = await api.render({
        timeline: s.timeline,
        preset: s.exportPreset,
        sourcePaths: sourcePathMap(s),
        outputPath,
        loudness: s.exportPreset.loudness,
      });
      if (res.ok) {
        dispatch({ type: 'notice', message: `匯出完成：${res.outputPath}` });
      } else {
        // The engine reports render failures as `error`, not `message`.
        dispatch({ type: 'error', message: `匯出失敗：${res.error ?? '引擎未提供原因'}` });
      }
    } catch (err) {
      dispatch({ type: 'error', message: `匯出失敗：${errText(err)}` });
    } finally {
      setRenderBusy(false);
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Batch: start a job, then poll GET /api/jobs/:id                  */
  /* ---------------------------------------------------------------- */

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startBatch = useCallback(
    async (opts: BatchStartOptions) => {
      const s = stateRef.current;
      if (opts.roots.length === 0 || !opts.roots[0]) {
        dispatch({ type: 'error', message: '請填寫來源資料夾。' });
        return;
      }
      if (!opts.outputDir.trim()) {
        dispatch({ type: 'error', message: '請填寫輸出資料夾。' });
        return;
      }
      try {
        const preset = {
          ...s.exportPreset,
          loudness: {
            enabled: opts.loudnessEnabled,
            integratedLufs: opts.integratedLufs,
            truePeakDb: opts.truePeakDb,
            lra: s.exportPreset.loudness.lra,
          },
        };
        const { jobId } = await api.batch({
          roots: opts.roots,
          outputDir: opts.outputDir,
          preset,
          loudness: preset.loudness,
          filenamePattern: opts.filenamePattern || undefined,
          dedup: opts.dedup,
          targetCapacityBytes:
            opts.targetCapacityGb && opts.targetCapacityGb > 0
              ? Math.round(opts.targetCapacityGb * 1024 * 1024 * 1024)
              : null,
        });
        dispatch({ type: 'batchStart', jobId });
        stopPolling();
        pollRef.current = window.setInterval(() => {
          void (async () => {
            try {
              const job = await api.job(jobId);
              dispatch({ type: 'batchProgress', state: job.state, progress: job.progress ?? null });
              if (job.state === 'done') {
                if (job.report) dispatch({ type: 'batchReport', report: job.report });
                else dispatch({ type: 'batchError', message: '工作完成但引擎未回傳報告。' });
                stopPolling();
              } else if (job.state === 'failed') {
                dispatch({
                  type: 'batchError',
                  message: job.error ? `批次工作失敗：${job.error}` : '批次工作失敗，請見引擎日誌。',
                });
                stopPolling();
              }
            } catch (err) {
              dispatch({ type: 'batchError', message: `讀取進度失敗：${errText(err)}` });
              stopPolling();
            }
          })();
        }, PREVIEW_POLL_MS);
      } catch (err) {
        dispatch({ type: 'batchError', message: `無法啟動批次：${errText(err)}` });
      }
    },
    [stopPolling],
  );

  const actions: AppActions = useMemo(
    () => ({
      loadPath,
      scanLibrary,
      loadLibraryEntry,
      pickAndLoad,
      uploadFiles,
      preview,
      render,
      startBatch,
      checkHealth,
      refreshDenoise,
      setLocalFile,
      localFileName,
      previewUrl,
      previewBusy,
      renderBusy,
      scanning,
      pickBusy,
      uploadBusy,
      probeBusy,
      dragActive,
    }),
    [
      loadPath,
      scanLibrary,
      loadLibraryEntry,
      pickAndLoad,
      uploadFiles,
      preview,
      render,
      startBatch,
      checkHealth,
      refreshDenoise,
      setLocalFile,
      localFileName,
      previewUrl,
      previewBusy,
      renderBusy,
      scanning,
      pickBusy,
      uploadBusy,
      probeBusy,
      dragActive,
    ],
  );

  const value = useMemo(() => ({ state, dispatch, actions }), [state, actions]);

  return (
    <AppContext.Provider value={value}>
      <div className="app">
        <header className="topbar">
          <h1>AudioUsbStudio</h1>
          <nav className="tabs">
            {/* The USB page is the app's only screen; the 編輯器／效果面板／批次 USB
                tabs are gone. A single-entry nav is kept so the shell still has a
                place to show which page is up. */}
            <button
              className={state.tab === 'usb' ? 'active' : ''}
              onClick={() => dispatch({ type: 'tab', tab: 'usb' })}
            >
              USB 轉換
            </button>
          </nav>
          <span className="spacer" />
          <span
            className={`health ${state.engineOk === true ? 'ok' : state.engineOk === false ? 'bad' : ''}`}
          >
            {state.engineOk === true
              ? '● 引擎已連線'
              : state.engineOk === false
                ? '● 引擎未連線'
                : '● 檢查中…'}
          </span>
          <button onClick={() => void checkHealth()}>重新檢查</button>
          {actions.probeBusy || actions.uploadBusy || actions.pickBusy ? (
            <span className="busy-chip">
              <span className="spinner" aria-hidden="true" />
              {actions.uploadBusy ? '上傳中' : actions.pickBusy ? '對話框中' : '載入中'}
            </span>
          ) : null}
          <span className="pill">UI 不做 DSP</span>
        </header>

        {state.errors.length > 0 ? (
          <div className="banner error errlist">
            <div className="errhead">
              <strong>錯誤（{state.errors.length}）</strong>
              <span className="grow" />
              <button onClick={() => dispatch({ type: 'error', message: null })}>全部關閉</button>
            </div>
            {state.errors.map((e) => (
              <div className="errrow" key={e.id}>
                <span className="grow errmsg">{e.message}</span>
                <button onClick={() => dispatch({ type: 'errorDismiss', id: e.id })}>關閉</button>
              </div>
            ))}
          </div>
        ) : null}
        {state.notice ? (
          <div className="banner notice">
            <span className="grow">{state.notice}</span>
            <button onClick={() => dispatch({ type: 'notice', message: null })}>關閉</button>
          </div>
        ) : null}

        <div className="body">
          {/* OnboardingPanel is deliberately gone. It existed to get audio into the
              editor, and the USB page is now the only page: its own workspace picker
              and drop zone do that job, while the panel's call to action switched to
              the `editor` tab — a no-op with no editor left to switch to. */}
          <UsbTab />
        </div>

        {dragActive ? (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-overlay-card">
              <div className="drop-overlay-title">放開以載入音訊檔案</div>
              <div className="hint">
                檔案會先上傳到本機引擎再載入；拖入資料夾會遞迴掃描其中的音訊檔
                {uploadBusy ? '（目前仍在上傳，請稍候）' : ''}。
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppContext.Provider>
  );
}

/** The contract's `sourcePaths` map: sourceId -> absolute file path. */
function sourcePathMap(s: { sources: Record<string, { path: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, src] of Object.entries(s.sources)) out[id] = src.path;
  return out;
}

/** Join an engine-side directory with a file name, keeping the engine's separator. */

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}
