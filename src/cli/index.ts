/**
 * Audio USB Studio — command line interface.
 *
 * M1 scope: probe, edit (via an EDL JSON file), render, and verify.
 *
 * Usage:
 *   node src/cli/index.ts probe   <file...>            [--json]
 *   node src/cli/index.ts edit    <file> --out <f>     [--trim a:b] [--split t] [--delete a:b]
 *                                                      [--silence a:b] [--gain db] [--fade in:out]
 *                                                      [--reverse] [--denoise gentle|moderate|strong]
 *                                                      [--eq "freq:gain:width,..."] [--echo ms:decay]
 *   node src/cli/index.ts render  <project.json> --out <file> [--preset usb|flac|wav] [--no-loudness]
 *   node src/cli/index.ts verify  <file> [--preset usb]
 *   node src/cli/index.ts batch   <dir...> --out <dir> [--preset usb|flac|wav]
 *                                                      [--pattern p] [--dedup]
 *                                                      [--lufs n] [--true-peak db]
 *                                                      [--capacity-gb n] [--dry-run]
 *                                                      [--manifest <json>]
 *   node src/cli/index.ts doctor
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { findBinaries } from '../core/ffbin.ts';
import type { BinPaths } from '../core/ffbin.ts';
import { probe } from '../core/probe.ts';
import * as EDL from '../core/edl.ts';
import type { Clip, EffectInstance, ExportPreset, Project, Timeline } from '../core/types.ts';
import { render, verify } from '../core/render.ts';
import { planBatch, runBatch, writeManifest } from '../core/batch.ts';
import type { BatchOptions, BatchReport } from '../core/batch.ts';
import { scanLibrary } from '../core/library.ts';

/* ------------------------------------------------------------------ */
/* Tiny arg parser                                                     */
/* ------------------------------------------------------------------ */

interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const command = argv[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function numFlag(flags: Parsed['flags'], key: string): number | null {
  const v = flags[key];
  if (v === undefined || v === true) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

function strFlag(flags: Parsed['flags'], key: string): string | null {
  const v = flags[key];
  return v === undefined || v === true ? null : v;
}

function rangeFlag(flags: Parsed['flags'], key: string): [number, number] | null {
  const v = strFlag(flags, key);
  if (!v) return null;
  const parts = v.split(':').map(Number);
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) {
    throw new Error(`--${key} must be "start:end" in seconds, got "${v}"`);
  }
  return [parts[0]!, parts[1]!];
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

function presetByName(name: string): ExportPreset {
  switch (name) {
    case 'usb':
      return EDL.usbPreset();
    case 'flac':
      return {
        container: 'flac',
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: 44100,
        channels: 2,
        loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
        id3v2Version: null,
        denoise: 'off',
      };
    case 'wav':
      return {
        container: 'wav',
        codec: 'pcm_s16le',
        bitrateKbps: null,
        sampleRate: 44100,
        channels: 2,
        loudness: { enabled: false, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
        id3v2Version: null,
        denoise: 'off',
      };
    default:
      throw new Error(`Unknown preset "${name}". Try: usb, flac, wav`);
  }
}

/* ------------------------------------------------------------------ */
/* Shared context                                                      */
/* ------------------------------------------------------------------ */

interface Ctx {
  bins: BinPaths;
  scratch: string;
}

function makeCtx(flags: Parsed['flags']): Ctx {
  const dir = strFlag(flags, 'ffmpeg-dir') ?? undefined;
  const bins = findBinaries(dir);
  const scratchRoot = strFlag(flags, 'scratch') ?? join(tmpdir(), 'audio-usb-studio');
  mkdirSync(scratchRoot, { recursive: true });
  return { bins, scratch: scratchRoot };
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdDoctor(ctx: Ctx, flags: Parsed['flags']): Promise<number> {
  console.log('ffmpeg :', ctx.bins.ffmpeg);
  console.log('ffprobe:', ctx.bins.ffprobe);
  console.log('found in:', ctx.bins.source);
  console.log('scratch:', ctx.scratch);

  // Prove both binaries actually run, rather than only that the files exist.
  const { runFfmpeg } = await import('../core/ffbin.ts');
  const ff = await runFfmpeg(ctx.bins.ffmpeg, ['-version'], { cwd: ctx.scratch });
  const fp = await runFfmpeg(ctx.bins.ffprobe, ['-version'], { cwd: ctx.scratch });
  console.log('ffmpeg  exit:', ff.code);
  console.log('ffprobe exit:', fp.code);

  // Report the optional AI-denoise stage too. It is *reported*, never required:
  // DeepFilterNet is an opt-in extra that ships beside a packaged build but is
  // absent on a clean machine, so a missing binary must not fail `doctor`.
  const denoise = await import('../core/denoise.ts');
  const aiPath = denoise.findDeepFilter();
  const aiAvailable = aiPath !== null && denoise.isAvailable({ exePath: aiPath });
  console.log('AI denoise:', aiAvailable ? `available — ${aiPath}` : 'not installed (optional; batch uses afftdn)');

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          bins: ctx.bins,
          ffmpegExit: ff.code,
          ffprobeExit: fp.code,
          aiDenoise: { available: aiAvailable, exePath: aiPath },
        },
        null,
        2,
      ),
    );
  }
  return ff.code === 0 && fp.code === 0 ? 0 : 1;
}

