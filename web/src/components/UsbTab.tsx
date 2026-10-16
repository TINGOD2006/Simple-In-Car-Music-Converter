/**
 * USB page — the app's single screen.
 *
 * The user's brief: no audio *editing*. Choose a USB drive / folder as the
 * workspace, list what is on it (name, format, duration, folder, loudness), and
 * convert + loudness-normalise the whole thing in place.
 *
 * The page is carried by four engine calls:
 *   - `POST /api/pick` (engine-side native folder dialog) then `GET /api/library`
 *     for the listing. `POST /api/upload` + a re-scan of the engine's upload folder
 *     is the fallback when the platform has no native dialog.
 *   - `GET /api/measure` once per row, two at a time, so the table is already
 *     usable while the loudness column fills in.
 *   - `POST /api/batch` + `GET /api/jobs/:id` for the conversion job.
 *
 * TWO ENGINE FACTS THAT SHAPE THIS PAGE (both verified in the engine source, which
 * this package may not edit — `src/` is outside its write scope):
 *
 *  1. `/api/batch` is DIRECTORY-scoped (`roots`/`dir`, `src/core/library.ts`
 *     `readdirSync`s every root, so a file path as a root is ENOTDIR), but it also
 *     accepts an `includePaths` filter. `src/core/batch.ts:246` resolves and
 *     lower-cases both sides and keeps only the listed files, so the tick-boxes ARE
 *     authoritative: an unticked row is never read or written. `includePaths` was
 *     added to the engine after this page was first drafted; the earlier version of
 *     this file passed no filter and had to warn that every file would be converted.
 *  2. Overwrite mode stages, verifies, then atomically renames over the target, and
 *     the output NAME comes from the engine's default pattern `{artist} - {title}`
 *     (`src/core/batch.ts:232`), so a file can be renamed as well as re-encoded.
 *     The page therefore sends `preserveNames: true` (see `api-types.ts`), because
 *     a conversion UI must not silently reshuffle the user's filenames.
 *  3. Files are listed flat by `/api/library`; the user's real workspace is 199
 *     files under `Anime OST\<show>`, `JPOP\<artist>`, `Miku\`… The table is
 *     therefore GROUPED by containing folder, one collapsible header per folder
 *     with its own tri-state tick-box.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent as ReactDragEvent } from 'react';
import { api, isNoNativeDialog } from '../api.ts';
import type {
  BatchReport,
  BatchReportItem,
  JobProgress,
  LibraryEntry,
  MediaInfo,
  ScanError,
} from '../api-types.ts';
import { DEFAULT_PRESET_ID, PRESETS, choiceById, presetById } from '../presets.ts';
import type { PresetChoice } from '../presets.ts';
import { collectDroppedFiles, dropHasFiles, extensionOf } from '../file-intake.ts';
import { useApp } from '../app-context.ts';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** The standard every row is compared against — every preset targets the same. */
const TARGET_LUFS = -14;
/** "Already at standard" tolerance: |lufs − (−14)| ≤ 1.5. */
const CONFORM_TOLERANCE_LUFS = 1.5;
/**
 * Measuring a file is one ffmpeg pass (~0.2–0.5 s). Two in flight keeps a large
 * library responsive without spawning a process per file all at once.
 */
const MEASURE_CONCURRENCY = 2;
const POLL_MS = 800;
/** Cap on listed scan failures, so one hostile folder cannot fill the page. */
const MAX_LISTED_SCAN_ERRORS = 12;
/** How long 「已複製」 stays on screen before the button reverts. */
const COPY_FEEDBACK_MS = 2400;

/** The export targets the picker offers; `usb` (MP3) is the default. */
type TargetId = PresetChoice['id'];

/**
 * Which target formats are LOSSY, read straight off each preset. Only a lossy target
 * can lose a lossless source's data, so the 「無損→有損」 warning (and the default of
 * NOT ticking such a row) applies to lossy targets alone. FLAC and WAV are lossless:
 * re-encoding a FLAC into them is not a destructive one-way door, so those rows
 * default to checked.
 *
 * Derived rather than hand-listed: a new preset cannot silently inherit the wrong
 * kind, and `test/presets.test.ts` pins `PresetChoice.lossy` against the engine's
 * own `isLossy()` so the two definitions cannot drift apart.
 */
const TARGET_IS_LOSSY: Record<TargetId, boolean> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p.lossy]),
) as Record<TargetId, boolean>;

/** 「MP3 320 kbps / 44.1 kHz」-style summary of what the chosen preset really is. */
function targetSpecText(id: TargetId): string {
  const preset = presetById(id);
  const rate = formatSampleRate(preset.sampleRate) ?? `${preset.sampleRate} Hz`;
  return preset.bitrateKbps === null
    ? `${preset.container.toUpperCase()} / ${rate}`
    : `${preset.container.toUpperCase()} ${preset.bitrateKbps} kbps / ${rate}`;
}

/**
 * Containers whose content is lost for good once converted to MP3. Rows carrying
 * one of these extensions are never checked by default.
 */
const LOSSLESS_EXTENSIONS: readonly string[] = [
  'flac',
  'wav',
  'wave',
  'aiff',
  'aif',
  'aifc',
  'alac',
  'ape',
  'wv',
  'tta',
  'dsf',
  'dff',
];
const LOSSLESS = new Set(LOSSLESS_EXTENSIONS);

/* ------------------------------------------------------------------ */
/* Row model                                                           */
/* ------------------------------------------------------------------ */

type Loudness =
  | { kind: 'pending' }
  | { kind: 'ok'; lufs: number; truePeakDb: number }
  | { kind: 'failed' };

type Outcome = { kind: 'done' } | { kind: 'failed'; message: string };

