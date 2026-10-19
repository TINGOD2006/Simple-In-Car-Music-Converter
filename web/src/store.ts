/**
 * Single source of UI state: a `useReducer` over Timeline + a snapshot history
 * stack (undo/redo), matching the engine's `History` semantics (commit discards the
 * redo branch; at least 20 steps are retained — we keep 100).
 *
 * Every edit action produces a NEW timeline object, exactly like `src/core/edl.ts`,
 * so a snapshot is just a reference. No audio work happens here.
 */

import type {
  BatchReport,
  Clip,
  ExportPreset,
  JobProgress,
  JobState,
  LibraryEntry,
  MediaInfo,
  Timeline,
} from './api-types.ts';
import {
  appendClips,
  clipStarts,
  clipDuration,
  clipsUsingSource,
  deleteRange,
  emptyTimeline,
  makeClip,
  moveClip,
  newId,
  removeClip,
  silenceRange,
  sourceToTimeline,
  split,
  timelineDuration,
  timelineToSource,
  trimToRange,
  updateClip,
} from './edits.ts';
import { makeEffect } from './effects-meta.ts';
import type { EffectType } from './api-types.ts';

export const HISTORY_LIMIT = 100;

export interface HistoryEntry {
  label: string;
  timeline: Timeline;
}

export interface LoadedSource {
  id: string;
  path: string;
  info: MediaInfo;
  peaks: number[];
}

export interface BatchUiState {
  running: boolean;
  jobId: string | null;
  state: JobState | null;
  progress: JobProgress | null;
  report: BatchReport | null;
  error: string | null;
}

/**
 * One surfaced failure.
 *
 * The banner used to hold a single `string`, so a burst of failures (three files
 * dropped at once, say) showed only the last one and the earlier ones vanished
 * without a trace. Every failure now gets its own dismissible row.
 */
export interface UiError {
  id: string;
  message: string;
  /** ISO timestamp, so a stale error is distinguishable from a fresh one. */
  at: string;
}

/** Cap on simultaneously listed errors — oldest are dropped, newest always shown. */
export const ERROR_LIST_LIMIT = 8;

export interface AppState {
  /**
   * Two reachable pages: the USB convert/normalise screen and the 下載 tab that
   * stocks it. The former editor/effects/batch members stay in the union because
   * `OnboardingPanel` still dispatches `'editor'`; they are unreachable from the
   * nav.
   */
  tab: 'usb' | 'download' | 'editor' | 'effects' | 'batch';
  timeline: Timeline;
  /** Snapshot stack; `cursor` indexes the current entry. */
  history: HistoryEntry[];
  cursor: number;
  sources: Record<string, LoadedSource>;
  selectedClipId: string | null;
  playheadSec: number;
  selection: { from: number; to: number } | null;
  /** Surfaced failures, newest last. Empty means nothing went wrong. */
  errors: UiError[];
  notice: string | null;
  engineOk: boolean | null;
  /** Engine scratch directory from `GET /api/health`, used to build temp paths. */
  scratchRoot: string | null;
  presetId: 'usb' | 'flac' | 'wav';
  exportPreset: ExportPreset;
  batch: BatchUiState;
  libraryRoot: string;
  libraryEntries: LibraryEntry[];
  libraryErrors: { path: string; message: string }[];
}

export type Action =
  | { type: 'tab'; tab: AppState['tab'] }
  /** `message: null` clears the list; a string appends one row. */
  | { type: 'error'; message: string | null }
  | { type: 'errorDismiss'; id: string }
  | { type: 'notice'; message: string | null }
  | { type: 'engineOk'; ok: boolean | null; scratchRoot?: string | null }
  | { type: 'loadSource'; source: LoadedSource; replaceTimeline: boolean }
  | { type: 'sourcePeaks'; sourceId: string; peaks: number[] }
  | { type: 'selectClip'; id: string | null }
  | { type: 'playhead'; sec: number }
  | { type: 'selection'; range: { from: number; to: number } | null }
  | { type: 'edit'; label: string; next: Timeline }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setPreset'; presetId: 'usb' | 'flac' | 'wav'; preset: ExportPreset }
  | { type: 'library'; root: string; entries: LibraryEntry[]; errors: { path: string; message: string }[] }
  | { type: 'batchStart'; jobId: string }
  | { type: 'batchProgress'; state: JobState; progress: JobProgress | null }
  | { type: 'batchReport'; report: BatchReport }
  | { type: 'batchError'; message: string }
  | { type: 'batchReset' };