async function cmdProbe(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  if (positional.length === 0) throw new Error('probe needs at least one file');
  const results = [];
  for (const f of positional) {
    const p = abs(f);
    if (!existsSync(p)) throw new Error(`No such file: ${p}`);
    const info = await probe(ctx.bins.ffprobe, p, ctx.scratch);
    results.push(info);
  }
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const a = r.audio;
      console.log(`${r.path}`);
      console.log(`  container : ${r.format.formatName}  (${r.format.formatLongName})`);
      console.log(`  duration  : ${r.format.durationSec.toFixed(3)} s`);
      console.log(`  size      : ${(r.format.sizeBytes / 1024 / 1024).toFixed(2)} MiB`);
      if (a) {
        console.log(
          `  audio     : ${a.codecName}  ${a.sampleRate} Hz  ${a.channels}ch  ` +
            `${a.channelLayout || '?'}  ${a.bitRate ? Math.round(a.bitRate / 1000) + ' kbps' : 'n/a'}`,
        );
      } else {
        console.log('  audio     : (none)');
      }
      const tags = r.format.tags;
      const interesting = ['title', 'artist', 'album', 'track', 'date', 'genre'];
      const shown = interesting.filter((k) => tags[k]);
      if (shown.length > 0) {
        console.log('  tags      : ' + shown.map((k) => `${k}=${tags[k]}`).join('  '));
      }
      console.log('');
    }
  }
  return 0;
}

/**
 * `edit` builds a single-source project from CLI flags, applies the edits in a
 * fixed, documented order, then renders it. This is the M1 smoke path.
 */
