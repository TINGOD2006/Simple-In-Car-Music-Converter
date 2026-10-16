/**
 * HTTP API for the AudioUsbStudio web UI.
 *
 * Dependency-free `node:http`. Every heavy operation (probe, waveform, render,
 * batch) is delegated to `src/core`; this layer only does routing, JSON
 * parsing, and job bookkeeping. It performs **no DSP of its own** — ffmpeg
 * stays the single source of truth for what a render sounds like.
 *
 * Optional engine modules (library/batch/denoise) are loaded through a
 * non-literal dynamic import so the server still boots — and still typechecks —
 * while those files are being written in parallel. An endpoint whose module is
 * absent answers 501 with a clear message instead of crashing the process.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { preferredScratchPath, tryResolveScratchRoot } from '../core/approot.ts';
import { findBinaries } from '../core/ffbin.ts';
import type { BinPaths } from '../core/ffbin.ts';
import { probe } from '../core/probe.ts';
import { measureFileLoudness } from '../core/loudness.ts';
import { usbPreset } from '../core/edl.ts';
import { render, verify } from '../core/render.ts';
import { compile } from '../core/compiler.ts';
import type { ExportPreset, Timeline } from '../core/types.ts';
import { sweepStaleStaging } from '../core/staging.ts';
import { getJob, listJobs, startJob } from './jobs.ts';
import { waveform } from './waveform.ts';
import {
  isStreamableAudio,
  pickPaths,
  revealPath,
  sendAudioFile,
  streamUpload,
} from './files.ts';

export interface ServerOptions {
  /** Explicit ffmpeg bin directory; otherwise auto-discovered. */
  ffmpegDir?: string;
  /** Directory for the built web UI. Served statically when present. */
  webRoot?: string;
  /** Scratch root for ffmpeg work. Defaults to a temp dir. */
  scratchRoot?: string;
  port?: number;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Upload cap. Far above the JSON cap because this is the path a real lossless
 * album track takes, and it is streamed to disk rather than held in memory.
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * A fresh scratch file inside the server's scratch root.
 *
 * Every call gets its own directory so two concurrent renders (or a preview
 * racing an export) can never overwrite each other's bytes.
 */