function commit(state: AppState, label: string, next: Timeline): AppState {
  // Discard the redo branch, then push — the same rule as `History.commit`.
  const entries = state.history.slice(0, state.cursor + 1);
  entries.push({ label, timeline: next });
  while (entries.length > HISTORY_LIMIT) entries.shift();
  return { ...state, timeline: next, history: entries, cursor: entries.length - 1 };
}

export function initialState(): AppState {
  const timeline = emptyTimeline(44100, 2);
  return {
    tab: 'usb',
    timeline,
    history: [{ label: '初始', timeline }],
    cursor: 0,
    sources: {},
    selectedClipId: null,
    playheadSec: 0,
    selection: null,
    errors: [],
    notice: null,
    engineOk: null,
    scratchRoot: null,
    presetId: 'usb',
    exportPreset: {
      container: 'mp3',
      codec: 'libmp3lame',
      bitrateKbps: 320,
      sampleRate: 44100,
      channels: 2,
      loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
      id3v2Version: 3,
      denoise: 'gentle',
    },
    batch: { running: false, jobId: null, state: null, progress: null, report: null, error: null },
    libraryRoot: '',
    libraryEntries: [],
    libraryErrors: [],
  };
}

/** Range used by range-based edits; falls back to the whole timeline. */
function activeRange(state: AppState): { from: number; to: number } | null {
  if (state.selection && state.selection.to - state.selection.from > 1e-6) {
    return state.selection;
  }
  return null;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'tab':
      return { ...state, tab: action.tab };

    case 'error': {
      if (action.message === null) return { ...state, errors: [] };
      const message = action.message.trim();
      if (!message) return state;
      // Collapse an immediate repeat (a retry loop must not flood the banner).
      const last = state.errors[state.errors.length - 1];
      if (last && last.message === message) return state;
      const next = [...state.errors, { id: newId(), message, at: new Date().toISOString() }];
      while (next.length > ERROR_LIST_LIMIT) next.shift();
      return { ...state, errors: next };
    }

    case 'errorDismiss':
      return { ...state, errors: state.errors.filter((e) => e.id !== action.id) };

    case 'notice':
      return { ...state, notice: action.message };

    case 'engineOk':
      return {
        ...state,
        engineOk: action.ok,
        scratchRoot: action.scratchRoot ?? state.scratchRoot,
      };

    case 'sourcePeaks': {
      const src = state.sources[action.sourceId];
      if (!src) return state;
      return { ...state, sources: { ...state.sources, [action.sourceId]: { ...src, peaks: action.peaks } } };
    }

    case 'loadSource': {
      const sources = { ...state.sources, [action.source.id]: action.source };
      if (!action.replaceTimeline) {
        return { ...state, sources };
      }
      const dur = action.source.info.format.durationSec;
      const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 1;
      const clip = makeClip(action.source.id, 0, safeDur, basename(action.source.path));
      const timeline: Timeline = {
        clips: [clip],
        sampleRate: action.source.info.audio?.sampleRate ?? 44100,
        channels: (action.source.info.audio?.channels === 1 ? 1 : 2) as 1 | 2,
      };
      return commit(
        { ...state, sources, selectedClipId: clip.id, playheadSec: 0, selection: null },
        `載入 ${basename(action.source.path)}`,
        timeline,
      );
    }

    case 'selectClip':
      return { ...state, selectedClipId: action.id };

    case 'playhead':
      return { ...state, playheadSec: Math.max(0, action.sec) };

    case 'selection':
      return { ...state, selection: action.range };

    case 'setPreset':
      return { ...state, presetId: action.presetId, exportPreset: action.preset };

    case 'library':
      return {
        ...state,
        libraryRoot: action.root,
        libraryEntries: action.entries,
        libraryErrors: action.errors,
      };

    case 'edit':
      return commit(state, action.label, action.next);

    case 'undo': {
      if (state.cursor <= 0) return state;
      const cursor = state.cursor - 1;
      const entry = state.history[cursor]!;
      return { ...state, cursor, timeline: entry.timeline, playheadSec: clampPlayhead(state, entry.timeline) };
    }

    case 'redo': {
      if (state.cursor >= state.history.length - 1) return state;
      const cursor = state.cursor + 1;
      const entry = state.history[cursor]!;
      return { ...state, cursor, timeline: entry.timeline, playheadSec: clampPlayhead(state, entry.timeline) };
    }

    case 'batchStart':
      return {
        ...state,
        batch: { running: true, jobId: action.jobId, state: 'queued', progress: null, report: null, error: null },
      };

    case 'batchProgress':
      return {
        ...state,
        batch: { ...state.batch, state: action.state, progress: action.progress ?? state.batch.progress },
      };

    case 'batchReport':
      return {
        ...state,
        batch: { ...state.batch, running: false, state: 'done', report: action.report },
      };

    case 'batchError':
      return {
        ...state,
        batch: { ...state.batch, running: false, state: 'failed', error: action.message },
      };

    case 'batchReset':
      return { ...state, batch: initialState().batch };

    default:
      return state;
  }
}