async function cmdEdit(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  const input = positional[0];
  if (!input) throw new Error('edit needs an input file');
  const out = strFlag(flags, 'out');
  if (!out) throw new Error('edit needs --out <file>');

  const srcPath = abs(input);
  if (!existsSync(srcPath)) throw new Error(`No such file: ${srcPath}`);

  const info = await probe(ctx.bins.ffprobe, srcPath, ctx.scratch);
  if (!info.audio) throw new Error(`${srcPath} has no audio stream`);

  const preset = presetByName(strFlag(flags, 'preset') ?? 'usb');
  const sourceId = 'src0';
  const duration = info.format.durationSec || (info.audio.durationSec ?? 0);

  let timeline: Timeline = EDL.makeTimeline(
    [EDL.makeClip({ sourceId, srcIn: 0, srcOut: duration })],
    preset.sampleRate,
    preset.channels,
  );

  const applied: string[] = [];

  const trim = rangeFlag(flags, 'trim');
  if (trim) {
    timeline = EDL.trimToRange(timeline, trim[0], trim[1]);
    applied.push(`trim ${trim[0]}..${trim[1]}`);
  }

  const del = rangeFlag(flags, 'delete');
  if (del) {
    timeline = EDL.deleteRange(timeline, del[0], del[1]);
    applied.push(`delete ${del[0]}..${del[1]}`);
  }

  const sil = rangeFlag(flags, 'silence');
  if (sil) {
    timeline = EDL.silenceRange(timeline, sil[0], sil[1]);
    applied.push(`silence ${sil[0]}..${sil[1]}`);
  }

  const splitAt = numFlag(flags, 'split');
  if (splitAt !== null) {
    timeline = EDL.split(timeline, splitAt);
    applied.push(`split at ${splitAt}`);
  }

  if (flags['merge-adjacent']) {
    const before = timeline.clips.length;
    timeline = EDL.mergeAdjacent(timeline);
    applied.push(`merge-adjacent ${before} -> ${timeline.clips.length} clips`);
  }

  // Effects applied to every clip.
  const effects: EffectInstance[] = [];
  const gain = numFlag(flags, 'gain');
  if (gain !== null) effects.push({ id: EDL.newId('e'), enabled: true, type: 'gain', gainDb: gain });

  const hp = numFlag(flags, 'highpass');
  if (hp !== null) effects.push({ id: EDL.newId('e'), enabled: true, type: 'highpass', freq: hp });

  const lp = numFlag(flags, 'lowpass');
  if (lp !== null) effects.push({ id: EDL.newId('e'), enabled: true, type: 'lowpass', freq: lp });

  if (flags['reverse']) effects.push({ id: EDL.newId('e'), enabled: true, type: 'reverse' });

  const dn = strFlag(flags, 'denoise');
  if (dn) {
    if (!['gentle', 'moderate', 'strong'].includes(dn)) {
      throw new Error('--denoise must be gentle | moderate | strong');
    }
    effects.push({
      id: EDL.newId('e'),
      enabled: true,
      type: 'denoise',
      strength: dn as 'gentle' | 'moderate' | 'strong',
    });
  }

  const eq = strFlag(flags, 'eq');
  if (eq) {
    const bands = eq.split(',').map((part) => {
      const [f, g, w] = part.split(':').map(Number);
      if (!Number.isFinite(f) || !Number.isFinite(g)) {
        throw new Error(`--eq band "${part}" must be freq:gain[:width]`);
      }
      return { freq: f!, gainDb: g!, widthOctaves: Number.isFinite(w) ? w! : 1 };
    });
    effects.push({ id: EDL.newId('e'), enabled: true, type: 'eq', bands });
  }

  const echo = strFlag(flags, 'echo');
  if (echo) {
    const [d, dec] = echo.split(':').map(Number);
    if (!Number.isFinite(d)) throw new Error('--echo must be "delayMs[:decay]"');
    effects.push({
      id: EDL.newId('e'),
      enabled: true,
      type: 'echo',
      delayMs: d!,
      decay: Number.isFinite(dec) ? dec! : 0.5,
    });
  }

  const comp = strFlag(flags, 'compressor');
  if (comp) {
    const [th, ratio] = comp.split(':').map(Number);
    effects.push({
      id: EDL.newId('e'),
      enabled: true,
      type: 'compressor',
      thresholdDb: Number.isFinite(th) ? th! : -18,
      ratio: Number.isFinite(ratio) ? ratio! : 3,
    });
  }

  if (flags['declip']) effects.push({ id: EDL.newId('e'), enabled: true, type: 'declip' });
  if (flags['declick']) {
    effects.push({ id: EDL.newId('e'), enabled: true, type: 'declick', threshold: 2 });
  }

  const fade = strFlag(flags, 'fade');
  let fadeIn = 0;
  let fadeOut = 0;
  if (fade) {
    const [a, b] = fade.split(':').map(Number);
    fadeIn = Number.isFinite(a) ? a! : 0;
    fadeOut = Number.isFinite(b) ? b! : 0;
  }

  if (effects.length > 0 || fadeIn > 0 || fadeOut > 0) {
    timeline = {
      ...timeline,
      clips: timeline.clips.map((c: Clip) => ({
        ...c,
        effects: [...c.effects, ...effects.map((e) => structuredClone(e))],
        fadeInSec: fadeIn,
        fadeOutSec: fadeOut,
      })),
    };
    if (effects.length) applied.push(`effects: ${effects.map((e) => e.type).join(',')}`);
    if (fadeIn || fadeOut) applied.push(`fade in=${fadeIn} out=${fadeOut}`);
  }

  console.log(`input    : ${srcPath}`);
  console.log(`duration : ${duration.toFixed(3)} s`);
  console.log(`clips    : ${timeline.clips.length}`);
  console.log(`edits    : ${applied.length ? applied.join('; ') : '(none)'}`);

  const outPath = abs(out);
  mkdirSync(dirname(outPath), { recursive: true });

  const result = await render({
    bins: ctx.bins,
    scratchRoot: ctx.scratch,
    timeline,
    preset,
    sourcePaths: { [sourceId]: srcPath },
    outputPath: outPath,
    tags: tagsFor(info, flags),
    onProgress: (s) => console.log(`  .. ${s}`),
  });

  if (!result.ok) {
    console.error(`RENDER FAILED: ${result.error}`);
    return 1;
  }

  console.log(`rendered : ${outPath} (${(result.sizeBytes / 1024).toFixed(1)} KiB)`);
  if (result.measured) {
    console.log(
      `measured : I=${result.measured.inputI} LUFS  TP=${result.measured.inputTp} dBTP  ` +
        `LRA=${result.measured.inputLra}`,
    );
  }

  const v = await verify({
    bins: ctx.bins,
    scratchRoot: ctx.scratch,
    file: outPath,
    preset,
    expectedDurationSec: result.durationSec,
    expectLoudness: preset.loudness.enabled,
  });

  printVerify(v);
  return v.ok ? 0 : 1;
}