interface Row {
  path: string;
  name: string;
  /** `MP3 · 44.1 kHz` — codec plus sample rate when the probe reported one. */
  format: string;
  durationSec: number;
  /** Containing folder, expressed relative to the workspace root (`/Album1`). */
  folder: string;
  lossless: boolean;
  /**
   * The source's sample rate, kept so the target-dependent rules can be re-evaluated
   * when the user switches format — the displayed `format` string is not enough.
   */
  sampleRate: number | null;
  /**
   * Already in the TARGET's container at the TARGET's sample rate — the half of the
   * "already conforms" rule that the scan alone can answer. It is target-dependent,
   * so changing the target re-evaluates it.
   */
  atTargetFormat: boolean;
  loudness: Loudness;
  /** In the target format AND within tolerance of the target. Needs a measurement. */
  conforms: boolean;
  checked: boolean;
  /** The user (or 全選 / 全不選) set this checkbox; defaults must not override it. */
  touched: boolean;
  /** What the last batch run reported for this path, if anything. */
  outcome: Outcome | null;
}

interface JobUi {
  id: string | null;
  running: boolean;
  progress: JobProgress | null;
  error: string | null;
  /** `成功 12、失敗 1` once the run settles. */
  summary: string | null;
}

const IDLE_JOB: JobUi = { id: null, running: false, progress: null, error: null, summary: null };

/* ------------------------------------------------------------------ */
/* Small pure helpers (path/format presentation)                        */
/* ------------------------------------------------------------------ */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Parent directory, keeping the separator style the engine used. */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 0 ? '' : p.slice(0, i);
}

/** Case-insensitive key for matching a report row back onto a table row. */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * The containing folder relative to the workspace root: `D:\USB\Album1\a.mp3`
 * under `D:\USB` reads as `/Album1` instead of the full absolute path. A file
 * outside the root (or directly inside it) falls back to what it really is.
 */
function relativeFolder(filePath: string, root: string): string {
  const parent = dirnameOf(filePath).replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base) {
    const lowerParent = parent.toLowerCase();
    const lowerBase = base.toLowerCase();
    if (lowerParent === lowerBase) return '/';
    if (lowerParent.startsWith(`${lowerBase}/`)) return parent.slice(base.length);
  }
  return parent || '/';
}

function formatSampleRate(hz: number | undefined): string | null {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) return null;
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
}

/**
 * Folder heading text for a group: `row.folder` without the leading slash and
 * with Windows separators, so `Anime OST\Bocchi the rock` reads like the path the
 * user sees in Explorer. Rows sitting directly in the workspace root get a label
 * instead of an empty heading.
 */
function folderLabel(folder: string): string {
  const trimmed = folder.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '\\');
  return trimmed || '（工作區根目錄）';
}

/** The folder a row's file lives in, for the 「開啟檔案位置」 fallback. */
function parentFolderOf(path: string): string {
  return dirnameOf(path) || path;
}

function describeFormat(info: MediaInfo): string {
  const codec = info.audio?.codecName;
  const label = (codec && codec.trim() ? codec : info.format.formatName).trim().toUpperCase();
  const rate = formatSampleRate(info.audio?.sampleRate);
  return rate ? `${label} · ${rate}` : label;
}

/** `m:ss`, rounded — the brief's duration format. */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** One decimal place, with a real minus sign so it does not read as a hyphen. */
function dbText(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(1).replace('-', '−');
}

function loudnessCell(l: Loudness): { text: string; title: string | undefined } {
  if (l.kind === 'pending') return { text: '測量中…', title: undefined };
  // 404/422 must NEVER render as 0 — that would look like silence, not a failure.
  if (l.kind === 'failed') return { text: '無法量測', title: undefined };
  return { text: `${dbText(l.lufs)} LUFS`, title: `真峰值 ${dbText(l.truePeakDb)} dBTP` };
}

/**
 * Why a row is scheduled for conversion — the ONE rule, used at scan time, after
 * every measurement, and again whenever the target format changes.
 *
 * A default tick means: "this conversion can plausibly make things better". Only
 * the source kind (`Row.lossless`) and the target kind (`TARGET_IS_LOSSY`) decide
 * it:
 *
 * | source   | target   | default tick | why this is the answer                    |
 * |----------|----------|--------------|-------------------------------------------|
 * | lossy    | lossy    | tick         | a different bitrate can genuinely raise quality |
 * | lossless | lossless | tick         | repacking into a cheaper lossless container saves space |
 * | lossless | lossy    | NO tick      | irreversible quality loss — the user must ask for it |
 * | lossy    | lossless | NO tick      | bigger file (2–4×), zero gain — the user must ask for it |
 *
 * The bottom two rows are the SAME principle mirrored: a conversion we would not
 * recommend is never ticked by default, and `overwrite` makes both irreversible
 * (the source file is gone either way). A file that already `conforms` needs no
 * work, so it is never ticked either.
 *
 * THIS TABLE IS THE SPEC. Change the table first, then the code under it.
 * `touched` still beats all of this — a deliberate choice is never overwritten.
 */
type ConversionVerdict =
  | 'raise-quality' // lossy    → lossy    : can help, ticked
  | 'repack' //        lossless → lossless : can help, ticked
  | 'degrade' //       lossless → lossy    : flagged ⚠, NOT ticked
  | 'no-gain' //       lossy    → lossless : flagged ⚠, NOT ticked
  | 'conforms'; //     nothing to do        : NOT ticked

function conversionVerdict(row: Row, targetIsLossy: boolean): ConversionVerdict {
  if (row.conforms) return 'conforms';
  if (row.lossless) return targetIsLossy ? 'degrade' : 'repack';
  return targetIsLossy ? 'raise-quality' : 'no-gain';
}

/** The two "do not do this by default" cases — exactly the ⚠ rows. */
function isFlaggedConversion(row: Row, targetIsLossy: boolean): boolean {
  const verdict = conversionVerdict(row, targetIsLossy);
  return verdict === 'degrade' || verdict === 'no-gain';
}

function defaultChecked(row: Row, targetIsLossy: boolean): boolean {
  const verdict = conversionVerdict(row, targetIsLossy);
  return verdict === 'raise-quality' || verdict === 'repack';
}

/** Is this file already in the target's container at the target's sample rate? */
function atTargetFormatOf(row: Row, target: PresetChoice): boolean {
  return extensionOf(row.path) === target.extension && row.sampleRate === target.make().sampleRate;
}

/**
 * Re-derive everything about a row that depends on WHICH target is selected.
 *
 * An MP3 at 44.1 kHz already conforms for the MP3 target and does not for FLAC, so
 * both `atTargetFormat` and `conforms` have to be recomputed whenever the target
 * changes — not just the default tick.
 */