function clampPlayhead(state: AppState, t: Timeline): number {
  return Math.min(state.playheadSec, timelineDuration(t));
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/* ------------------------------------------------------------------ */
/* Edit helpers — used by the editor UI, all pure data transforms       */
/* ------------------------------------------------------------------ */

export function editSplit(state: AppState): { label: string; next: Timeline } | null {
  const before = state.timeline.clips.length;
  const next = split(state.timeline, state.playheadSec);
  if (next.clips.length === before) return null;
  return { label: `切開 @ ${state.playheadSec.toFixed(2)}s`, next };
}

export function editDeleteRange(state: AppState): { label: string; next: Timeline } | null {
  const r = activeRange(state);
  if (!r) return null;
  const before = timelineDuration(state.timeline);
  const next = deleteRange(state.timeline, r.from, r.to);
  if (Math.abs(timelineDuration(next) - before) < 1e-9) return null;
  return { label: `刪除 ${r.from.toFixed(2)}–${r.to.toFixed(2)}s`, next };
}

export function editSilenceRange(state: AppState): { label: string; next: Timeline } | null {
  const r = activeRange(state);
  if (!r) return null;
  const next = silenceRange(state.timeline, r.from, r.to);
  if (next === state.timeline) return null;
  return { label: `靜音 ${r.from.toFixed(2)}–${r.to.toFixed(2)}s`, next };
}

export function editTrim(state: AppState): { label: string; next: Timeline } | null {
  const r = activeRange(state);
  if (!r) return null;
  const next = trimToRange(state.timeline, r.from, r.to);
  if (next.clips.length === state.timeline.clips.length) return null;
  return { label: `裁切至 ${r.from.toFixed(2)}–${r.to.toFixed(2)}s`, next };
}

export function editRemoveClip(state: AppState): { label: string; next: Timeline } | null {
  if (!state.selectedClipId) return null;
  const next = removeClip(state.timeline, state.selectedClipId);
  if (next.clips.length === state.timeline.clips.length) return null;
  return { label: '刪除 clip', next };
}

export function editMoveClip(state: AppState, toIndex: number): { label: string; next: Timeline } | null {
  if (!state.selectedClipId) return null;
  const next = moveClip(state.timeline, state.selectedClipId, toIndex);
  if (next === state.timeline) return null;
  return { label: '移動 clip', next };
}

export function editAppendSource(state: AppState, sourceId: string): { label: string; next: Timeline } | null {
  const src = state.sources[sourceId];
  if (!src) return null;
  const dur = src.info.format.durationSec;
  const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 1;
  const clip = makeClip(sourceId, 0, safeDur, basename(src.path));
  return { label: '附加 clip', next: appendClips(state.timeline, [clip]) };
}

export function editTrimClip(
  state: AppState,
  clipId: string,
  srcIn: number,
  srcOut: number,
): { label: string; next: Timeline } | null {
  if (!(srcOut > srcIn)) return null;
  const next = updateClip(state.timeline, clipId, { srcIn, srcOut });
  return { label: '調整 clip 範圍', next };
}

export function editAddEffect(
  state: AppState,
  clipId: string,
  type: EffectType,
): { label: string; next: Timeline } | null {
  const next = updateClip(state.timeline, clipId, (c) => ({
    effects: [...c.effects, makeEffect(type)],
  }));
  return { label: `加入效果 ${type}`, next };
}

export function editRemoveEffect(
  state: AppState,
  clipId: string,
  effectId: string,
): { label: string; next: Timeline } | null {
  const next = updateClip(state.timeline, clipId, (c) => ({
    effects: c.effects.filter((e) => e.id !== effectId),
  }));
  return { label: '移除效果', next };
}

export function editUpdateEffect(
  state: AppState,
  clipId: string,
  effectId: string,
  patch: Record<string, unknown>,
): { label: string; next: Timeline } | null {
  const next = updateClip(state.timeline, clipId, (c) => ({
    effects: c.effects.map((e) => (e.id === effectId ? ({ ...e, ...patch } as typeof e) : e)),
  }));
  return { label: '調整效果參數', next };
}

export function editToggleEffect(
  state: AppState,
  clipId: string,
  effectId: string,
): { label: string; next: Timeline } | null {
  const next = updateClip(state.timeline, clipId, (c) => ({
    effects: c.effects.map((e) => (e.id === effectId ? { ...e, enabled: !e.enabled } : e)),
  }));
  return { label: '切換效果', next };
}

export function editClipGain(
  state: AppState,
  clipId: string,
  gainDb: number,
): { label: string; next: Timeline } | null {
  const next = updateClip(state.timeline, clipId, { gainDb });
  return { label: '調整 clip 增益', next };
}

/**
 * Fades and crossfade are real engine fields (`afade`, `acrossfade`) that the UI
 * previously never exposed, so every clip was stuck with zero fades. Values are
 * clamped to the clip's own duration: a fade longer than the clip is meaningless
 * and the compiler would silently shorten it.
 */
export function editClipFades(
  state: AppState,
  clipId: string,
  patch: Partial<Pick<Clip, 'fadeInSec' | 'fadeOutSec' | 'crossfadeInSec'>>,
): { label: string; next: Timeline } | null {
  const clip = state.timeline.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const d = clipDuration(clip);
  const clean: Partial<Clip> = {};
  if (patch.fadeInSec !== undefined) clean.fadeInSec = clampNum(patch.fadeInSec, 0, d);
  if (patch.fadeOutSec !== undefined) clean.fadeOutSec = clampNum(patch.fadeOutSec, 0, d);
  if (patch.crossfadeInSec !== undefined) clean.crossfadeInSec = clampNum(patch.crossfadeInSec, 0, d);
  const next = updateClip(state.timeline, clipId, clean);
  return { label: '調整淡入淡出', next };
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Clip start times, exported for the timeline view. */
export {
  clipStarts,
  clipDuration,
  clipsUsingSource,
  timelineDuration,
  timelineToSource,
  sourceToTimeline,
  moveClip,
  removeClip,
  split,
  deleteRange,
  silenceRange,
};
export { newId };