function tagsFor(info: Awaited<ReturnType<typeof probe>>, flags: Parsed['flags']): Record<string, string> {
  const tags: Record<string, string> = {};
  const t = info.format.tags;
  for (const k of ['title', 'artist', 'album', 'track', 'date', 'genre']) {
    if (t[k]) tags[k] = t[k]!;
  }
  const set = strFlag(flags, 'tag');
  if (set) {
    for (const pair of set.split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) tags[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return tags;
}

function printVerify(v: Awaited<ReturnType<typeof verify>>): void {
  if (v.ok) {
    console.log('verify   : OK');
    const a = v.info?.audio;
    if (a) {
      console.log(
        `           ${a.codecName} ${a.sampleRate}Hz ${a.channels}ch ` +
          `${a.bitRate ? Math.round(a.bitRate / 1000) + 'kbps' : ''}`.trim(),
      );
    }
    if (v.measured) {
      console.log(`           I=${v.measured.inputI} LUFS  TP=${v.measured.inputTp} dBTP`);
    }
  } else {
    console.log('verify   : FAILED');
    for (const p of v.problems) console.log(`           - ${p}`);
  }
}

async function cmdRender(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  const projFile = positional[0];
  if (!projFile) throw new Error('render needs a project JSON file');
  const out = strFlag(flags, 'out');
  if (!out) throw new Error('render needs --out <file>');

  const project = JSON.parse(readFileSync(abs(projFile), 'utf8')) as Project;
  const preset = flags.preset ? presetByName(String(flags.preset)) : project.export;

  const sourcePaths: Record<string, string> = {};
  for (const [id, ref] of Object.entries(project.sources)) {
    sourcePaths[id] = abs(ref.path);
  }

  const outPath = abs(out);
  mkdirSync(dirname(outPath), { recursive: true });

  const result = await render({
    bins: ctx.bins,
    scratchRoot: ctx.scratch,
    timeline: project.timeline,
    preset,
    sourcePaths,
    outputPath: outPath,
    skipLoudness: Boolean(flags['no-loudness']),
    onProgress: (s) => console.log(`  .. ${s}`),
  });

  if (!result.ok) {
    console.error(`RENDER FAILED: ${result.error}`);
    return 1;
  }
  console.log(`rendered : ${outPath} (${(result.sizeBytes / 1024).toFixed(1)} KiB)`);
  console.log(`warnings : ${result.compile.warnings.length ? result.compile.warnings.join('; ') : '(none)'}`);

  const v = await verify({
    bins: ctx.bins,
    scratchRoot: ctx.scratch,
    file: outPath,
    preset,
    expectedDurationSec: result.durationSec,
    expectLoudness: preset.loudness.enabled && !flags['no-loudness'],
  });
  printVerify(v);
  return v.ok ? 0 : 1;
}

async function cmdVerify(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  const file = positional[0];
  if (!file) throw new Error('verify needs a file');
  const preset = presetByName(strFlag(flags, 'preset') ?? 'usb');
  const v = await verify({
    bins: ctx.bins,
    scratchRoot: ctx.scratch,
    file: abs(file),
    preset,
    expectLoudness: preset.loudness.enabled,
  });
  printVerify(v);
  return v.ok ? 0 : 1;
}

/** Write a project JSON so `render` can replay it. */
async function cmdSaveProject(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  const input = positional[0];
  if (!input) throw new Error('save-project needs an input file');
  const out = strFlag(flags, 'out');
  if (!out) throw new Error('save-project needs --out <file>');

  const srcPath = abs(input);
  const info = await probe(ctx.bins.ffprobe, srcPath, ctx.scratch);
  const preset = presetByName(strFlag(flags, 'preset') ?? 'usb');
  const sourceId = 'src0';
  const duration = info.format.durationSec || (info.audio?.durationSec ?? 0);

  const project = EDL.makeProject(
    strFlag(flags, 'name') ?? 'project',
    { [sourceId]: { id: sourceId, path: srcPath, info } },
    EDL.makeTimeline(
      [EDL.makeClip({ sourceId, srcIn: 0, srcOut: duration })],
      preset.sampleRate,
      preset.channels,
    ),
    preset,
  );

  writeFileSync(abs(out), JSON.stringify(project, null, 2), 'utf8');
  console.log(`wrote ${abs(out)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* batch                                                               */
/* ------------------------------------------------------------------ */

function printBatchReport(report: BatchReport): void {
  const ok = report.items.filter((i) => i.status === 'ok').length;
  const failed = report.items.filter((i) => i.status === 'failed').length;
  const skipped = report.items.filter((i) => i.status === 'skipped').length;

  for (const item of report.items) {
    const name = item.outputPath ? item.outputPath.split(/[\\/]/).pop() : item.sourcePath.split(/[\\/]/).pop();
    const mark = item.status === 'ok' ? 'ok  ' : item.status === 'skipped' ? 'skip' : 'FAIL';
    const extra = item.message ? `  (${item.message})` : '';
    console.log(`  ${mark} ${name}${extra}`);
  }

  if (report.duplicates.length > 0) {
    console.log(`\nduplicates dropped: ${report.duplicates.length} group(s)`);
    for (const g of report.duplicates) {
      console.log(`  keep ${g.keep}  reason: ${g.reason}`);
      for (const d of g.drop) console.log(`  drop ${d}`);
    }
  }

  const mib = report.totalBytes / 1024 / 1024;
  console.log(
    `\ntotal: ${report.items.length} item(s) — ${ok} ok, ${failed} failed, ${skipped} skipped` +
      ` — ${mib.toFixed(2)} MiB in ${(report.durationMs / 1000).toFixed(1)}s`,
  );
}

async function cmdBatch(ctx: Ctx, positional: string[], flags: Parsed['flags']): Promise<number> {
  if (positional.length === 0) throw new Error('batch needs at least one source directory');
  const out = strFlag(flags, 'out');
  if (!out) throw new Error('batch needs --out <dir>');

  const preset = presetByName(strFlag(flags, 'preset') ?? 'usb');
  const loudness = flags['no-loudness']
    ? null
    : (() => {
        const lufs = numFlag(flags, 'lufs');
        const tp = numFlag(flags, 'true-peak');
        if (lufs === null && tp === null) return undefined;
        return {
          integratedLufs: lufs ?? -14,
          truePeakDb: tp ?? -1.0,
          lra: numFlag(flags, 'lra') ?? 11,
        };
      })();

  const capGib = numFlag(flags, 'capacity-gb');
  const opts: BatchOptions = {
    ffmpeg: ctx.bins.ffmpeg,
    ffprobe: ctx.bins.ffprobe,
    scratch: ctx.scratch,
    roots: positional.map(abs),
    outputDir: abs(out),
    preset,
    filenamePattern: strFlag(flags, 'pattern') ?? undefined,
    loudness,
    dedup: Boolean(flags.dedup),
    concurrency: numFlag(flags, 'concurrency') ?? undefined,
    targetCapacityBytes: capGib === null ? null : Math.round(capGib * 1024 ** 3),
  };

  // --dry-run plans without rendering, which is the safe way to preview what a
  // capacity budget or the dedup pass would drop.
  if (flags['dry-run']) {
    const scan = await scanLibrary({
      roots: opts.roots,
      ffprobe: opts.ffprobe,
      scratch: opts.scratch,
      onProgress: (done, total) => {
        if (done === total) console.log(`  scanned ${total} file(s)`);
      },
    });
    const plan = await planBatch(scan.entries, opts);
    console.log(`plan: ${plan.items.length} item(s), ${plan.duplicates.length} duplicate group(s)`);
    for (const item of plan.items) {
      const mark = item.skipped ? `skip (${item.skipped})` : 'render';
      console.log(`  ${mark}  ${item.outputPath}`);
    }
    for (const err of scan.errors) console.log(`  scan error: ${err.path}: ${err.message}`);
    return 0;
  }

  let lastStage = '';
  const report = await runBatch({
    ...opts,
    onProgress: (ev) => {
      if (ev.stage !== lastStage) {
        lastStage = ev.stage;
        console.log(`  .. ${ev.stage}`);
      } else if (ev.total > 0) {
        process.stdout.write(`\r  .. ${ev.stage} ${ev.done}/${ev.total}   `);
      }
    },
  });
  process.stdout.write('\r'.padEnd(40) + '\r');
  printBatchReport(report);

  const manifestPath = strFlag(flags, 'manifest');
  if (manifestPath) {
    const p = abs(manifestPath);
    // A manifest is a convenience artifact: the batch itself already succeeded and
    // its results are on disk. Writing it must never turn a good run into a
    // non-zero exit, so failures are reported and swallowed.
    try {
      writeManifest(report, p);
      console.log(`manifest : ${p}`);
    } catch (err) {
      console.error(`manifest not written (${p}): ${(err as Error).message}`);
    }
  }

  return report.items.some((i) => i.status === 'failed') ? 1 : 0;
}

function usage(): void {
  console.log(
    [
      'Audio USB Studio (M1)',
      '',
      'Commands:',
      '  doctor [--json]                         check ffmpeg/ffprobe run and report AI denoise',
      '  probe <file...> [--json]                 inspect media files',
      '  edit <file> --out <out> [options]         edit one file and render it',
      '  save-project <file> --out <json>          write a project JSON',
      '  render <project.json> --out <file>         render a project JSON',
      '  verify <file> [--preset usb|flac|wav]     verify an output file',
      '  batch <dir...> --out <dir> [options]      build a USB batch from folders',
      '',
      'batch options:',
      '  --out <dir>           output directory (required)',
      '  --preset usb|flac|wav defaults to usb (MP3 320k CBR / 44.1k / stereo)',
      '  --pattern <p>         filename pattern, e.g. "{track} {artist} - {title}"',
      '  --dedup               detect and drop duplicates (acoustic + exact)',
      '  --lufs <n>            loudness target, default -14',
      '  --true-peak <db>      true-peak ceiling, default -1.0',
      '  --lra <n>             loudness range, default 11',
      '  --no-loudness         skip normalization entirely',
      '  --capacity-gb <n>     keep only what fits in n GiB; the rest is skipped',
      '  --concurrency <n>     parallel renders, default CPU cores - 1',
      '  --manifest <file>     write a JSON manifest of the run',
      '  --dry-run             plan only; render nothing',
      '',
      'edit options:',
      '  --trim a:b            keep only a..b seconds',
      '  --delete a:b          remove a..b seconds',
      '  --silence a:b         replace a..b with silence',
      '  --split t             split at t seconds',
      '  --merge-adjacent      rejoin contiguous same-source clips',
      '  --gain db             gain in dB',
      '  --fade in:out         fade in/out seconds',
      '  --reverse             reverse each clip',
      '  --denoise gentle|moderate|strong',
      '  --declip --declick',
      '  --eq f:g[:w],...      parametric EQ bands',
      '  --echo ms[:decay]',
      '  --compressor th:ratio',
      '  --highpass hz   --lowpass hz',
      '  --preset usb|flac|wav',
      '  --tag k=v,k=v        set output metadata',
      '  --no-loudness        skip two-pass loudness normalization',
      '  --ffmpeg-dir <dir>    where ffmpeg.exe/ffprobe.exe live',
      '  --scratch <dir>       scratch directory for reports',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

/**
 * Run the CLI for an explicit argument vector.
 *
 * Exported so the packaged launcher can reuse the exact same command dispatch
 * rather than re-implementing it; `argv` excludes the node executable and
 * script path, exactly like `process.argv.slice(2)`.
 */
export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    usage();
    return 0;
  }

  const ctx = makeCtx(parsed.flags);

  switch (parsed.command) {
    case 'doctor':
      return cmdDoctor(ctx, parsed.flags);
    case 'probe':
      return cmdProbe(ctx, parsed.positional, parsed.flags);
    case 'edit':
      return cmdEdit(ctx, parsed.positional, parsed.flags);
    case 'save-project':
      return cmdSaveProject(ctx, parsed.positional, parsed.flags);
    case 'render':
      return cmdRender(ctx, parsed.positional, parsed.flags);
    case 'verify':
      return cmdVerify(ctx, parsed.positional, parsed.flags);
    case 'batch':
      return cmdBatch(ctx, parsed.positional, parsed.flags);
    default:
      usage();
      return 1;
  }
}

/* Run only when this file is the process entry point. A packaged launcher
 * imports `runCli` instead, so the side effect must not fire there. */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`ERROR: ${(err as Error).message}`);
      process.exit(1);
    });
}
