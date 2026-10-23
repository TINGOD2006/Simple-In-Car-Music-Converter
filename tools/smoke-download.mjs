#!/usr/bin/env node
/**
 * End-to-end download smoke test. **Manual only — never run this in CI.**
 *
 * Every automated test in this project injects a fake yt-dlp runner, because
 * PyInstaller's one-file self-extraction is blocked in the development sandbox:
 * the shipped `yt-dlp.exe` cannot start there at all. That means the suite can
 * prove the wiring and cannot prove the product. This script is the other half —
 * it drives the real server, the real queue, the real providers and the real
 * binary against a real YouTube, and checks the bytes that came out.
 *
 * It starts the engine in this process on an ephemeral port, so there is nothing
 * to launch first:
 *
 *   node tools/smoke-download.mjs --route youtube-direct --url "https://music.youtube.com/playlist?list=..."
 *   node tools/smoke-download.mjs --route b               --url "https://open.spotify.com/track/..."
 *   node tools/smoke-download.mjs --route a               --url "https://open.spotify.com/track/..."   # needs a stored sp_dc cookie
 *
 * Exits 0 only when every track finished and every output file probed clean.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../src/server/index.ts';
import { probe } from '../src/core/probe.ts';
import { usbPreset } from '../src/core/edl.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `--route` accepts the UI's names and the engine's ids. */
const ROUTES = {
  a: 'spotify-direct',
  b: 'youtube-match',
  'youtube-direct': 'youtube-direct',
  'youtube-match': 'youtube-match',
  'spotify-direct': 'spotify-direct',
};

/** A whole playlist at two tracks at a time can take a while. */
const TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 1_000;

function usage() {
  console.log(`usage: node tools/smoke-download.mjs --route <${Object.keys(ROUTES).join('|')}> --url <url> [--keep]

  --route   a = spotify-direct (needs a stored sp_dc cookie), b = youtube-match,
            youtube-direct = paste a YouTube video/playlist URL
  --url     the URL to download
  --keep    leave the downloaded files and a scratch dir behind for inspection

This is a MANUAL check: it needs a real network and a real yt-dlp.exe.
`);
}

function parseArgs(argv) {
  const out = { route: '', url: '', keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--route') out.route = argv[(i += 1)] ?? '';
    else if (arg === '--url') out.url = argv[(i += 1)] ?? '';
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch + JSON, with the engine's own error text surfaced on failure. */
async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${init?.method ?? 'GET'} ${url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${body?.error ?? text}`);
  return body;
}

function post(url, body) {
  return call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function oneLine(record) {
  const done = record.tracks.filter((t) => t.state === 'done' || t.state === 'skipped').length;
  const failed = record.tracks.filter((t) => t.state === 'failed' || t.state === 'cancelled').length;
  return `${done}/${record.tracks.length} settled${failed ? `, ${failed} failed` : ''}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }
  const route = ROUTES[opts.route];
  if (!route) throw new Error(`--route must be one of ${Object.keys(ROUTES).join(', ')}`);
  if (!opts.url) throw new Error('--url is required');

  const settled = [];
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  // The destination is a real download target, so it is NOT put in the system
  // temp: measured on the machine this was built for, yt-dlp (a Python program)
  // is denied writing under `%TEMP%` while writing the same tree here succeeds.
  // A smoke run that fails for that reason proves nothing about the feature.
  const destination = mkdtempSync(join(ROOT, '.smoke-download-'));
  console.log(`engine:      ${base}`);
  console.log(`route:       ${route}`);
  console.log(`url:         ${opts.url}`);
  console.log(`destination: ${destination}\n`);

  try {
    const health = await call(`${base}/api/health`);
    console.log(`ffmpeg:      ${health.ffmpeg}`);
    console.log(`ffprobe:     ${health.ffprobe}\n`);

    const resolved = await post(`${base}/api/download/resolve`, { url: opts.url });
    const source = resolved.source;
    console.log(`resolved:    ${source.kind} "${source.name}" via ${source.platform}` +
      `${source.partial ? ' (DEGRADED metadata)' : ''}, ${source.tracks.length} track(s)`);
    if (source.platform === 'youtube' && route !== 'youtube-direct') {
      console.log(`note:        a YouTube source is always downloaded by youtube-direct; ${route} will be overridden`);
    }
    for (const [i, t] of source.tracks.entries()) {
      console.log(`  ${String(i + 1).padStart(3)}. ${t.artists} - ${t.title} (${t.durationSec}s)`);
    }
    console.log('');

    const started = await post(`${base}/api/download/start`, {
      source,
      route,
      destination,
      preset: usbPreset(),
    });
    const id = started.downloadId;
    console.log(`downloadId:  ${id}\n`);

    const deadline = Date.now() + TIMEOUT_MS;
    let record = null;
    for (;;) {
      const status = await call(`${base}/api/download/status?downloadId=${encodeURIComponent(id)}`);
      record = status.download;
      process.stdout.write(`\r  downloading… ${oneLine(record)}   `);
      if (record.finished) break;
      if (Date.now() > deadline) throw new Error(`timed out after ${TIMEOUT_MS / 60000} minutes`);
      await sleep(POLL_MS);
    }
    process.stdout.write('\r'.padEnd(60) + '\r');

    console.log(`finished in ${((Date.now() - (deadline - TIMEOUT_MS)) / 1000).toFixed(1)}s\n`);
    let bad = 0;
    for (const [i, t] of record.tracks.entries()) {
      const rate = t.rawKbps ? ` 來源 ${t.rawKbps} kbps` : '';
      const reason = t.reason ? ` (${t.reason})` : '';
      const where = t.outputPath ? ` -> ${t.outputPath}` : '';
      console.log(`  ${String(i + 1).padStart(3)}. ${t.state.padEnd(10)} ${t.meta.artists} - ${t.meta.title}${rate}${reason}${where}`);
      if (t.state !== 'done' && t.state !== 'skipped') bad += 1;
      if (t.state === 'done' && !t.outputPath) {
        console.log('       FAIL: the track is done but produced no output file');
        bad += 1;
      }
    }

    console.log('\nverifying every output with ffprobe:');
    for (const t of record.tracks) {
      if (!t.outputPath) continue;
      try {
        const size = statSync(t.outputPath).size;
        const info = await probe(health.ffprobe, t.outputPath, destination);
        const seconds = info.format?.durationSec ?? 0;
        const bitRate = info.format?.bitRate ?? info.audio?.bitRate ?? null;
        const ok = size > 1024 && seconds > 1;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.outputPath}`);
        console.log(`       ${info.format?.formatName ?? '?'}, ${seconds.toFixed(1)}s, ` +
          `${bitRate === null ? '?' : Math.round(bitRate / 1000)} kbps, ${size} bytes`);
        if (!ok) bad += 1;
      } catch (err) {
        console.log(`  FAIL ${t.outputPath}: ${err instanceof Error ? err.message : String(err)}`);
        bad += 1;
      }
    }

    settled.push(...record.tracks);
    console.log(`\n${bad === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${bad} problem(s))`}`);
    return bad === 0 ? 0 : 1;
  } finally {
    await new Promise((r) => server.close(() => r()));
    if (opts.keep) {
      console.log(`\nkept: ${destination}`);
    } else {
      try {
        rmSync(destination, { recursive: true, force: true });
      } catch {
        console.log(`\ncould not remove ${destination}; a child process may still hold it`);
      }
    }
    void settled;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nsmoke failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
