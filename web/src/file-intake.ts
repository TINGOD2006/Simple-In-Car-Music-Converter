/**
 * Browser-side file intake.
 *
 * Turns a drag-and-drop (or a chosen `FileList`) into a flat list of `File`
 * objects the UI can upload to `POST /api/upload`.
 *
 * Two things make this less trivial than it looks:
 *
 * 1. A drop can be a whole DIRECTORY tree, and `DataTransfer.files` is empty for
 *    a dropped folder. The only way in is the non-standard
 *    `DataTransferItem.webkitGetAsEntry()`, which is valid **only while the drop
 *    event handler is still running** — so `collectDroppedFiles` reads the
 *    entries synchronously before it awaits anything.
 * 2. `FileSystemDirectoryReader.readEntries()` returns at most ~100 entries per
 *    call, so a directory must be read in a loop until it answers with an empty
 *    array. Assuming one call silently truncates large folders.
 */

export const AUDIO_EXTENSIONS: readonly string[] = [
  'wav',
  'wave',
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'm4b',
  'm4r',
  'aac',
  'wma',
  'aif',
  'aiff',
  'aifc',
  'caf',
  'ape',
  'wv',
  'mpc',
  'amr',
  'au',
  'mka',
  'weba',
  'webm',
  '3gp',
];

const EXT_SET = new Set(AUDIO_EXTENSIONS);

/** Guard rails: a dropped tree must never hang the UI or blow up the upload queue. */
const MAX_FILES = 400;
const MAX_DEPTH = 12;
const MAX_REPORTED_SKIPS = 12;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isAudioName(name: string): boolean {
  return EXT_SET.has(extensionOf(name));
}

/**
 * The engine accepts anything ffmpeg can read, but the DIALOG should only offer
 * audio. Extension wins over MIME: Windows reports `""` for many audio files and
 * browsers disagree on `.m4a`/`.flac`.
 */
export function isProbablyAudio(file: File): boolean {
  return file.type.startsWith('audio/') || isAudioName(file.name);
}

export interface DropIntake {
  /** Audio files, ready to upload. */
  files: File[];
  /** Names that were dropped but are not audio (capped, for the message). */
  skipped: string[];
  /** Directories the browser refused to enumerate. */
  unreadableDirs: number;
  /** True when `MAX_FILES` / `MAX_DEPTH` cut the walk short. */
  truncated: boolean;
}

/** `dragenter`/`dragover` guard: is this a file drag and not, say, selected text? */
export function dropHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  try {
    return Array.from(dt.types ?? []).includes('Files');
  } catch {
    return false;
  }
}

/**
 * Read a drop into flat `File`s. Must be called synchronously from the `drop`
 * handler (see the module comment) — the returned promise may be awaited after.
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<DropIntake> {
  const entries: FileSystemEntry[] = [];
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (!item || item.kind !== 'file') continue;
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
  }
  const plainFiles = Array.from(dt.files ?? []);

  const files: File[] = [];
  const skipped: string[] = [];
  let unreadableDirs = 0;
  let truncated = false;

  const accept = (file: File): void => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    if (isProbablyAudio(file)) files.push(file);
    else if (skipped.length < MAX_REPORTED_SKIPS) skipped.push(file.name);
  };

  if (entries.length === 0) {
    // No entry API at all, or a drag source that only provides `files`.
    for (const file of plainFiles) accept(file);
    return { files, skipped, unreadableDirs, truncated };
  }

  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    if (entry.isFile) {
      const file = await fileFromEntry(entry as FileSystemFileEntry);
      if (file) accept(file);
      return;
    }
    if (!entry.isDirectory) return;
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return;
    }

    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch {
      unreadableDirs += 1;
      return;
    }

    for (;;) {
      const batch = await readBatch(reader);
      if (batch === null) {
        unreadableDirs += 1;
        return;
      }
      if (batch.length === 0) return;
      for (const child of batch) await walk(child, depth + 1);
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
    }
  };

  for (const entry of entries) await walk(entry, 0);

  // A directory entry that could not be walked still leaves `dt.files` usable on
  // some browsers; only fall back when the walk produced nothing at all.
  if (files.length === 0 && plainFiles.length > 0) {
    for (const file of plainFiles) accept(file);
  }

  return { files, skipped, unreadableDirs, truncated };
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file(
        (file) => resolve(file),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[] | null> {
  return new Promise((resolve) => {
    try {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Human-readable byte size for upload notices. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'B'}`;
}

/** Join an engine-side directory with a file name, keeping the engine's separator. */
export function joinEnginePath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${name}`;
}
