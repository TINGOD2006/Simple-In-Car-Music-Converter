/**
 * Shared UI context: state + dispatch + the async engine calls.
 *
 * Keeping the async calls in one object means every tab talks to the engine the
 * same way, and every rejection lands in `state.errors` (never an unhandled
 * promise, never a blank screen).
 */

import { createContext, useContext } from 'react';
import type { Dispatch } from 'react';
import type { Action, AppState } from './store.ts';
import type { LibraryEntry, PickMode } from './api-types.ts';

export interface BatchStartOptions {
  roots: string[];
  outputDir: string;
  filenamePattern: string;
  dedup: boolean;
  targetCapacityGb: number | null;
  loudnessEnabled: boolean;
  integratedLufs: number;
  truePeakDb: number;
}

export interface AppActions {
  /** Probe + waveform a single file and (optionally) replace the timeline with it. */
  loadPath: (path: string, replaceTimeline: boolean) => Promise<void>;
  /** Scan a folder via `GET /api/library`; resolves with what was found. */
  scanLibrary: (root: string) => Promise<LibraryEntry[]>;
  loadLibraryEntry: (entry: LibraryEntry) => Promise<void>;
  /**
   * Open the engine-side NATIVE dialog (`POST /api/pick`) and load the result:
   * files probe straight into the editor, a folder is scanned and its first
   * audio file is loaded. Falls back to upload on 501.
   */
  pickAndLoad: (mode: PickMode) => Promise<void>;
  /**
   * Upload browser-chosen files (`POST /api/upload`, raw bytes) and load the
   * paths the engine returns. Used by `<input type="file">` and drag & drop.
   */
  uploadFiles: (files: readonly File[]) => Promise<void>;
  /** Build a WAV of the current timeline via POST /api/preview and play it. */
  preview: (range?: { startSec: number; endSec: number } | null) => Promise<void>;
  /** Render the current timeline to `outputPath` via POST /api/render. */
  render: (outputPath: string) => Promise<void>;
  startBatch: (opts: BatchStartOptions) => Promise<void>;
  checkHealth: () => Promise<void>;
  refreshDenoise: () => Promise<void>;
  /** Local-file audition: object URL created in the browser, zero round trip. */
  setLocalFile: (file: File | null) => void;

  localFileName: string | null;
  previewUrl: string | null;
  previewBusy: boolean;
  renderBusy: boolean;
  scanning: boolean;
  /** A native dialog is open; block a second one (double-submit). */
  pickBusy: boolean;
  /** Uploads are in flight; disable the drop/upload affordances. */
  uploadBusy: boolean;
  /** A probe/waveform load is in flight. */
  probeBusy: boolean;
  /** True while a file drag hovers the window, for the drop highlight. */
  dragActive: boolean;
}

export interface AppCtxValue {
  state: AppState;
  dispatch: Dispatch<Action>;
  actions: AppActions;
}

export const AppContext = createContext<AppCtxValue | null>(null);

export function useApp(): AppCtxValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp() used outside <AppContext.Provider>');
  return v;
}
