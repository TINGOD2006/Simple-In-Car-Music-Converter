/**
 * Editor tab: load a file, see its waveform, edit the timeline as pure data.
 *
 * Everything here manipulates a `Timeline` object. The audio is untouched until the
 * engine renders it, which is exactly the M1 architecture rule.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../app-context.ts';
import { joinEnginePath } from '../file-intake.ts';
import {
  clipDuration,
  clipStarts,
  editAppendSource,
  editDeleteRange,
  editMoveClip,
  editRemoveClip,
  editSilenceRange,
  editSplit,
  editTrim,
  editTrimClip,
  moveClip,
  timelineDuration,
} from '../store.ts';
import WaveformCanvas from './WaveformCanvas.tsx';
import TimelineTrack from './TimelineTrack.tsx';

interface Props {
  localUrl: string | null;
}

export default function EditorTab({ localUrl }: Props): JSX.Element {
  const { state, dispatch, actions } = useApp();
  const [pathInput, setPathInput] = useState('');
  const [rootInput, setRootInput] = useState(state.libraryRoot || '');
  const [outPath, setOutPath] = useState('');
  const [previewRange, setPreviewRange] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const duration = timelineDuration(state.timeline);
  const starts = useMemo(() => clipStarts(state.timeline), [state.timeline]);
  const selected = state.timeline.clips.find((c) => c.id === state.selectedClipId) ?? null;

  /** Waveform of the clip currently under the playhead, else the first source. */
  const activeSource = useMemo(() => {
    const hit = state.timeline.clips.find((c) => {
      const s = starts.get(c.id) ?? 0;
      return state.playheadSec >= s && state.playheadSec <= s + clipDuration(c);
    });
    const id = hit?.sourceId ?? state.timeline.clips[0]?.sourceId;
    return id ? state.sources[id] ?? null : null;
  }, [state.timeline.clips, state.sources, starts, state.playheadSec]);

  const peaks = activeSource?.peaks ?? [];
  const markers = useMemo(
    () => state.timeline.clips.map((c) => ({ at: starts.get(c.id) ?? 0, label: c.label })),
    [state.timeline.clips, starts],
  );

  // Follow the playhead while the original file plays back locally.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = (): void => dispatch({ type: 'playhead', sec: el.currentTime });
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [dispatch, localUrl]);

  /**
   * Slide the whole selection by `deltaSec`, keeping its length. Clamped so the
   * range can never leave `[0, duration]` — a selection pushed past the end would
   * otherwise make every range-based edit address material that does not exist.
   */
  function nudgeSelection(deltaSec: number): void {
    const sel = state.selection;
    if (!sel) return;
    const len = sel.to - sel.from;
    const from = Math.max(0, Math.min(sel.from + deltaSec, Math.max(0, duration - len)));
    dispatch({ type: 'selection', range: { from, to: from + len } });
  }

  /**
   * Move the selection's `to` edge only. The 1 ms floor keeps the range non-empty,
   * because `activeRange()` treats a zero-width selection as "no selection" and
   * silently falls back to the whole timeline.
   */
  function extendSelection(deltaSec: number): void {
    const sel = state.selection;
    if (!sel) return;
    const to = Math.max(sel.from + 0.001, Math.min(sel.to + deltaSec, duration));
    dispatch({ type: 'selection', range: { from: sel.from, to } });
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard: space = play/pause, Ctrl+Z/Y = undo/redo, S = split,    */
  /* Alt+←/→ = slide the selection, Shift+←/→ = resize its end edge   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      if (e.key === ' ') {
        e.preventDefault();
        const el = audioRef.current;
        if (!el) return;
        if (el.paused) void el.play().catch(() => undefined);
        else el.pause();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (e.key.toLowerCase() === 's' && !mod) {
        e.preventDefault();
        apply(editSplit(state));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // The canvas button titles promise Alt+←/→ and Shift+←/→; wire the same
        // two gestures here so the keyboard and the buttons cannot drift apart.
        const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.5 : 0.1);
        if (e.altKey) {
          e.preventDefault();
          nudgeSelection(step);
        } else if (e.shiftKey && !mod) {
          e.preventDefault();
          extendSelection(step);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Reorder by explicit clip id — the drag source may differ from the selection. */
  function editMoveClipIn(
    s: typeof state,
    id: string,
    toIndex: number,
  ): { label: string; next: typeof state.timeline } | null {
    const from = s.timeline.clips.findIndex((c) => c.id === id);
    if (from < 0 || from === toIndex) return null;
    const next = moveClip(s.timeline, id, toIndex);
    if (next === s.timeline) return null;
    return { label: '移動 clip', next };
  }

  function apply(result: { label: string; next: typeof state.timeline } | null): void {
    if (!result) {
      dispatch({ type: 'notice', message: '此操作在此位置無效（例如切點落在 clip 邊界）。' });
      return;
    }
    dispatch({ type: 'edit', label: result.label, next: result.next });
  }

  const canUndo = state.cursor > 0;
  const canRedo = state.cursor < state.history.length - 1;

  return (
    <div className="col">
      {/* ---------------- Source ---------------- */}
      <div className="panel">
        <h2>來源</h2>
        <div className="inline">
          <label className="field">
            檔案路徑（引擎端絕對路徑）
            <input
              id="manual-path-input"
              value={pathInput}
              placeholder="C:\Music\track.mp3"
              onChange={(e) => setPathInput(e.target.value)}
              style={{ minWidth: 340 }}
            />
          </label>
          <button
            className="primary"
            onClick={() => void actions.loadPath(pathInput, true)}
            disabled={actions.probeBusy}
          >
            {actions.probeBusy ? '載入中…' : '載入並取代時間軸'}
          </button>
          <button onClick={() => void actions.loadPath(pathInput, false)} disabled={actions.probeBusy}>
            僅加入來源
          </button>
          <span className="sep" />
          <button
            onClick={() => void actions.pickAndLoad('files')}
            disabled={actions.pickBusy || actions.uploadBusy || actions.probeBusy}
          >
            {actions.pickBusy ? '對話框中…' : '選擇檔案…'}
          </button>
          <button
            onClick={() => void actions.pickAndLoad('folder')}
            disabled={actions.pickBusy || actions.uploadBusy || actions.probeBusy}
          >
            選擇資料夾…
          </button>
          <label className="field">
            瀏覽器上傳（後備）
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              multiple
              disabled={actions.uploadBusy}
              onChange={(e) => {
                // Copy the FileList out BEFORE clearing the input, otherwise the
                // list is empty by the time the upload runs and picking the same
                // file twice in a row fires no change event at all.
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length > 0) void actions.uploadFiles(files);
              }}
            />
          </label>
        </div>
        <p className="hint">
          「選擇檔案…／選擇資料夾…」由引擎開啟系統原生對話框，直接取得引擎端路徑。沒有原生對話框的平台
          （<span className="mono">HTTP 501</span>）請改用瀏覽器上傳或把檔案拖進視窗：檔案會以原始位元組{' '}
          <span className="mono">POST /api/upload</span> 上傳，再自動走一次 probe ＋ 波形載入，因此波形、剪輯與匯出都看得到它。
        </p>
      </div>

      {/* ---------------- Waveform ---------------- */}
      <div className="panel">
        <h2>
          波形與時間軸
          {activeSource ? (
            <span className="muted" style={{ textTransform: 'none', fontWeight: 400 }}>
              {' '}
              — {activeSource.path}
            </span>
          ) : null}
        </h2>

        <WaveformCanvas
          peaks={peaks}
          durationSec={activeSource ? Math.max(0.001, activeSource.info.format.durationSec) : Math.max(0.001, duration)}
          playheadSec={state.playheadSec}
          selection={state.selection}
          markers={markers}
          onSeek={(sec) => dispatch({ type: 'playhead', sec })}
          onSelect={(range) => dispatch({ type: 'selection', range })}
          onNudgeSelection={nudgeSelection}
          onExtendSelection={extendSelection}
        />

        <div className="inline" style={{ marginTop: 8 }}>
          <label className="field">
            播放頭 (秒)
            <input
              type="number"
              step="0.01"
              min="0"
              value={Number(state.playheadSec.toFixed(3))}
              onChange={(e) => dispatch({ type: 'playhead', sec: Number(e.target.value) || 0 })}
              style={{ minWidth: 110 }}
            />
          </label>
          <span className="field">
            選取範圍
            <span className="mono">
              {state.selection
                ? `${state.selection.from.toFixed(2)} → ${state.selection.to.toFixed(2)}s`
                : '（在波形上拖曳以選取）'}
            </span>
          </span>
          <span className="field">
            時間軸總長
            <span className="mono">{duration.toFixed(3)}s</span>
          </span>
          {state.selection ? (
            <button onClick={() => dispatch({ type: 'selection', range: null })}>清除選取</button>
          ) : null}
        </div>
      </div>

      {/* ---------------- Edit toolbar ---------------- */}
      <div className="panel">
        <h2>編輯（全部只改 Timeline 資料）</h2>
        <div className="toolbar">
          <button onClick={() => apply(editSplit(state))} title="快捷鍵 S">
            切開 (S)
          </button>
          <button onClick={() => apply(editDeleteRange(state))}>刪除選取範圍</button>
          <button onClick={() => apply(editSilenceRange(state))}>靜音選取範圍</button>
          <button onClick={() => apply(editTrim(state))}>裁切至選取範圍</button>
          <button className="danger" onClick={() => apply(editRemoveClip(state))} disabled={!selected}>
            刪除選取的 clip
          </button>
          <span className="sep" />
          <button
            onClick={() => apply(editMoveClip(state, (selected ? state.timeline.clips.indexOf(selected) : 0) - 1))}
            disabled={!selected || state.timeline.clips.indexOf(selected) <= 0}
          >
            ◀ 前移
          </button>
          <button
            onClick={() => apply(editMoveClip(state, (selected ? state.timeline.clips.indexOf(selected) : 0) + 1))}
            disabled={!selected || state.timeline.clips.indexOf(selected) >= state.timeline.clips.length - 1}
          >
            後移 ▶
          </button>
          <span className="sep" />
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!canUndo} title="Ctrl+Z">
            ↶ 復原
          </button>
          <button onClick={() => dispatch({ type: 'redo' })} disabled={!canRedo} title="Ctrl+Y">
            ↷ 重做
          </button>
          <span className="mono tiny muted">
            歷史 {state.cursor + 1}/{state.history.length}
          </span>
        </div>

        {/* Per-clip trim + gain */}
        {selected ? (
          <div className="inline" style={{ marginTop: 10 }}>
            <span className="field">
              clip
              <span className="mono">{selected.label ?? selected.id}</span>
            </span>
            <label className="field">
              srcIn (秒)
              <input
                type="number"
                step="0.01"
                value={Number(selected.srcIn.toFixed(3))}
                onChange={(e) =>
                  apply(editTrimClip(state, selected.id, Number(e.target.value) || 0, selected.srcOut))
                }
                style={{ minWidth: 110 }}
              />
            </label>
            <label className="field">
              srcOut (秒)
              <input
                type="number"
                step="0.01"
                value={Number(selected.srcOut.toFixed(3))}
                onChange={(e) =>
                  apply(editTrimClip(state, selected.id, selected.srcIn, Number(e.target.value) || 0))
                }
                style={{ minWidth: 110 }}
              />
            </label>
            <span className="mono tiny muted">長度 {clipDuration(selected).toFixed(3)}s</span>
          </div>
        ) : null}
      </div>

      {/* ---------------- Clips ---------------- */}
      <div className="panel">
        <h2>Clips（{state.timeline.clips.length}）</h2>
        <TimelineTrack
          clips={state.timeline.clips}
          starts={starts}
          durationSec={Math.max(0.001, duration)}
          selectedClipId={state.selectedClipId}
          onSelect={(id) => dispatch({ type: 'selectClip', id })}
          onReorder={(id, toIndex) => apply(editMoveClipIn(state, id, toIndex))}
        />
        <div className="cliplist" style={{ marginTop: 8 }}>
          {state.timeline.clips.map((c, i) => {
            const s = starts.get(c.id) ?? 0;
            return (
              <div
                key={c.id}
                className={`cliprow ${c.id === state.selectedClipId ? 'selected' : ''}`}
                onClick={() => dispatch({ type: 'selectClip', id: c.id })}
              >
                <span className="mono tiny">{i + 1}</span>
                <span className="grow">{c.label ?? c.sourceId}</span>
                <span className="mono tiny muted">
                  {s.toFixed(2)}s · 長 {clipDuration(c).toFixed(2)}s · fx {c.effects.length}
                </span>
              </div>
            );
          })}
          {state.timeline.clips.length === 0 ? (
            <p className="hint">尚無 clip。</p>
          ) : null}
        </div>
        {Object.keys(state.sources).length > 1 ? (
          <div className="inline" style={{ marginTop: 8 }}>
            <label className="field">
              附加其他已載入來源
              <select
                onChange={(e) => {
                  if (e.target.value) apply(editAppendSource(state, e.target.value));
                  e.target.value = '';
                }}
                defaultValue=""
              >
                <option value="">— 選擇 —</option>
                {Object.values(state.sources).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </div>

      {/* ---------------- Playback ---------------- */}
      <div className="panel">
        <h2>播放</h2>
        {localUrl ? (
          <div className="col">
            <div className="hint">
              原始檔（<span className="mono">{actions.localFileName}</span>）— 瀏覽器直接播放，零延遲。
            </div>
            <audio ref={audioRef} src={localUrl} controls style={{ width: '100%' }} />
          </div>
        ) : (
          <p className="hint">
            尚未選擇本機檔案；下方仍可直接播放引擎端檔案，不需要先上傳。
          </p>
        )}

        {activeSource ? (
          <div className="col" style={{ marginTop: 10 }}>
            <div className="hint">
              引擎端檔案（<span className="mono">{activeSource.path}</span>）— 由{' '}
              <span className="mono">GET /api/file</span> 串流播放（瀏覽器無法直接讀取{' '}
              <span className="mono">C:\…</span>）。
            </div>
            <audio
              key={activeSource.path}
              src={api.fileUrl(activeSource.path)}
              controls
              preload="metadata"
              style={{ width: '100%' }}
              onError={() =>
                dispatch({
                  type: 'error',
                  message: `無法播放引擎端檔案：${activeSource.path}（GET /api/file 失敗或瀏覽器不支援此格式）。`,
                })
              }
            />
          </div>
        ) : null}

        <div className="inline" style={{ marginTop: 10 }}>
          <label className="field">
            試聽範圍
            <select
              value={previewRange ? 'selection' : 'all'}
              onChange={(e) => setPreviewRange(e.target.value === 'selection')}
            >
              <option value="all">整個時間軸</option>
              <option value="selection">目前選取範圍</option>
            </select>
          </label>
          <button
            className="primary"
            onClick={() =>
              void actions.preview(
                previewRange && state.selection
                  ? { startSec: state.selection.from, endSec: state.selection.to }
                  : null,
              )
            }
            disabled={actions.previewBusy}
          >
            {actions.previewBusy ? '產生中…' : '效果試聽（＝實際輸出）'}
          </button>
          <span className="pill">需 1–3 秒</span>
        </div>

        {actions.previewUrl ? (
          <audio src={actions.previewUrl} controls style={{ width: '100%', marginTop: 8 }} />
        ) : (
          <p className="hint">
            效果試聽會呼叫 <span className="mono">POST /api/preview</span>，由引擎實際渲染成 WAV 後回傳。
            因此它聽到的就是匯出結果，不是模擬。
          </p>
        )}
      </div>

      {/* ---------------- Render ---------------- */}
      <div className="panel">
        <h2>匯出</h2>
        <div className="inline">
          <label className="field">
            輸出檔案路徑
            <input
              value={outPath}
              placeholder={
                state.scratchRoot ? joinEnginePath(state.scratchRoot, 'export.mp3') : 'C:\\Out\\track.mp3'
              }
              onChange={(e) => setOutPath(e.target.value)}
              style={{ minWidth: 320 }}
            />
          </label>
          <button
            className="primary"
            onClick={() => void actions.render(outPath)}
            disabled={actions.renderBusy || state.timeline.clips.length === 0}
          >
            {actions.renderBusy ? '匯出中…' : '匯出'}
          </button>
          <span className="field">
            目前 preset
            <span className="mono">
              {state.exportPreset.container} / {state.exportPreset.codec} /{' '}
              {state.exportPreset.bitrateKbps ?? '無損'} · {state.exportPreset.sampleRate} Hz ·{' '}
              {state.exportPreset.channels}ch
            </span>
          </span>
        </div>
      </div>

      {/* ---------------- Library ---------------- */}
      <div className="panel">
        <h2>資料庫掃描（M2 前置）</h2>
        <div className="inline">
          <label className="field">
            來源資料夾
            <input
              value={rootInput}
              placeholder="D:\Music"
              onChange={(e) => setRootInput(e.target.value)}
              style={{ minWidth: 320 }}
            />
          </label>
          <button onClick={() => void actions.scanLibrary(rootInput)} disabled={actions.scanning}>
            {actions.scanning ? '掃描中…' : '掃描'}
          </button>
          <span className="mono tiny muted">{state.libraryEntries.length} 個檔案</span>
        </div>

        {state.libraryErrors.length > 0 ? (
          <details style={{ marginTop: 8 }}>
            <summary className="hint">{state.libraryErrors.length} 個掃描錯誤</summary>
            <table>
              <tbody>
                {state.libraryErrors.map((e) => (
                  <tr key={e.path}>
                    <td className="mono">{e.path}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}

        {state.libraryEntries.length > 0 ? (
          <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>檔案</th>
                  <th>格式</th>
                  <th>時長</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.libraryEntries.map((en) => (
                  <tr key={en.id}>
                    <td className="mono">{en.path}</td>
                    <td>{en.info.format.formatName}</td>
                    <td>{en.info.format.durationSec.toFixed(1)}s</td>
                    <td>
                      <button onClick={() => void actions.loadLibraryEntry(en)}>載入</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