function retarget(row: Row, target: PresetChoice): Row {
  const atTargetFormat = atTargetFormatOf(row, target);
  const conforms =
    atTargetFormat &&
    row.loudness.kind === 'ok' &&
    Math.abs(row.loudness.lufs - TARGET_LUFS) <= CONFORM_TOLERANCE_LUFS;
  return { ...row, atTargetFormat, conforms };
}

function rowFromEntry(entry: LibraryEntry, root: string, target: PresetChoice): Row {
  const ext = extensionOf(entry.path);
  const lossless = LOSSLESS.has(ext);
  const info = entry.info;
  const base: Row = {
    path: entry.path,
    name: basenameOf(entry.path),
    format: describeFormat(info),
    durationSec: info.format.durationSec,
    folder: relativeFolder(entry.path, root),
    lossless,
    sampleRate: info.audio?.sampleRate ?? null,
    atTargetFormat: false,
    loudness: { kind: 'pending' },
    conforms: false,
    // Placeholder only — overwritten by `defaultChecked` on the very next line.
    // `touched` keeps every later default from fighting the user.
    checked: !lossless,
    touched: false,
    outcome: null,
  };
  const next = retarget(base, target);
  return { ...next, checked: defaultChecked(next, target.lossy) };
}

/** Apply a measurement, then re-evaluate the default unless the user has spoken. */
function withMeasurement(row: Row, loudness: Loudness, target: PresetChoice): Row {
  const next = retarget({ ...row, loudness }, target);
  return { ...next, checked: row.touched ? row.checked : defaultChecked(next, target.lossy) };
}

function statusText(row: Row, jobRunning: boolean, targetIsLossy: boolean): string {
  if (row.outcome) {
    return row.outcome.kind === 'done' ? '完成' : `失敗：${row.outcome.message}`;
  }
  if (jobRunning) return '處理中';
  // Mirrors the default-tick table above, so the ⚠ text and the tick can never
  // disagree about the same row.
  switch (conversionVerdict(row, targetIsLossy)) {
    case 'degrade':
      return '⚠ 無損→有損';
    case 'no-gain':
      return '⚠ 有損→無損無益';
    case 'conforms':
      return '已達標';
    default:
      return '待處理';
  }
}

/**
 * Whether this row needs the 「開啟檔案位置」 shortcut: exactly the rows the user
 * is being warned about (either kind of conversion we refuse to default to) or that
 * already failed — in both cases they want to go look at the file.
 */
function needsFolderShortcut(row: Row, jobRunning: boolean, targetIsLossy: boolean): boolean {
  if (row.outcome) return row.outcome.kind === 'failed';
  if (jobRunning) return false;
  return isFlaggedConversion(row, targetIsLossy);
}

function statusClass(row: Row, jobRunning: boolean, targetIsLossy: boolean): string {
  if (row.outcome) return row.outcome.kind === 'done' ? 'usb-done' : 'usb-failed';
  if (jobRunning) return '';
  return isFlaggedConversion(row, targetIsLossy) ? 'usb-warn' : '';
}

/* ------------------------------------------------------------------ */
/* Folder groups + per-row widgets                                     */
/* ------------------------------------------------------------------ */

/**
 * One collapsible folder in the list. `rows` are the SAME objects the flat list
 * held, kept in scan order; the grouping only partitions them, it never copies or
 * re-sorts a row.
 */
interface FolderGroup {
  /** `row.folder` — the relative, forward-slash key the group shares. */
  key: string;
  /** Heading text, e.g. `Anime OST\Bocchi the rock`. */
  label: string;
  rows: Row[];
  checked: number;
}

/**
 * A tick-box that can ALSO show the "some of this folder is selected" state. The
 * DOM's `indeterminate` flag has no JSX attribute, so it is written through a ref
 * callback — which React re-invokes on every render of this component.
 */