function scratchFile(root: string, tag: string, name: string): string {
  const dir = join(
    root,
    tag,
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/**
 * Import an engine module that may not exist yet.
 *
 * The specifier is deliberately non-literal: TypeScript must not try to resolve
 * it at compile time, so a module still being written by another workstream
 * cannot break the build.
 */
async function optionalModule<T>(name: string): Promise<T | null> {
  const spec = `../core/${name}.ts`;
  try {
    return (await import(spec)) as T;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** What a pre-run staging sweep found and did. */
export interface StagingSweep {
  /** Absolute paths of the leftover staging files that were actually removed. */
  removed: string[];
  /** The one line to show the user, or null when nothing was removed. */
  notice: string | null;
}

/**
 * Reclaim `.aus-tmp-` leftovers under the directories a batch is about to touch.
 *
 * A run that dies between "rendered" and "renamed" leaves its staging file behind
 * forever; the scanner skips such a name (see core/library.ts), but the file still
 * eats space on the stick, and its existence is how a user ends up with a `(2)`
 * duplicate. Both entry points — `/api/batch` and the CLI's `batch` — therefore
 * clean up before they start, through this one function so the two can never
 * disagree about *when* or *where*.
 *
 * What counts as stale is decided in core/staging.ts (mtime window + "cannot open
 * it for write, keep it") and is deliberately not re-implemented here.
 *
 * Scope is exactly the roots of this run: no parent directory, no drive-wide walk.
 * `notice` is null when nothing was removed, because "cleaned 0 files" on every
 * run is noise the user learns to ignore.
 *
 * Never throws: a cleanup that cannot run (an unreadable or malformed root) must
 * not take the batch down with it — the scan reports a genuinely bad root itself.
 */
export function sweepStaleStagingUnder(roots: string[]): StagingSweep {
  try {
    const dirs = [
      ...new Set(roots.filter((r) => typeof r === 'string' && r !== '').map((r) => resolve(r))),
    ];
    const removed = dirs.length === 0 ? [] : sweepStaleStaging(dirs).removed;
    return { removed, notice: stagingSweepNotice(removed.length) };
  } catch {
    return { removed: [], notice: null };
  }
}

/** The line shown after a sweep, or null when there is nothing worth saying. */
export function stagingSweepNotice(removedCount: number): string | null {
  if (removedCount <= 0) return null;
  return `已清除 ${removedCount} 個上次留下的暫存檔`;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve the built UI, refusing any path that escapes `root`. */
function serveStatic(root: string, urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = resolve(root, normalize(rel));
  const rootResolved = resolve(root);

  // Path traversal guard: the resolved target must stay inside the web root.
  if (target !== rootResolved && !target.startsWith(rootResolved + (process.platform === 'win32' ? '\\' : '/'))) {
    sendText(res, 403, 'forbidden');
    return true;
  }

  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback: unknown non-asset paths get the shell.
    if (extname(rel)) return false;
    file = join(rootResolved, 'index.html');
    if (!existsSync(file)) return false;
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
  return true;
}

/**
 * Loudness target handed to the analysis filter.
 *
 * Read from the USB preset so the table and the render cannot disagree about
 * what "aligned to the standard" means. These values only parameterise the
 * filter: what comes back are the *input* measurements, which do not depend on
 * them, so a wrong target cannot make a file look louder or quieter than it is.
 */
function measureTargets(): { integratedLufs: number; truePeakDb: number; lra: number } {
  const loudness = usbPreset().loudness;
  return {
    integratedLufs: loudness?.integratedLufs ?? -14,
    truePeakDb: loudness?.truePeakDb ?? -1,
    lra: loudness?.lra ?? 11,
  };
}

function makeHandler(opts: ServerOptions, bins: BinPaths) {
  // ffmpeg/ffprobe run with `cwd: scratchRoot`; a missing cwd makes spawn fail
  // with a misleading ENOENT naming the *binary* rather than the directory.
  //
  // Nowhere writable is deliberately *not* fatal. The window has to come up and the
  // UI has to load even then, because the machine's own refusal is exactly what the
  // user needs to be told about — an engine that dies while setting up reports
  // nothing at all, which is the failure this whole path exists to end.
  const { root, refusals } = tryResolveScratchRoot(opts.scratchRoot);
  const scratchRoot = root ?? opts.scratchRoot ?? preferredScratchPath();
  const scratchRefusals = refusals;
  const webRoot = opts.webRoot;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      /* ---------------------------------------------------------------- */
      /* Health                                                            */
      /* ---------------------------------------------------------------- */
      if (path === '/api/health') {
        send(res, 200, {
          ok: true,
          ffmpeg: bins.ffmpeg,
          ffprobe: bins.ffprobe,
          ffmpegSource: bins.source,
          scratchRoot,
          scratchWritable: root !== null,
          scratchRefusals,
          node: process.version,
        });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Measure one file's loudness                                       */
      /* ---------------------------------------------------------------- */
      // The library table shows one loudness per row, so this is called once per
      // file, in the background, while the list is already on screen.
      if (path === '/api/measure' && req.method === 'GET') {
        const target = url.searchParams.get('path');
        if (!target) {
          send(res, 400, { ok: false, error: 'path is required' });
          return;
        }
        if (!existsSync(target)) {
          send(res, 404, { ok: false, error: `no such file: ${target}` });
          return;
        }
        try {
          const measured = await measureFileLoudness(
            bins.ffmpeg,
            target,
            scratchRoot,
            measureTargets(),
          );
          send(res, 200, {
            ok: true,
            path: target,
            lufs: measured.inputI,
            truePeakDb: measured.inputTp,
            lra: measured.inputLra,
          });
        } catch (err) {
          // 422, not 500: the file is the problem, not the server. Reporting a
          // loudness of zero here would make an unreadable row look like silence.
          send(res, 422, { ok: false, error: (err as Error).message });
        }
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Probe one file                                                    */
      /* ---------------------------------------------------------------- */
      if (path === '/api/probe' && req.method === 'POST') {
        const body = (await readBody(req)) as { path?: string };
        if (!body.path) {
          send(res, 400, { ok: false, error: 'path is required' });
          return;
        }
        const info = await probe(bins.ffprobe, body.path, scratchRoot);
        send(res, 200, { ok: true, info });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Waveform peaks                                                    */
      /* ---------------------------------------------------------------- */
      if (path === '/api/waveform') {
        const file = url.searchParams.get('path');
        if (!file) {
          send(res, 400, { ok: false, error: 'path is required' });
          return;
        }
        const buckets = Number(url.searchParams.get('buckets') ?? 2000);
        const wf = await waveform(bins.ffmpeg, file, scratchRoot, buckets);
        send(res, 200, { ok: wf.peaks.length > 0, ...wf });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Compile only (no render) — lets the UI show the exact argv        */
      /* ---------------------------------------------------------------- */
      if (path === '/api/compile' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          timeline?: Timeline;
          preset?: ExportPreset;
          sourcePaths?: Record<string, string>;
          outputPath?: string;
        };
        if (!body.timeline || !body.preset || !body.sourcePaths || !body.outputPath) {
          send(res, 400, { ok: false, error: 'timeline, preset, sourcePaths, outputPath are required' });
          return;
        }
        const compiled = compile({
          timeline: body.timeline,
          preset: body.preset,
          sourcePaths: body.sourcePaths,
          outputPath: body.outputPath,
        });
        send(res, 200, {
          ok: true,
          args: compiled.args,
          inputs: compiled.inputs,
          filterComplex: compiled.filterComplex,
          warnings: compiled.warnings,
        });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Render + verify                                                   */
      /* ---------------------------------------------------------------- */
      /* ---------------------------------------------------------------- */
      /* Local files: native dialog, upload, and playback streaming         */
      /* ---------------------------------------------------------------- */
      if (path === '/api/pick' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          mode?: string;
          title?: string;
          multiple?: boolean;
        };
        const mode = body.mode === 'folder' ? 'folder' : 'files';
        const picked = await pickPaths(mode, { title: body.title, multiple: body.multiple });
        if (picked === null) {
          // Not a failure the user caused: the UI must fall back to uploading.
          send(res, 501, {
            ok: false,
            error: 'no native file dialog is available here — drop the file in, or upload it',
          });
          return;
        }
        send(res, 200, { ok: true, paths: picked });
        return;
      }

      if (path === '/api/reveal' && req.method === 'POST') {
        const body = (await readBody(req)) as { path?: string };
        const target = body.path;
        if (!target) {
          send(res, 400, { ok: false, error: 'path is required' });
          return;
        }
        // Absolute only. A relative path would be resolved against the engine's
        // cwd, which is not what the caller means and could select the wrong file.
        if (!isAbsolute(target)) {
          send(res, 400, { ok: false, error: 'path must be absolute' });
          return;
        }
        const resolved = resolve(target);
        // Distinguish "there is no file manager here" from "that file is gone":
        // the UI phrases them differently, and only the second is the user's fault.
        if (!existsSync(resolved)) {
          send(res, 404, { ok: false, error: `file not found: ${resolved}` });
          return;
        }
        const revealed = await revealPath(resolved);
        if (!revealed) {
          send(res, 501, {
            ok: false,
            error: 'no file manager is available here — open the folder manually',
          });
          return;
        }
        send(res, 200, { ok: true, path: resolved });
        return;
      }

      if (path === '/api/upload' && req.method === 'POST') {
        const name = url.searchParams.get('name') ?? 'upload.bin';
        try {
          const saved = await streamUpload(scratchRoot, name, req, MAX_UPLOAD_BYTES);
          send(res, 200, { ok: true, path: saved.path, bytes: saved.bytes });
        } catch (err) {
          const message = (err as Error).message;
          send(res, message.includes('exceeds') ? 413 : 400, { ok: false, error: message });
        }
        return;
      }

      if (path === '/api/file' && req.method === 'GET') {
        const target = url.searchParams.get('path');
        if (!target) {
          send(res, 400, { ok: false, error: 'path is required' });
          return;
        }
        if (!isAbsolute(target)) {
          send(res, 400, { ok: false, error: 'path must be absolute' });
          return;
        }
        const resolved = resolve(target);
        if (!isStreamableAudio(resolved)) {
          send(res, 415, {
            ok: false,
            error: `refusing to stream "${extname(resolved) || resolved}" — not a recognised audio container`,
          });
          return;
        }
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          send(res, 404, { ok: false, error: `file not found: ${resolved}` });
          return;
        }
        sendAudioFile(res, resolved, req.headers.range);
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Preview: render a region and hand the audio straight back          */
      /* ---------------------------------------------------------------- */
      // Answers with WAV bytes rather than JSON. The old shape returned a scratch
      // path the browser could not fetch, so every effect preview failed silently;
      // returning the bytes removes both the second round trip and the path
      // mapping that never worked.
      if (path === '/api/preview' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          timeline?: Timeline;
          preset?: ExportPreset;
          sourcePaths?: Record<string, string>;
        };
        if (!body.timeline || !body.preset || !body.sourcePaths) {
          send(res, 400, { ok: false, error: 'timeline, preset, sourcePaths are required' });
          return;
        }

        // Always preview as WAV: it is decodable by every browser and adds no
        // codec loss, so what is heard is exactly what the chain produced.
        const outPath = scratchFile(scratchRoot, 'preview', 'preview.wav');
        const result = await render({
          bins,
          scratchRoot,
          timeline: body.timeline,
          preset: { ...body.preset, container: 'wav', codec: 'pcm_s16le', bitrateKbps: null },
          sourcePaths: body.sourcePaths,
          outputPath: outPath,
          skipLoudness: true,
        });
        if (!result.ok || !existsSync(outPath)) {
          send(res, 500, { ok: false, error: result.error ?? 'preview render produced no file' });
          return;
        }
        const audio = readFileSync(outPath);
        rmSync(outPath, { force: true });
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': audio.length,
          'cache-control': 'no-store',
        });
        res.end(audio);
        return;
      }

      if (path === '/api/render' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          timeline?: Timeline;
          preset?: ExportPreset;
          sourcePaths?: Record<string, string>;
          outputPath?: string;
          tags?: Record<string, string>;
          skipLoudness?: boolean;
          doVerify?: boolean;
        };
        if (!body.timeline || !body.preset || !body.sourcePaths || !body.outputPath) {
          send(res, 400, { ok: false, error: 'timeline, preset, sourcePaths, outputPath are required' });
          return;
        }

        const result = await render({
          bins,
          scratchRoot,
          timeline: body.timeline,
          preset: body.preset,
          sourcePaths: body.sourcePaths,
          outputPath: body.outputPath,
          tags: body.tags,
          skipLoudness: body.skipLoudness,
        });

        let verification = null;
        if (result.ok && body.doVerify) {
          verification = await verify({
            bins,
            scratchRoot,
            preset: body.preset,
            file: body.outputPath,
            expectedDurationSec: result.durationSec,
            expectLoudness: !body.skipLoudness && body.preset.loudness.enabled,
          });
        }

        send(res, result.ok ? 200 : 500, {
          ok: result.ok,
          outputPath: result.outputPath,
          durationSec: result.durationSec,
          sizeBytes: result.sizeBytes,
          measured: result.measured,
          warnings: result.compile.warnings,
          error: result.error,
          verification,
        });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Batch: plan + run as a background job                             */
      /* ---------------------------------------------------------------- */
      if (path === '/api/batch' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const mod = await optionalModule<{
          planBatch: (entries: unknown[], opts: unknown) => Promise<unknown>;
          runBatch: (opts: unknown) => Promise<unknown>;
          writeManifest: (report: unknown, outPath: string) => void;
        }>('batch');

        if (!mod) {
          send(res, 501, {
            ok: false,
            error: 'batch engine not available yet (src/core/batch.ts missing)',
          });
          return;
        }

        // The engine's BatchOptions require the binaries, the scratch root and a
        // `roots` array; they come from the server's own discovery so a client
        // cannot point the decoder somewhere else. `dir` is the UI's convenience
        // spelling for a single root.
        const roots: string[] = Array.isArray(body.roots)
          ? (body.roots as string[])
          : typeof body.dir === 'string'
            ? [body.dir]
            : [];
        const opts: Record<string, unknown> = {
          ...body,
          ffmpeg: bins.ffmpeg,
          ffprobe: bins.ffprobe,
          scratch: scratchRoot,
          roots,
        };

        if (roots.length === 0) {
          send(res, 400, { ok: false, error: 'roots (or dir) is required' });
          return;
        }
        if (typeof opts.outputDir !== 'string' || opts.outputDir === '') {
          send(res, 400, { ok: false, error: 'outputDir is required' });
          return;
        }
        // `outputDir` stays required in overwrite mode as well. Accepting a request
        // that says "replace the originals" while dropping where it would otherwise
        // have written makes the two modes too easy to confuse for each other.
        if (opts.overwrite !== undefined && typeof opts.overwrite !== 'boolean') {
          send(res, 400, { ok: false, error: 'overwrite must be a boolean' });
          return;
        }
        // `preserveNames` decides whether an in-place run keeps each source's own file
        // name (the default) or is re-organised by the tag pattern. A non-boolean is a
        // client bug, and coercing it would silently rename a library the user asked to
        // leave alone.
        if (opts.preserveNames !== undefined && typeof opts.preserveNames !== 'boolean') {
          send(res, 400, { ok: false, error: 'preserveNames must be a boolean' });
          return;
        }
        // The caller's tick-boxes are only real if the engine honours them. An empty
        // array is legitimate and means "convert nothing"; a malformed one is not,
        // because ignoring it would convert exactly the files the user unticked.
        if (opts.includePaths !== undefined) {
          if (
            !Array.isArray(opts.includePaths) ||
            opts.includePaths.some((p) => typeof p !== 'string')
          ) {
            send(res, 400, { ok: false, error: 'includePaths must be an array of strings' });
            return;
          }
        }
        if (!opts.preset || typeof opts.preset !== 'object') {
          send(res, 400, { ok: false, error: 'preset is required' });
          return;
        }
        // A structurally incomplete preset (e.g. `{id:'usb'}`) would otherwise
        // be accepted here and then blow up once per track deep inside the
        // renderer with "Cannot read properties of undefined (reading
        // 'enabled')" — a failure that looks like a broken file rather than a
        // bad request. Reject it up front, naming the missing field.
        const presetObj = opts.preset as Record<string, unknown>;
        const missing: string[] = [];
        if (typeof presetObj.container !== 'string') missing.push('container');
        if (typeof presetObj.codec !== 'string') missing.push('codec');
        if (typeof presetObj.sampleRate !== 'number') missing.push('sampleRate');
        if (typeof presetObj.channels !== 'number') missing.push('channels');
        if (!presetObj.loudness || typeof presetObj.loudness !== 'object') missing.push('loudness');
        if (missing.length > 0) {
          send(res, 400, {
            ok: false,
            error: `preset is missing required field(s): ${missing.join(', ')}`,
          });
          return;
        }

        // Dry-run planning is synchronous and cheap: answer inline. planBatch()
        // takes (entries, opts) — it does not scan — so scan first. scanLibrary
        // lives in the *library* module (batch.ts imports but does not re-export
        // it), so it must be loaded separately.
        if (body.dryRun === true) {
          try {
            const lib = await optionalModule<{
              scanLibrary: (o: unknown) => Promise<{ entries: unknown[]; errors: unknown[] }>;
            }>('library');
            if (!lib) {
              send(res, 501, {
                ok: false,
                error: 'library engine not available yet (src/core/library.ts missing)',
              });
              return;
            }
            const scan = await lib.scanLibrary({
              roots,
              ffprobe: bins.ffprobe,
              scratch: scratchRoot,
              recursive: body.recursive !== false,
            });
            const plan = await mod.planBatch(scan.entries, opts);
            send(res, 200, { ok: true, plan, errors: scan.errors });
          } catch (err) {
            send(res, 400, { ok: false, error: `planning failed: ${(err as Error).message}` });
          }
          return;
        }

        const job = startJob(async (report) => {
          // Reclaim leftovers from a previous crashed run *here*, inside the real
          // run: the dry-run branch above has already returned, so a dry run cannot
          // reach this line and cannot delete anything. The roots are this run's
          // own, never the drive.
          const sweep = sweepStaleStagingUnder(roots);
          if (sweep.notice) report({ stage: sweep.notice, done: 0, total: 0 });
          const result = await mod.runBatch({
            ...opts,
            onProgress: (p: unknown) => {
              const prog = p as { stage?: string; done?: number; total?: number; path?: string };
              report({
                stage: prog.stage ?? 'working',
                done: prog.done ?? 0,
                total: prog.total ?? 0,
                path: prog.path,
              });
            },
          });
          if (typeof body.manifestPath === 'string' && body.manifestPath) {
            mod.writeManifest(result, body.manifestPath);
          }
          // Carried out with the report so the count is still readable once the job
          // has finished — the progress line above is overwritten by the first
          // render stage within milliseconds.
          return { ...(result as Record<string, unknown>), stagingSweep: sweep };
        });

        send(res, 202, { ok: true, jobId: job.id });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Jobs                                                              */
      /* ---------------------------------------------------------------- */
      if (path === '/api/jobs' && req.method === 'GET') {
        send(res, 200, { ok: true, jobs: listJobs() });
        return;
      }
      if (path.startsWith('/api/jobs/') && req.method === 'GET') {
        const id = path.slice('/api/jobs/'.length);
        const job = getJob(id);
        if (!job) {
          send(res, 404, { ok: false, error: 'no such job' });
          return;
        }
        send(res, 200, { ok: true, job });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Library scan                                                      */
      /* ---------------------------------------------------------------- */
      if (path === '/api/library') {
        const dir = url.searchParams.get('dir');
        if (!dir) {
          send(res, 400, { ok: false, error: 'dir is required' });
          return;
        }
        const mod = await optionalModule<{ scanLibrary: (o: unknown) => Promise<unknown> }>('library');
        if (!mod) {
          send(res, 501, { ok: false, error: 'library scanner not available yet (src/core/library.ts missing)' });
          return;
        }
        const scan = await mod.scanLibrary({
          // ScanOptions is `{ roots: string[], ffprobe, scratch }` — the engine's
          // own names. Passing `dir`/`scratchRoot` here left `roots` undefined
          // and the scan threw "opts.roots is not iterable".
          roots: [dir],
          recursive: url.searchParams.get('recursive') !== 'false',
          ffprobe: bins.ffprobe,
          scratch: scratchRoot,
        });
        send(res, 200, { ok: true, ...(scan as object) });
        return;
      }

      /* ---------------------------------------------------------------- */
      /* AI denoise availability + single-file opt-in                      */
      /* ---------------------------------------------------------------- */
      if (path === '/api/denoise-availability') {
        const mod = await optionalModule<{
          findDeepFilter: (p?: string) => string | null;
          describeDenoisePolicy: () => unknown;
        }>('denoise');
        if (!mod) {
          send(res, 200, { ok: true, available: false, policy: null });
          return;
        }
        const exe = mod.findDeepFilter();
        send(res, 200, {
          ok: true,
          available: exe !== null,
          exePath: exe,
          policy: mod.describeDenoisePolicy(),
        });
        return;
      }

      if (path === '/api/denoise' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const mod = await optionalModule<{
          findDeepFilter: (p?: string) => string | null;
          denoiseFile: (cfg: unknown, opts: unknown) => Promise<unknown>;
        }>('denoise');
        if (!mod) {
          send(res, 501, { ok: false, error: 'denoise module not available yet (src/core/denoise.ts missing)' });
          return;
        }
        const exe = mod.findDeepFilter(typeof body.exePath === 'string' ? body.exePath : undefined);
        if (!exe) {
          send(res, 200, { ok: false, error: 'DeepFilterNet executable not found', available: false });
          return;
        }
        // denoiseFile() requires the ffmpeg path and a scratch directory; they
        // come from the server's own discovery, never from the request body, so
        // a client cannot redirect the decoder or pick the scratch location.
        const result = await mod.denoiseFile(
          { exePath: exe },
          { ...body, ffmpeg: bins.ffmpeg, scratch: scratchRoot },
        );
        send(res, 200, result as object);
        return;
      }

      /* ---------------------------------------------------------------- */
      /* Static UI                                                         */
      /* ---------------------------------------------------------------- */
      // API paths never fall back to the SPA shell. Without this guard an
      // unknown `/api/...` request (a wrong method, or a typo) has no file
      // extension, so serveStatic would hand back index.html with status 200
      // and the client would fail parsing HTML as JSON instead of seeing 404.
      if (webRoot && req.method === 'GET' && !path.startsWith('/api/')) {
        if (serveStatic(webRoot, path, res)) return;
      }

      send(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
    } catch (err) {
      send(res, 500, { ok: false, error: (err as Error).message });
    }
  };
}

export function createAppServer(opts: ServerOptions = {}): Server {
  const bins = findBinaries(opts.ffmpegDir);
  const handler = makeHandler(opts, bins);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

/** Start listening and resolve with the bound port. */
export function startServer(opts: ServerOptions = {}): Promise<{ server: Server; port: number }> {
  const server = createAppServer(opts);
  const port = opts.port ?? 4173;
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({ server, port: bound });
    });
  });
}
