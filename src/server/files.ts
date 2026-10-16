/**
 * Local-file access for the browser UI.
 *
 * The UI runs in a browser, so it cannot enumerate the disk, cannot read a
 * `C:\...` path, and cannot raise a native dialog. These three operations are the
 * missing half of "open a file": ask the OS for paths, accept an upload from a
 * drag-and-drop, and hand bytes back for `<audio>` playback.
 *
 * Every dialog/stream here is best-effort and self-describing: a platform that
 * cannot show a dialog answers `null` rather than throwing, so the caller can
 * degrade to upload instead of failing the request.
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';

/**
 * Audio container extensions the UI is allowed to stream back.
 *
 * Deliberately an allow-list rather than "any existing file": `/api/file` reads
 * whatever path it is handed, so without this a stray request could pull an
 * arbitrary local file into the browser. The list covers every container the
 * engine's ffmpeg can decode.
 */
const AUDIO_EXTENSIONS = new Set([
  '.aac', '.ac3', '.adts', '.aif', '.aifc', '.aiff', '.amr', '.ape', '.asf', '.au', '.awb',
  '.bwf', '.caf', '.dts', '.dtshd', '.eac3', '.flac', '.gsm', '.m4a', '.m4b', '.mka', '.mkv',
  '.mov', '.mp1', '.mp2', '.mp3', '.mp4', '.mpa', '.mpc', '.oga', '.ogg', '.opus', '.ra',
  '.rf64', '.rm', '.snd', '.spx', '.tak', '.tta', '.voc', '.vox', '.w64', '.wav', '.webm',
  '.wma', '.wv',
]);

/** Media types for the containers above; anything else is served as a blob. */
const AUDIO_MIME: Record<string, string> = {
  '.aac': 'audio/aac',
  '.ac3': 'audio/ac3',
  '.aif': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ape': 'audio/x-ape',
  '.au': 'audio/basic',
  '.caf': 'audio/x-caf',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mka': 'audio/x-matroska',
  '.mkv': 'audio/x-matroska',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.spx': 'audio/ogg',
  '.tta': 'audio/x-tta',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.wv': 'audio/x-wavpack',
};

export function audioContentType(filePath: string): string {
  return AUDIO_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** True when `filePath` names a container the UI may stream. */
export function isStreamableAudio(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Native pick dialog                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ask the OS for file or folder paths using a native dialog.
 *
 * PowerShell + WinForms is the only dialog reachable without adding a GUI
 * toolkit to a headless Node program, and this product targets Windows.
 *
 * Resolves `[]` when the user cancelled, and `null` when no dialog could be shown
 * at all (non-Windows, PowerShell missing or blocked by policy). The distinction
 * matters: cancel is a normal outcome the UI ignores, whereas `null` must become a
 * 501 so the UI knows to fall back to the upload path instead of looking broken.
 *
 * Piped stdio is required to read the chosen paths back. Where a sandbox forbids
 * that, `spawn` throws and we answer `null` — the documented degradation.
 *
 * Two details here exist because of real-machine reports, not theory:
 *
 *  - The dialog is given a one-pixel topmost owner form. A dialog with no owner is
 *    a dialog Windows will not hand the foreground to, and an inactive dialog
 *    spends the user's first click on being activated — the reported "I have to
 *    choose the folder twice".
 *  - The shell is probed down a short list. `powershell.exe` ships with every
 *    supported Windows, but a locked-down or ARM image may only carry `pwsh`, and a
 *    missing dialog is a dead end while a fallback is one spawn away.
 */
const POWERSHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe', 'pwsh'];

/**
 * The outcome of one dialog attempt.
 *
 * `started: false` means the shell itself is not there, which is the only reason to
 * try the next candidate — a shell that RAN and failed gets no second attempt,
 * because the dialog may already have been on screen and a retry would pop it twice.
 */
type DialogRun = { started: boolean; paths: string[] | null };

/** Run one dialog script through one shell. */
function runDialog(shell: string, script: string): Promise<DialogRun> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (run: DialogRun): void => {
      if (settled) return;
      settled = true;
      resolvePromise(run);
    };

    let child;
    try {
      child = spawn(shell, ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      settle({ started: false, paths: null });
      return;
    }

    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    // Drain stderr so a chatty profile cannot fill the pipe and stall the dialog.
    child.stderr?.on('data', () => {});

    child.once('error', () => settle({ started: false, paths: null }));
    child.once('close', (code) => {
      settle({
        started: true,
        paths:
          code !== 0
            ? null
            : out
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
      });
    });
  });
}