function FolderCheckbox(props: {
  checked: boolean;
  partial: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const { checked, partial, disabled, label, onChange } = props;
  return (
    <input
      type="checkbox"
      className="usb-group-check"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      ref={(el) => {
        if (el) el.indeterminate = !checked && partial;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

type RevealState = 'idle' | 'opening' | 'opened' | 'copied' | 'failed';

/**
 * 「開啟檔案位置」 — the answer to "the warning told me a file is about to be
 * degraded, where is it?".
 *
 * Opening the OS file manager with the file already selected is the whole point:
 * the user is being warned about a SPECIFIC file, and a folder path they have to
 * retype into Explorer is a path they will get wrong. So the button tries, in
 * order:
 *
 *   1. `POST /api/reveal` — opens the file manager at that file (engine-side, so
 *      it works even when the page is in a plain browser).
 *   2. Copy the folder path to the clipboard, for the environments with no file
 *      manager (a non-Windows engine, or a headless session).
 *   3. Render the path as selectable text, so a failed copy never leaves the user
 *      with a dead button and no way to find the file.
 *
 * Step 1 failing must NOT be reported as an error: `reveal` resolves false for
 * "this platform has no file manager", which is a degraded feature rather than a
 * fault, and the fallback has already answered the user's question.
 */
function RevealFileButton({ path, dir }: { path: string; dir: string }): JSX.Element | null {
  const [state, setState] = useState<RevealState>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  if (!path && !dir) return null;

  const flash = (next: RevealState): void => {
    setState(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setState('idle');
    }, COPY_FEEDBACK_MS);
  };

  /** Clipboard is the fallback route, so its failure is reported separately. */
  const copyDir = async (): Promise<boolean> => {
    try {
      // `navigator.clipboard` needs a secure context and is simply absent in
      // some embeddings — that is a normal failure, not an exception to leak.
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        return false;
      }
      await navigator.clipboard.writeText(dir || path);
      return true;
    } catch {
      return false;
    }
  };

  const reveal = (): void => {
    void (async () => {
      setState('opening');
      if (path && (await api.reveal(path))) {
        flash('opened');
        return;
      }
      flash((await copyDir()) ? 'copied' : 'failed');
    })();
  };

  const label =
    state === 'opening'
      ? '開啟中…'
      : state === 'opened'
        ? '已開啟'
        : state === 'copied'
          ? '已複製路徑'
          : state === 'failed'
            ? '找不到位置'
            : '開啟檔案位置';

  return (
    <span className="usb-copy">
      <button
        type="button"
        className="usb-copy-btn"
        onClick={reveal}
        disabled={state === 'opening'}
        title={`在檔案總管中顯示：${path || dir}`}
        aria-label={`開啟檔案位置 ${path || dir}`}
      >
        {label}
      </button>
      {state === 'failed' ? (
        <span className="mono usb-copy-fallback" title="請手動選取這段路徑">
          {path || dir}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function UsbTab(): JSX.Element {
  const { state, dispatch } = useApp();

  const [root, setRoot] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [scanErrors, setScanErrors] = useState<ScanError[]>([]);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [job, setJob] = useState<JobUi>(IDLE_JOB);
  const [dropArmed, setDropArmed] = useState(false);
  /** Target format the batch will be encoded to. MP3 (the USB preset) by default. */
  const [target, setTarget] = useState<TargetId>('usb');
  /** Folders the user has collapsed, by group key. Not persisted, by design. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  /** Mirrors for the async callbacks, which must not capture a stale render. */
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const rootRef = useRef('');
  rootRef.current = root;
  /**
   * The CURRENT target, readable from an async continuation. Measurements land long
   * after the click that changed the target, so the rules they re-apply
   * (`withMeasurement`'s default tick, and whether the file is already in the target
   * format at all) must see the target in force NOW, not the one captured when the
   * measurement started.
   */
  const targetChoiceRef = useRef(choiceById(DEFAULT_PRESET_ID));
  targetChoiceRef.current = choiceById(target);

  /** Bumped by every scan: a measurement in flight for an older listing is dropped. */
  const generationRef = useRef(0);
  const pollRef = useRef<number | null>(null);
  const pickingRef = useRef(false);
  /**
   * One job settles exactly once: the poll interval never waits for the previous
   * response, so two requests can be in flight and the late one would otherwise
   * re-report the same finished job and trigger a second re-scan.
   */
  const settledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      stopPolling();
      generationRef.current += 1;
    },
    [stopPolling],
  );

  /* ---------------------------------------------------------------- */
  /* Scanning                                                          */
  /* ---------------------------------------------------------------- */

  const scanRoot = useCallback(
    async (dir: string): Promise<Row[]> => {
      // Any measurement still running belongs to the previous listing.
      generationRef.current += 1;
      setScanning(true);
      setScanErrors([]);
      try {
        const res = await api.library(dir);
        const entries = res.entries ?? [];
        const errors = res.errors ?? [];
        const next = entries.map((e) => rowFromEntry(e, dir, targetChoiceRef.current));
        setRows(next);
        setScanErrors(errors);
        dispatch({
          type: 'notice',
          message: `掃描完成：${next.length} 個音訊檔${errors.length > 0 ? `，${errors.length} 個無法讀取` : ''}`,
        });
        return next;
      } catch (err) {
        setRows([]);
        dispatch({ type: 'error', message: `掃描失敗：${errText(err)}` });
        return [];
      } finally {
        setScanning(false);
      }
    },
    [dispatch],
  );

  /* ---------------------------------------------------------------- */
  /* Background loudness measurement (2 at a time)                     */
  /* ---------------------------------------------------------------- */

  const measureRows = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    const queue = [...paths];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (generationRef.current !== generation) return;
        const index = cursor;
        cursor += 1;
        const path = queue[index];
        if (path === undefined) return;

        let loudness: Loudness;
        try {
          const measured = await api.measure(path);
          loudness = { kind: 'ok', lufs: measured.lufs, truePeakDb: measured.truePeakDb };
        } catch {
          // 404 / 422 / transport failure: the CELL says 無法量測. A per-row
          // failure is not an error-banner event and must not stop the queue.
          loudness = { kind: 'failed' };
        }

        if (generationRef.current !== generation) return;
        setRows((prev) =>
          prev.map((r) => (r.path === path ? withMeasurement(r, loudness, targetChoiceRef.current) : r)),
        );
      }
    };

    void Promise.all(
      Array.from({ length: MEASURE_CONCURRENCY }, () => worker()),
    );
  }, []);

  /* ---------------------------------------------------------------- */
  /* Workspace pickers                                                 */
  /* ---------------------------------------------------------------- */

  const pickFolder = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      const res = await api.pick({ mode: 'folder', title: '選擇 USB／工作資料夾' });
      const dir = (res.paths ?? []).find((p) => typeof p === 'string' && p.trim().length > 0);
      // An empty `paths` is a cancelled dialog, not a failure.
      if (!dir) return;
      setRoot(dir);
      setFallbackNote(null);
      const next = await scanRoot(dir);
      measureRows(next.map((r) => r.path));
    } catch (err) {
      if (isNoNativeDialog(err)) {
        // Degrade silently: the drag/upload path below is fully usable.
        setFallbackNote(
          '此平台沒有原生資料夾對話框，請改用下面的拖放／瀏覽器選擇：' +
            '檔案會先上傳到引擎的暫存資料夾，再以該資料夾為工作區。',
        );
      } else {
        dispatch({ type: 'error', message: `選擇資料夾失敗：${errText(err)}` });
      }
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [dispatch, measureRows, scanRoot]);

  /**
   * Upload-based intake: the only route that works without a native dialog. The
   * uploaded copies live in the engine's own download folder, so the workspace
   * becomes that folder — and the user's originals are never touched.
   */
  const adoptFiles = useCallback(
    async (files: readonly File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploading(true);
      const uploaded: string[] = [];
      const failures: string[] = [];
      try {
        for (const file of list) {
          try {
            const res = await api.upload(file);
            if (res.path) uploaded.push(res.path);
            else failures.push(`${file.name}：引擎未回傳檔案路徑`);
          } catch (err) {
            failures.push(`${file.name}：${errText(err)}`);
          }
        }
      } finally {
        setUploading(false);
      }

      if (failures.length > 0) {
        dispatch({ type: 'error', message: `上傳失敗（${failures.length} 個）：${failures.join('；')}` });
      }

      const first = uploaded[0];
      if (!first) return;
      const dir = dirnameOf(first);
      setRoot(dir);
      setFallbackNote(
        `工作區是引擎的暫存上傳資料夾（${dir}）：清單列出該資料夾內所有音訊檔，` +
          '就地轉換只會取代這些副本，你原本磁碟上的檔案不會被覆寫。',
      );
      const next = await scanRoot(dir);
      measureRows(next.map((r) => r.path));
    },
    [dispatch, measureRows, scanRoot],
  );

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  const toggleRow = useCallback((path: string) => {
    setRows((prev) =>
      prev.map((r) => (r.path === path ? { ...r, checked: !r.checked, touched: true } : r)),
    );
  }, []);

  /** 全選 / 全不選 are deliberate user actions, so they set `touched` too. */
  const setAllChecked = useCallback((checked: boolean) => {
    setRows((prev) => prev.map((r) => ({ ...r, checked, touched: true })));
  }, []);

  /**
   * 全選未達標: tick every row that is not already 已達標, and untick the ones that
   * are. This is the toolbar's selective counterpart to the header's 全選 — the point
   * of it is that pressing it leaves the files needing nothing alone.
   *
   * It deliberately INCLUDES the two ⚠ verdicts (`無損→有損`, `有損→無損無益`) that the
   * default tick refuses to make for the user. Pressing the button is that user
   * saying "yes, those too", which is exactly why it is a button and not a default.
   */
  const setAllUnmetChecked = useCallback(() => {
    setRows((prev) => prev.map((r) => ({ ...r, checked: !r.conforms, touched: true })));
  }, []);

  /**
   * One folder's header tick-box. A single `map` over the flat list — the rows are
   * keyed by their own `folder`, so this is O(n) and never compares groups to rows.
   */
  const setFolderChecked = useCallback((key: string, checked: boolean) => {
    setRows((prev) =>
      prev.map((r) => (r.folder === key ? { ...r, checked, touched: true } : r)),
    );
  }, []);

  const toggleFolderCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Switch the export target. The warning and the default ticks are DERIVED from
   * the target, so this cannot be a display-only switch: every row the user has not
   * personally touched has its default recomputed here, immediately. Rows the user
   * ticked or unticked by hand keep that decision (`touched`).
   */
  const chooseTarget = useCallback((id: TargetId) => {
    const choice = choiceById(id);
    // Readable before React re-renders: a measurement may land in between.
    targetChoiceRef.current = choice;
    setTarget(id);
    setRows((prev) =>
      prev.map((r) => {
        // `atTargetFormat` and `conforms` move with the target, not just the tick.
        const next = retarget(r, choice);
        return r.touched ? next : { ...next, checked: defaultChecked(next, choice.lossy) };
      }),
    );
  }, []);

  const rescan = useCallback(async () => {
    const dir = rootRef.current;
    if (!dir) return;
    const next = await scanRoot(dir);
    measureRows(next.map((r) => r.path));
  }, [measureRows, scanRoot]);

  /* ---------------------------------------------------------------- */
  /* Batch job                                                         */
  /* ---------------------------------------------------------------- */

  const finishJob = useCallback(
    async (report: BatchReport | null, error: string | null) => {
      stopPolling();
      // A second poll response can land after this job is already settled.
      if (settledRef.current) return;
      settledRef.current = true;

      if (!report) {
        setJob((prev) => ({ ...prev, running: false, error: error ?? '工作完成但引擎未回傳報告。' }));
        return;
      }

      // Successful overwrite rows report the REPLACED path as `outputPath`; when a
      // rename happened that is also what the next scan will show. `sourcePath` is
      // the secondary key so a row whose name changed still gets its verdict.
      const byPath = new Map<string, BatchReportItem>();
      for (const item of report.items) {
        if (item.outputPath) byPath.set(pathKey(item.outputPath), item);
        byPath.set(pathKey(item.sourcePath), item);
      }

      const mapped = rowsRef.current.map((row) => {
        const item = byPath.get(pathKey(row.path));
        if (!item) return row;
        if (item.status === 'ok') return { ...row, outcome: { kind: 'done' as const } };
        if (item.status === 'failed') {
          const problems = item.verify && !item.verify.ok ? item.verify.problems.join('；') : '';
          return {
            ...row,
            outcome: {
              kind: 'failed' as const,
              message: item.message ?? (problems || '引擎未提供原因'),
            },
          };
        }
        // 'skipped' was never processed: leave the row's own status alone.
        return row;
      });
      setRows(mapped);

      const count = (status: BatchReportItem['status']): number =>
        report.items.filter((i) => i.status === status).length;
      const okCount = count('ok');
      const failedCount = count('failed');
      const skippedCount = count('skipped');
      setJob((prev) => ({
        ...prev,
        running: false,
        error,
        summary: `本次處理：成功 ${okCount}、失敗 ${failedCount}${skippedCount > 0 ? `、略過 ${skippedCount}` : ''}。`,
      }));

      // Re-scan so format/duration/loudness reflect the files that are on disk
      // now, and re-measure so 已達標 can be judged from fresh numbers. The
      // per-row verdicts set above survive: new rows start with `outcome: null`,
      // so carry them over by path.
      const dir = rootRef.current;
      if (dir) {
        const outcomes = new Map<string, Outcome>();
        for (const row of mapped) if (row.outcome) outcomes.set(pathKey(row.path), row.outcome);
        const next = await scanRoot(dir);
        if (outcomes.size > 0) {
          setRows(next.map((row) => ({ ...row, outcome: outcomes.get(pathKey(row.path)) ?? null })));
        }
        measureRows(next.map((r) => r.path));
      }
    },
    [measureRows, scanRoot, stopPolling],
  );

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const status = await api.job(jobId);
            setJob((prev) => ({
              ...prev,
              progress: status.progress ?? null,
              running: status.state === 'queued' || status.state === 'running',
            }));
            if (status.state === 'done') {
              await finishJob(status.report, null);
            } else if (status.state === 'failed') {
              await finishJob(
                null,
                status.error ? `轉換失敗：${status.error}` : '轉換失敗，請見引擎日誌。',
              );
            }
          } catch (err) {
            await finishJob(null, `讀取進度失敗：${errText(err)}`);
          }
        })();
      }, POLL_MS);
    },
    [finishJob, stopPolling],
  );

  const startBatch = useCallback(async () => {
    const dir = rootRef.current;
    if (!dir || job.running) return;
    // The tick-boxes ARE the batch. The engine is told exactly which paths to
    // convert, so an unticked row is genuinely left untouched rather than being
    // converted because it happened to sit under the chosen folder.
    const selected = rowsRef.current.filter((r) => r.checked).map((r) => r.path);
    if (selected.length === 0) return;

    // Arm the one-shot finalizer again: without this a second run would poll
    // forever and never write its per-row verdicts or summary.
    settledRef.current = false;
    setRows((prev) => prev.map((r) => ({ ...r, outcome: null })));
    setJob({ ...IDLE_JOB, running: true });
    try {
      const started = await api.batch({
        dir,
        // Required by the engine even in overwrite mode — it would rather reject a
        // half-specified request than guess. Same value as `dir`: replace in place.
        outputDir: dir,
        preset: presetById(target),
        overwrite: true,
        includePaths: selected,
        // Re-encode, do NOT rename: the engine's default `{artist} - {title}`
        // pattern renamed 123 of the 199 files in the user's real batch.
        preserveNames: true,
        dryRun: false,
      });
      setJob((prev) => ({ ...prev, id: started.jobId }));
      startPolling(started.jobId);
    } catch (err) {
      setJob({ ...IDLE_JOB, error: `無法啟動轉換：${errText(err)}` });
    }
  }, [job.running, startPolling, target]);

  /* ---------------------------------------------------------------- */
  /* Drag & drop                                                       */
  /* ---------------------------------------------------------------- */

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!dropHasFiles(e.dataTransfer) && (e.dataTransfer?.files?.length ?? 0) === 0) return;
    // Without preventDefault the browser navigates to the dropped file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDropArmed(true);
  };

  const onDragLeave = (): void => setDropArmed(false);

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    const dt = e.dataTransfer;
    if (!dt || (!dropHasFiles(dt) && (dt.files?.length ?? 0) === 0)) return;
    e.preventDefault();
    // The shell already listens for a whole-window drop and would upload the same
    // files into its (now hidden) editor. Stopping the native event here keeps one
    // drop from being handled twice — React's listener sits below `window`.
    e.stopPropagation();
    setDropArmed(false);

    void (async () => {
      // `collectDroppedFiles` reads `webkitGetAsEntry()` before its first await, so
      // calling it synchronously from the drop handler keeps the entries valid.
      const intake = await collectDroppedFiles(dt);
      if (intake.files.length === 0) {
        const reasons: string[] = [];
        if (intake.unreadableDirs > 0) reasons.push(`${intake.unreadableDirs} 個資料夾無法列舉`);
        if (intake.skipped.length > 0) reasons.push(`非音訊檔：${intake.skipped.join('、')}`);
        dispatch({
          type: 'error',
          message: `拖放的內容裡沒有可處理的音訊檔${reasons.length > 0 ? `（${reasons.join('；')}）` : ''}。`,
        });
        return;
      }
      await adoptFiles(intake.files);
    })();
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>): void => {
    // Copy out of the live FileList before clearing, so the same file can be
    // chosen twice in a row.
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) void adoptFiles(files);
  };

  /* ---------------------------------------------------------------- */
  /* Derived view state                                                */
  /* ---------------------------------------------------------------- */

  /** The whole warn/default-tick behaviour hinges on this one boolean. */
  const targetIsLossy = TARGET_IS_LOSSY[target];

  const checkedCount = useMemo(() => rows.filter((r) => r.checked).length, [rows]);
  /**
   * 未達標 = everything that is not already 已達標 (`conforms`). That DELIBERATELY
   * includes the two ⚠ verdicts the default tick leaves alone, because pressing
   * 「全選未達標」 is the user saying they do want those converted.
   */
  const unmetCount = useMemo(() => rows.filter((r) => !r.conforms).length, [rows]);
  const allChecked = rows.length > 0 && checkedCount === rows.length;
  /**
   * The header tick-box has three states, and `indeterminate` is a DOM property with
   * no HTML attribute — React cannot set it declaratively, so an effect pushes it.
   */
  const headerCheckRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = headerCheckRef.current;
    if (el) el.indeterminate = checkedCount > 0 && checkedCount < rows.length;
  }, [checkedCount, rows.length]);
  /**
   * Rows that are left out of the batch on purpose, split by the reason the status
   * column shows. Both must be reported: against a lossless target a library of
   * lossy files is excluded by the 「有損→無損無益」 rule, and a summary that only
   * counted lossless sources would say "nothing is excluded" while 199 rows sit
   * unticked. One O(n) pass, and a row the user ticked by hand is not excluded.
   */
  const exclusions = useMemo(() => {
    let losslessToLossy = 0;
    let lossyToLossless = 0;
    for (const row of rows) {
      if (row.checked) continue; // the user opted in — it is being processed
      const verdict = conversionVerdict(row, targetIsLossy);
      if (verdict === 'degrade') losslessToLossy += 1;
      else if (verdict === 'no-gain') lossyToLossless += 1;
    }
    return {
      losslessToLossy,
      lossyToLossless,
      total: losslessToLossy + lossyToLossless,
    };
  }, [targetIsLossy, rows]);
  const measuredCount = useMemo(
    () => rows.filter((r) => r.loudness.kind !== 'pending').length,
    [rows],
  );
  /**
   * The list, partitioned by folder. One pass over `rows` builds the buckets, then
   * the folder keys are sorted; no group is ever compared against every row, so
   * this stays O(n log n) rather than O(n²) on a 199-file (or larger) workspace.
   * Rows keep their scan order inside a folder.
   */
  const groups = useMemo<FolderGroup[]>(() => {
    const byFolder = new Map<string, Row[]>();
    for (const row of rows) {
      const bucket = byFolder.get(row.folder);
      if (bucket) bucket.push(row);
      else byFolder.set(row.folder, [row]);
    }
    return [...byFolder.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, list]) => ({
        key,
        label: folderLabel(key),
        rows: list,
        checked: list.reduce((n, r) => n + (r.checked ? 1 : 0), 0),
      }));
  }, [rows]);
  const pct = useMemo(() => {
    const p = job.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  }, [job.progress]);

  const panelBusy = scanning || picking || uploading || job.running;
  const listedScanErrors = scanErrors.slice(0, MAX_LISTED_SCAN_ERRORS);
  const targetLabel = targetSpecText(target);

  return (
    <div
      className={`col usb-page${dropArmed ? ' usb-armed' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ---------------- Workspace ---------------- */}
      <div className="panel">
        <h2>工作區（USB／資料夾）</h2>
        <div className="usb-head">
          <button className="primary" onClick={() => void pickFolder()} disabled={panelBusy}>
            {picking ? '對話框中…' : '選擇資料夾…'}
          </button>
          <label className={`big-btn dropzone usb-drop${dropArmed ? ' armed' : ''}`}>
            <span className="big-title">{uploading ? '上傳中…' : '拖放資料夾／檔案到這裡'}</span>
            <span className="sub">
              或用瀏覽器選擇檔案；檔案會先上傳到引擎的暫存資料夾，再以該資料夾為工作區
            </span>
            <input type="file" multiple accept="audio/*" disabled={panelBusy} onChange={onFileInput} />
          </label>
        </div>

        {root ? (
          <p className="hint">
            目前工作區：<span className="mono usb-root">{root}</span>
          </p>
        ) : (
          <p className="hint">
            尚未選擇工作區。按「選擇資料夾…」挑選 USB 或任何本機資料夾，或把資料夾／檔案拖進這一頁。
          </p>
        )}

        {fallbackNote ? <p className="usb-note">{fallbackNote}</p> : null}
        {state.engineOk === false ? (
          <p className="usb-warnline">
            ⚠ 引擎未連線：掃描、量測與轉換都會失敗。請確認 AudioUsbStudio 應用程式已啟動，再按右上角「重新檢查」。
          </p>
        ) : null}
      </div>

      {/* ---------------- Target format + controls ---------------- */}
      <div className="panel">
        <h2>目標格式與音量</h2>
        <div className="usb-specs">
          <span className="pill">目標格式：{targetLabel}</span>
          <span className="pill">音量標準：−14 LUFS / 真峰值 −1.0 dBTP</span>
          <span className="pill">立體聲 · 溫和降噪</span>
        </div>

        <div className="usb-formats" role="radiogroup" aria-label="目標格式">
          {PRESETS.map((choice) => (
            <label
              key={choice.id}
              className={`usb-format${target === choice.id ? ' usb-format-on' : ''}`}
              title={choice.description}
            >
              <input
                type="radio"
                name="usb-target-format"
                value={choice.id}
                checked={target === choice.id}
                disabled={job.running}
                onChange={() => chooseTarget(choice.id)}
              />
              <span className="usb-format-label">{choice.label}</span>
              {/* Lossy targets are the ones that can throw data away — say so. */}
              {TARGET_IS_LOSSY[choice.id] ? (
                <span className="usb-format-tag">有損</span>
              ) : (
                <span className="usb-format-tag usb-format-tag-safe">無損</span>
              )}
            </label>
          ))}
        </div>
        <p className="hint">
          {targetIsLossy
            ? `目前是 ${targetLabel}（有損）：無損來源預設不勾（勾了等於永久降級，未勾選的無損檔一律保持原狀）；有損來源只有已達標的不勾。`
            : '目前是無損目標：無損來源重新編碼不會損失資料，預設會勾選；有損來源預設不勾 —— 把 MP3 之類的有損檔轉成無損只會讓檔案變大 2–4 倍，品質不會變好，要轉請自己勾。'}
        </p>

        <div className="usb-head usb-actions">
          {/*
            全選 lives in the table header, at the top-left of the list. The toolbar's
            button is the SELECTIVE one: everything that still needs work, which is what
            a user actually wants after a scan — and it leaves already-conforming files
            alone instead of re-encoding them for nothing.
          */}
          <button
            onClick={setAllUnmetChecked}
            disabled={rows.length === 0 || job.running || unmetCount === 0}
            title="勾選所有尚未達標的檔案（包含 ⚠ 的列），並取消勾選已達標的列"
          >
            全選未達標
            {unmetCount > 0 ? `（${unmetCount}）` : ''}
          </button>
          <button onClick={() => setAllChecked(false)} disabled={rows.length === 0 || job.running}>
            全不選
          </button>
          <span className="spacer" />
          <span className="hint">
            已勾選 {checkedCount}／{rows.length}
          </span>
          <button onClick={() => void rescan()} disabled={!root || panelBusy}>
            重新掃描
          </button>
          <button
            className="primary"
            onClick={() => void startBatch()}
            disabled={!root || checkedCount === 0 || panelBusy}
          >
            {job.running ? '處理中…' : '開始處理'}
          </button>
        </div>

        <p className="hint">
          「開始處理」＝<strong>就地轉換</strong>：引擎先在原檔旁邊寫暫存檔、驗證通過後才原子改名覆蓋，任何一步失敗都會保留原檔。
        </p>
        <p className="hint">
          只處理<strong>已勾選</strong>的檔案（共 {checkedCount} 個）；未勾選的列完全不會被讀寫。
          本頁送出 <span className="mono">preserveNames: true</span>，引擎會<strong>保留原檔名</strong>——
          預設的 <span className="mono">{'{artist} - {title}'}</span> 改名模式不會生效，轉檔不會動到你的檔名。
        </p>
        {exclusions.total > 0 ? (
          <p className="usb-warnline">
            ⚠ 有 {exclusions.total} 個檔案已排除在本次轉換之外（未勾選），原檔一律保持原狀：
            {exclusions.losslessToLossy > 0 ? (
              <>
                {' '}
                其中 {exclusions.losslessToLossy} 個是<strong>無損→有損</strong>的無損來源（FLAC／WAV…），
                轉成 {targetLabel} 是不可逆的降級，要轉請自己勾；
              </>
            ) : null}
            {exclusions.lossyToLossless > 0 ? (
              <>
                {' '}
                其中 {exclusions.lossyToLossless} 個是<strong>有損→無損無益</strong>的有損來源（MP3…），
                轉成 {targetLabel} 只會讓檔案變大、品質不會變好，要轉請自己勾；
              </>
            ) : null}{' '}
            列表中的「⚠」列可用「開啟檔案位置」按鈕直接跳到該檔案所在的資料夾（會自動選取該檔）。
          </p>
        ) : null}
      </div>

      {/* ---------------- Progress ---------------- */}
      {job.running || job.error || job.summary ? (
        <div className="panel">
          <h2>進度</h2>
          <div className="inline">
            <span className="pill">{job.running ? '轉換中' : job.error ? '失敗' : '已結束'}</span>
            <span className="pill">階段：{job.progress?.stage ?? '—'}</span>
            <span className="mono tiny muted">
              {job.progress ? `${job.progress.done}/${job.progress.total}` : '—'}
            </span>
            {job.id ? <span className="mono tiny muted">job {job.id}</span> : null}
          </div>
          <div className="progress" style={{ marginTop: 8 }}>
            <div style={{ width: `${pct}%` }} />
          </div>
          {job.progress?.path ? (
            <p className="mono tiny muted" style={{ marginTop: 4 }}>
              {job.progress.path}
            </p>
          ) : null}
          {job.summary ? <p className="hint">{job.summary}</p> : null}
          {job.error ? <p className="usb-error">{job.error}</p> : null}
        </div>
      ) : null}

      {/* ---------------- The table ---------------- */}
      <div className="panel">
        <h2>
          檔案清單
          {rows.length > 0 ? `（${rows.length} 檔 · ${groups.length} 個資料夾）` : ''}
          {rows.length > 0 ? (
            <span className="hint usb-measure-note">
              {' '}
              音量量測中 {measuredCount}/{rows.length}
            </span>
          ) : null}
        </h2>

        {scanning ? (
          <p className="hint">
            <span className="spinner" aria-hidden="true" /> 掃描中…
          </p>
        ) : null}

        {!scanning && rows.length === 0 ? (
          <p className="hint">
            {root
              ? '這個工作區裡沒有找到可處理的音訊檔（引擎掃描不到支援的副檔名，或全部無法解碼）。'
              : '選擇工作區後，這裡會列出檔名、格式、時長、所屬文件夾與音量。'}
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="usb-tablewrap">
            <table className="usb-table">
              <thead>
                <tr>
                  {/*
                    The list's own 全選, at the top-left of the table. Three states:
                    all / none / some, the last pushed in via `indeterminate` because
                    React has no attribute for it.
                  */}
                  <th className="usb-check">
                    <input
                      ref={headerCheckRef}
                      type="checkbox"
                      checked={allChecked}
                      disabled={rows.length === 0 || job.running}
                      aria-label="全選"
                      title="全選／全不選"
                      onChange={(e) => setAllChecked(e.target.checked)}
                    />
                  </th>
                  <th>檔名</th>
                  <th>格式</th>
                  <th>時長</th>
                  <th>所屬文件夾</th>
                  <th>音量</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isCollapsed = collapsed.has(group.key);
                  const allChecked = group.rows.length > 0 && group.checked === group.rows.length;
                  return (
                    <Fragment key={group.key}>
                      {/* One folder = one heading with its own tri-state tick-box. */}
                      <tr className="usb-group">
                        <td colSpan={7}>
                          <div className="usb-group-head">
                            <FolderCheckbox
                              checked={allChecked}
                              partial={group.checked > 0}
                              disabled={job.running}
                              label={`選取資料夾 ${group.label} 的所有檔案`}
                              onChange={(checked) => setFolderChecked(group.key, checked)}
                            />
                            <button
                              type="button"
                              className="usb-group-toggle"
                              aria-expanded={!isCollapsed}
                              onClick={() => toggleFolderCollapsed(group.key)}
                              title={isCollapsed ? '展開這個資料夾' : '收合這個資料夾'}
                            >
                              <span aria-hidden="true">{isCollapsed ? '▶' : '▼'}</span>
                              <span className="mono usb-group-label">{group.label}</span>
                            </button>
                            <span className="hint usb-group-count">
                              {group.rows.length} 個檔案 · 已勾選 {group.checked}
                            </span>
                            <RevealFileButton
                              path={group.rows[0]?.path ?? ''}
                              dir={parentFolderOf(group.rows[0]?.path ?? '')}
                            />
                          </div>
                        </td>
                      </tr>
                      {isCollapsed
                        ? null
                        : group.rows.map((row) => {
                            const loud = loudnessCell(row.loudness);
                            return (
                              <tr key={row.path} className={statusClass(row, job.running, targetIsLossy)}>
                                <td className="usb-check">
                                  <input
                                    type="checkbox"
                                    checked={row.checked}
                                    disabled={job.running}
                                    aria-label={`選擇 ${row.name}`}
                                    onChange={() => toggleRow(row.path)}
                                  />
                                </td>
                                <td className="usb-name" title={row.path}>
                                  {row.name}
                                </td>
                                <td className="mono">{row.format}</td>
                                <td className="mono">{formatDuration(row.durationSec)}</td>
                                <td className="mono muted usb-folder" title={row.folder}>
                                  {row.folder}
                                </td>
                                <td className="mono" title={loud.title}>
                                  {row.loudness.kind === 'pending' ? (
                                    <span className="usb-measuring">
                                      <span className="spinner" aria-hidden="true" /> {loud.text}
                                    </span>
                                  ) : (
                                    loud.text
                                  )}
                                </td>
                                <td className="status">
                                  {statusText(row, job.running, targetIsLossy)}
                                  {/* The warning (or the failure) is where the user
                                      needs to reach the actual file on disk. */}
                                  {needsFolderShortcut(row, job.running, targetIsLossy) ? (
                                    <RevealFileButton
                                      path={row.path}
                                      dir={parentFolderOf(row.path)}
                                    />
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {scanErrors.length > 0 ? (
          <>
            <ul className="usb-scanerrs">
              {listedScanErrors.map((e) => (
                <li key={`${e.path}:${e.message}`}>
                  <span className="mono">{e.path}</span>
                  <br />
                  {e.message}
                </li>
              ))}
            </ul>
            {scanErrors.length > listedScanErrors.length ? (
              <p className="hint">
                另有 {scanErrors.length - listedScanErrors.length} 個無法讀取的檔案未列出。
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