export async function pickPaths(
  mode: 'files' | 'folder',
  opts: { title?: string; multiple?: boolean; shell?: string } = {},
): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const title = (opts.title ?? (mode === 'folder' ? 'Select a folder' : 'Select audio files'))
    .replace(/'/g, "''");
  // `$o` is the owner window: shown, activated, topmost, and one pixel wide. See the
  // doc comment above — this is what stops the first click from being swallowed.
  const script =
    mode === 'folder'
      ? [
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          'Add-Type -AssemblyName System.Drawing | Out-Null',
          '$o = New-Object System.Windows.Forms.Form',
          '$o.ShowInTaskbar = $false',
          '$o.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
          '$o.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
          '$o.Size = New-Object System.Drawing.Size(1,1)',
          '$o.TopMost = $true',
          '$o.Show()',
          '$o.Activate()',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          `$d.Description = '${title}'`,
          '$d.ShowNewFolderButton = $false',
          '$r = $d.ShowDialog($o)',
          '$o.Close()',
          'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
        ].join('; ')
      : [
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          'Add-Type -AssemblyName System.Drawing | Out-Null',
          '$o = New-Object System.Windows.Forms.Form',
          '$o.ShowInTaskbar = $false',
          '$o.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
          '$o.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
          '$o.Size = New-Object System.Drawing.Size(1,1)',
          '$o.TopMost = $true',
          '$o.Show()',
          '$o.Activate()',
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          `$d.Title = '${title}'`,
          `$d.Multiselect = $${opts.multiple === false ? 'false' : 'true'}`,
          "$d.Filter = 'Audio files|*.mp3;*.wav;*.flac;*.ogg;*.oga;*.opus;*.m4a;*.aac;*.wma;*.aiff;*.aif;*.ape;*.wv;*.tta;*.mka;*.mp4;*.w64;*.caf|All files|*.*'",
          '$r = $d.ShowDialog($o)',
          '$o.Close()',
          'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }',
        ].join('; ');

  const shells = opts.shell ? [opts.shell] : POWERSHELL_CANDIDATES;
  for (const shell of shells) {
    const run = await runDialog(shell, script);
    // This shell is not installed; the next candidate is one spawn away.
    if (!run.started) continue;
    // It ran and failed. That may mean the dialog was already on screen and the
    // user is looking at it, so retrying would be worse than giving up.
    if (run.paths === null) return null;
    // The dialog deliberately offers an "All files" entry, so a user can pick
    // something the engine will then refuse with a bare 415. Dropping those here
    // means the list the page receives is one it can actually convert.
    return mode === 'files' ? run.paths.filter(isStreamableAudio) : run.paths;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Reveal in the OS file manager                                       */
/* ------------------------------------------------------------------ */

/**
 * Show `target` in the OS file manager, selecting it when it is a file.
 *
 * This exists because a path string is not an answer. When a conversion is
 * skipped to avoid destroying a lossless source, the user's next question is
 * always "where is that file?" — and a path they have to retype into Explorer is
 * a path they will get wrong. Opening the folder with the file already
 * highlighted answers it in one click.
 *
 * Resolves `true` when the file manager was launched, `false` when this platform
 * has none. Like `pickPaths`, it never throws: a missing desktop is a degraded
 * feature, not a failed request.
 *
 * The exit code is deliberately ignored. `explorer.exe /select,<path>` routinely
 * exits non-zero even when the window opens, so treating that as failure would
 * report an error for the normal case.
 */
export function revealPath(target: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (!existsSync(target)) return Promise.resolve(false);

  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolvePromise) => {
    let child;
    try {
      // `spawn` with stdio ignored and detached: explorer is a launcher, not a
      // tool whose output we read. The comma after /select is part of the syntax
      // and must not be separated by a space.
      child = spawn('explorer.exe', isDir ? [target] : [`/select,${target}`], {
        stdio: 'ignore',
        windowsHide: false,
        detached: true,
      });
    } catch {
      resolvePromise(false);
      return;
    }

    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    // explorer hands off to the already-running shell process and exits at once,
    // so `close` usually arrives within milliseconds. The timer is a guard for the
    // case where it does not: the window is already up either way, and making the
    // request wait would freeze the UI behind a dialog the user can see.
    const timer = setTimeout(() => done(true), 3000);
    timer.unref?.();

    child.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.once('close', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

/** Keep the user's name readable but strip anything Windows or a later shell would misread. */
export function sanitizeUploadName(rawName: string): string {
  const base = basename(rawName.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const clipped = base.length > 180 ? base.slice(base.length - 180) : base;
  return clipped || 'upload.bin';
}

/** Pick a free name so a retry or a second drop never truncates an earlier upload. */
function uniqueUploadPath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  let target = join(dir, name);
  for (let n = 2; existsSync(target); n += 1) target = join(dir, `${stem} (${n})${ext}`);
  return target;
}

/**
 * Stream a request body to `<scratchRoot>/uploads/`.
 *
 * Streamed rather than buffered: a lossless album track is easily 50-100 MB, and
 * holding a few of those in the server's heap to write them straight back out is
 * pure waste. The cap is enforced while counting so an oversized body is refused
 * before it fills the disk, and the partial file is removed on any failure.
 */
export function streamUpload(
  scratchRoot: string,
  rawName: string,
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ path: string; bytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const dir = join(scratchRoot, 'uploads');
    mkdirSync(dir, { recursive: true });
    const target = uniqueUploadPath(dir, sanitizeUploadName(rawName));
    const out = createWriteStream(target);
    let bytes = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      out.destroy();
      rmSync(target, { force: true });
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new Error(`upload exceeds ${Math.round(maxBytes / (1024 * 1024))} MB`));
        req.destroy();
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      if (bytes === 0) {
        fail(new Error('empty upload body'));
        return;
      }
      settled = true;
      resolvePromise({ path: target, bytes });
    });

    req.pipe(out);
  });
}

/* ------------------------------------------------------------------ */
/* Streaming audio back to the browser                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse a single `bytes=` range.
 *
 * Returns `null` for a missing, malformed, or multi-range header: responding with
 * the whole file is always a legal answer, and `<audio>` seeking only needs the
 * single-range form. Clamps to the real size so a client cannot ask past EOF.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serve one audio file, honouring a single byte range.
 *
 * Range support is what makes `<audio>` seeking work at all: without a 206
 * response the browser must download from the start on every scrub.
 */
export function sendAudioFile(
  res: ServerResponse,
  filePath: string,
  rangeHeader?: string,
): void {
  const stat = statSync(filePath);
  const range = parseByteRange(rangeHeader, stat.size);
  const type = audioContentType(filePath);

  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
  });
  createReadStream(filePath).pipe(res);
}
