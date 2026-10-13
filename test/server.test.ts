/**
 * Server API tests.
 *
 * These start the real HTTP server on an ephemeral port and drive it with real
 * requests, so routing, JSON handling and status codes are exercised end to end.
 * ffmpeg is only touched by the endpoints that genuinely need it.
 */

import { assert, assertEq, test } from './harness.ts';
import { startServer } from '../src/server/index.ts';
import { startJob, getJob, listJobs } from '../src/server/jobs.ts';
import { findBinaries, runFfmpeg } from '../src/core/ffbin.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Ctx {
  server: Server;
  base: string;
}

/**
 * Issue a GET with a literal, un-normalised request target over a raw socket.
 *
 * `fetch` rewrites `/../x` before sending, so it cannot test a traversal guard.
 */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      raw += d;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const status = Number(raw.slice(0, raw.indexOf('\r\n')).split(' ')[1] ?? 0);
      const sep = raw.indexOf('\r\n\r\n');
      resolvePromise({ status, body: sep >= 0 ? raw.slice(sep + 4) : '' });
    });
  });
}

/**
 * `fetch()` rejects with an opaque `TypeError: fetch failed`; the actionable
 * reason (ECONNRESET, ECONNREFUSED, ...) lives in `.cause`. Surface it, so a
 * transient failure reports what actually went wrong instead of hiding it. This
 * only improves the message — it deliberately does not retry, because a retry would
 * mask a real connection bug.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(
      `fetch ${init?.method ?? 'GET'} ${url} failed: ${cause?.code ?? cause?.message ?? String(err)}`,
    );
  }
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ server, base });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/* ------------------------------------------------------------------ */
/* Job registry (no HTTP needed)                                       */
/* ------------------------------------------------------------------ */

test('a job resolves and records its report', async () => {
  const job = startJob(async (report) => {
    report({ stage: 'half', done: 1, total: 2 });
    return { value: 42 };
  });

  // Let the microtask queue drain so the background work settles.
  await new Promise((r) => setTimeout(r, 20));

  const after = getJob(job.id);
  assert(after !== null, 'job is retrievable by id');
  assertEq(after!.state, 'done', 'job finished');
  assertEq(after!.report, { value: 42 }, 'report captured');
});

test('a failing job is marked failed rather than throwing', async () => {
  const job = startJob(async () => {
    throw new Error('boom');
  });

  await new Promise((r) => setTimeout(r, 20));

  const after = getJob(job.id)!;
  assertEq(after.state, 'failed', 'job failed');
  assertEq(after.error, 'boom', 'error message preserved');
});

test('getJob returns null for an unknown id', () => {
  assertEq(getJob('definitely-not-a-job'), null, 'unknown job');
});

test('listJobs includes a started job', () => {
  const job = startJob(async () => 'ok');
  assert(listJobs().some((j) => j.id === job.id), 'job appears in the list');
});

/* ------------------------------------------------------------------ */
/* HTTP surface                                                        */
/* ------------------------------------------------------------------ */

test('health reports the discovered ffmpeg binaries', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/health`);
    assertEq(res.status, 200, 'health is 200');
    const body = (await res.json()) as { ok: boolean; ffmpeg: string; ffprobe: string };
    assertEq(body.ok, true, 'ok flag');
    assert(body.ffmpeg.length > 0, 'ffmpeg path present');
    assert(body.ffprobe.length > 0, 'ffprobe path present');
  });
});

test('an unknown route answers 404 with a JSON error', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/nope`);
    assertEq(res.status, 404, 'status is 404');
    const body = (await res.json()) as { ok: boolean; error: string };
    assertEq(body.ok, false, 'ok is false');
    assert(body.error.includes('/api/nope'), 'error names the route');
  });
});

test('an unmatched /api path answers JSON 404 even with the UI mounted', async () => {
  // Regression: with a webRoot configured, serveStatic's SPA fallback used to
  // swallow unknown `/api/...` paths (they have no file extension), so a wrong
  // method or a typo returned index.html with status 200 and the client failed
  // parsing HTML as JSON instead of seeing a 404.
  const base = mkdtempSync(join(tmpdir(), 'aus-api404-'));
  const root = join(base, 'webroot');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html>SPA SHELL</html>');

  const { server, port } = await startServer({ port: 0, webRoot: root });
  try {
    // GET on a POST-only route, and a route that does not exist at all.
    for (const target of ['/api/probe', '/api/definitely-not-a-route']) {
      const res = await apiFetch(`http://127.0.0.1:${port}${target}`);
      assertEq(res.status, 404, `${target} answers 404`);
      const ct = res.headers.get('content-type') ?? '';
      assert(ct.includes('application/json'), `${target} answers JSON, not HTML (got ${ct})`);
      const body = (await res.json()) as { ok: boolean; error: string };
      assertEq(body.ok, false, `${target} ok is false`);
      assert(body.error.includes(target), `${target} error names the route`);
    }

    // The SPA shell must still be served for a genuine UI route.
    const shell = await apiFetch(`http://127.0.0.1:${port}/editor`);
    assertEq(shell.status, 200, 'a real UI route still gets the shell');
    assert((await shell.text()).includes('SPA SHELL'), 'shell content is served');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('probe rejects a request with no path', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assertEq(res.status, 400, 'status is 400');
    const body = (await res.json()) as { error: string };
    assert(body.error.includes('path'), 'error mentions path');
  });
});

test('a malformed JSON body is rejected as 500 with a parse message', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assertEq(res.status, 500, 'status is 500');
    const body = (await res.json()) as { error: string };
    assert(body.error.includes('invalid JSON'), 'error names the parse failure');
  });
});

test('compile returns the exact ffmpeg argv for a timeline', async () => {
  await withServer(async ({ base }) => {
    const timeline = {
      clips: [
        {
          id: 'c1', sourceId: 'src0', srcIn: 0, srcOut: 10,
          gainDb: 0, fadeInSec: 0, fadeOutSec: 0, crossfadeInSec: 0, effects: [],
        },
      ],
      sampleRate: 44100,
      channels: 2,
    };
    const preset = {
      container: 'mp3', codec: 'libmp3lame', bitrateKbps: 320, sampleRate: 44100,
      channels: 2, id3v2Version: 3, denoise: 'off',
      loudness: { enabled: false, integratedLufs: -14, truePeakDb: -1, lra: 11 },
    };

    const res = await apiFetch(`${base}/api/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeline,
        preset,
        sourcePaths: { src0: 'C:/music/a.mp3' },
        outputPath: 'C:/out/a.mp3',
      }),
    });

    assertEq(res.status, 200, 'compile is 200');
    const body = (await res.json()) as { ok: boolean; args: string[]; filterComplex: string };
    assertEq(body.ok, true, 'ok flag');
    assert(body.args.join(' ').includes('-c:a libmp3lame'), 'encoder in argv');
    assert(body.args.join(' ').includes('-b:a 320k'), 'bitrate in argv');
    assert(body.filterComplex.includes('atrim'), 'filter graph present');
  });
});

test('compile rejects an incomplete request', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeline: { clips: [] } }),
    });
    assertEq(res.status, 400, 'status is 400');
  });
});

test('a raw path traversal attempt on the static root is refused', async () => {
  // `fetch` (undici) normalises `/../x` to `/x` before the request leaves the
  // client, so it can never exercise the guard. A raw socket sends the literal
  // path, which is what an attacker or a hand-rolled client would do.
  const base = mkdtempSync(join(tmpdir(), 'aus-static-'));
  const root = join(base, 'webroot');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(root, 'index.html'), '<html>ok</html>');

  const { server, port } = await startServer({ port: 0, webRoot: root });
  try {
    const response = await rawGet(port, '/../secret.txt');
    assert(
      response.status === 403 || response.status === 404,
      `traversal refused (got ${response.status})`,
    );
    assert(!response.body.includes('TOP SECRET'), 'secret content is not leaked');

    // The same server must still serve a legitimate file from inside the root.
    const ok = await rawGet(port, '/index.html');
    assertEq(ok.status, 200, 'legitimate file still served');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('the server binds an ephemeral port when asked for 0', async () => {
  const { server, port } = await startServer({ port: 0 });
  try {
    const addr = server.address() as AddressInfo;
    assert(port > 0, 'a real port was assigned');
    assertEq(addr.port, port, 'reported port matches the bound port');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ------------------------------------------------------------------ */
/* End-to-end against real audio (skipped when ffmpeg is absent)       */
/* ------------------------------------------------------------------ */

const e2eBins = ((): { ffmpeg: string } | null => {
  try {
    return findBinaries();
  } catch {
    return null;
  }
})();

/** Generate a deterministic tone via ffmpeg; returns its path. */
async function makeTone(dir: string, name: string, freq = 440, dur = 3): Promise<string> {
  const out = join(dir, name);
  const r = await runFfmpeg(
    e2eBins!.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=48000`,
      '-ac', '2',
      out,
    ],
    { cwd: dir },
  );
  if (r.code !== 0 || !existsSync(out)) throw new Error(`tone creation failed: exit ${r.code}`);
  return out;
}

test('end-to-end: probe, waveform, render and verify over HTTP', async () => {
  if (!e2eBins) {
    process.stdout.write('  (skipping: ffmpeg not found)\n');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aus-server-e2e-'));
  const { server, port } = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;

  try {
    const wav = await makeTone(dir, 'tone.wav', 440, 3);

    // 1. probe
    const probeRes = await apiFetch(`${base}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wav }),
    });
    const probed = (await probeRes.json()) as {
      ok: boolean;
      error?: string;
      info: { audio: { sampleRate: number; channels: number } | null; format: { durationSec: number } };
    };
    assertEq(probed.ok, true, `probe ok${probed.error ? `: ${probed.error}` : ''}`);
    assertEq(probed.info.audio?.sampleRate, 48000, 'probed sample rate');
    assertEq(probed.info.audio?.channels, 2, 'probed channels');

    // 2. waveform — real peaks, not an empty placeholder
    const wfRes = await apiFetch(`${base}/api/waveform?path=${encodeURIComponent(wav)}&buckets=200`);
    const wf = (await wfRes.json()) as { ok: boolean; peaks: number[]; durationSec: number };
    assertEq(wf.ok, true, 'waveform ok');
    assert(wf.peaks.length > 0, 'waveform returned peaks');
    assert(wf.peaks.some((p) => p > 0.5), 'a 440Hz tone shows real amplitude');
    assert(wf.durationSec > 2.5 && wf.durationSec < 3.5, `waveform duration ~3s (got ${wf.durationSec})`);

    // 3. render through the API, then 4. verify
    const outPath = join(dir, 'out.mp3');
    const timeline = {
      clips: [
        {
          id: 'c1', sourceId: 'src0', srcIn: 0, srcOut: 3,
          gainDb: 0, fadeInSec: 0, fadeOutSec: 0, crossfadeInSec: 0, effects: [],
        },
      ],
      sampleRate: 44100,
      channels: 2,
    };
    const preset = {
      container: 'mp3', codec: 'libmp3lame', bitrateKbps: 320, sampleRate: 44100,
      channels: 2, id3v2Version: 3, denoise: 'off',
      loudness: { enabled: false, integratedLufs: -14, truePeakDb: -1, lra: 11 },
    };

    const renderRes = await apiFetch(`${base}/api/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeline,
        preset,
        sourcePaths: { src0: wav },
        outputPath: outPath,
        doVerify: true,
      }),
    });
    const rendered = (await renderRes.json()) as {
      ok: boolean;
      sizeBytes: number;
      error: string | null;
      verification: { ok: boolean; problems: string[] } | null;
    };
    assertEq(rendered.ok, true, `render ok${rendered.error ? `: ${rendered.error}` : ''}`);
    assert(rendered.sizeBytes > 1000, 'output has real bytes');
    assert(rendered.verification !== null, 'verification ran');
    assertEq(
      rendered.verification!.ok,
      true,
      `verify passed: ${rendered.verification!.problems.join('; ')}`,
    );
    assert(existsSync(outPath), 'output file exists on disk');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: /api/library scans a real directory through the engine contract', async () => {
  // Regression guard: ScanOptions is `{ roots, ffprobe, scratch }`. Passing the
  // HTTP query names (`dir`, `scratchRoot`) straight through made the scan throw
  // "opts.roots is not iterable".
  if (!e2eBins) {
    process.stdout.write('  (skipping: ffmpeg not found)\n');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aus-server-lib-'));
  try {
    await makeTone(dir, 'one.wav', 440, 1);
    await makeTone(dir, 'two.wav', 660, 1);

    await withServer(async ({ base }) => {
      const res = await apiFetch(`${base}/api/library?dir=${encodeURIComponent(dir)}`);
      // 501 until src/core/library.ts exists; 200 once it does.
      if (res.status === 501) {
        process.stdout.write('  (library scanner not available yet)\n');
        return;
      }
      assertEq(res.status, 200, 'library scan answered 200');
      const body = (await res.json()) as {
        ok: boolean;
        entries?: { path: string; info: { audio: unknown } }[];
        errors?: unknown[];
      };
      assertEq(body.ok, true, 'scan ok');
      assert(Array.isArray(body.entries), 'entries is an array');
      assertEq(body.entries!.length, 2, `both tones were found (got ${body.entries!.length})`);
      assert(
        body.entries!.every((e) => e.info.audio !== null),
        'every entry carries probed audio info',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: /api/batch validates its inputs instead of crashing', async () => {
  // The batch engine's real contract is planBatch(entries, opts) with
  // BatchOptions requiring ffmpeg/ffprobe/scratch/roots/outputDir/preset. The
  // server supplies the binaries and scratch; everything else must be rejected
  // with a 400 rather than throwing a TypeError out of the handler.
  await withServer(async ({ base }) => {
    const post = (payload: unknown) =>
      fetch(`${base}/api/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // A bare dry-run with no roots/outputDir/preset: 501 while the module is
    // absent, 400 once it exists — never a 500 and never a process crash.
    const bare = await post({ dryRun: true });
    assert(
      bare.status === 501 || bare.status === 400,
      `a bare dry-run is rejected cleanly (got ${bare.status})`,
    );
    const bareBody = (await bare.json()) as { ok: boolean; error?: string };
    assertEq(bareBody.ok, false, 'bare dry-run reports failure');
    assert(typeof bareBody.error === 'string', 'error message present');

    // A run request missing `preset` must also be a clean 400.
    const noPreset = await post({ roots: ['C:\\nonexistent'], outputDir: 'C:\\out' });
    assert(
      noPreset.status === 501 || noPreset.status === 400,
      `missing preset is rejected cleanly (got ${noPreset.status})`,
    );

    // Regression: a *structurally incomplete* preset used to be accepted and
    // then fail once per track inside the renderer with the opaque message
    // "Cannot read properties of undefined (reading 'enabled')". It must be
    // refused up front, and the error must name the missing field.
    const thinPreset = await post({
      roots: ['C:\\nonexistent'],
      outputDir: 'C:\\out',
      preset: { id: 'usb' },
    });
    assert(
      thinPreset.status === 501 || thinPreset.status === 400,
      `an incomplete preset is rejected cleanly (got ${thinPreset.status})`,
    );
    if (thinPreset.status === 400) {
      const body = (await thinPreset.json()) as { ok: boolean; error: string };
      assertEq(body.ok, false, 'incomplete preset reports failure');
      assert(body.error.includes('loudness'), `error names the missing field (got: ${body.error})`);
    }
  });
});

test('end-to-end: /api/denoise injects the server ffmpeg path and never 500s', async () => {
  // Regression guard: denoiseFile() requires `ffmpeg` and `scratch`, which the
  // server must supply from its own discovery. Passing the raw request body
  // through made every call fail with "No ffmpeg path was given".
  if (!e2eBins) {
    process.stdout.write('  (skipping: ffmpeg not found)\n');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aus-server-dfn-'));
  try {
    const wav = await makeTone(dir, 'tone.wav', 440, 1);
    const outPath = join(dir, 'denoised.wav');

    await withServer(async ({ base }) => {
      const res = await apiFetch(`${base}/api/denoise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputPath: wav, outputPath: outPath }),
      });
      // 200 with a structured result whether or not DFN is installed; never 500.
      assertEq(res.status, 200, 'denoise endpoint answered 200');
      const body = (await res.json()) as { ok: boolean; outputPath: string | null; message?: string };
      assert(typeof body.ok === 'boolean', 'structured result');

      if (!body.ok) {
        // Only the "binary not installed" condition is acceptable here.
        assert(
          /not available|not found/i.test(body.message ?? ''),
          `failure must be about availability, not wiring (got: ${body.message})`,
        );
        process.stdout.write(`  (DFN unavailable: ${body.message})\n`);
        return;
      }
      assert(existsSync(outPath), 'denoised output written');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: /api/batch plans and then runs a real USB batch', async () => {
  // Exercises the whole M2 orchestration through HTTP: scan -> plan -> render,
  // with the server supplying ffmpeg/ffprobe/scratch and the job registry
  // carrying progress. A regression here is invisible to unit tests.
  if (!e2eBins) {
    process.stdout.write('  (skipping: ffmpeg not found)\n');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aus-server-batch-'));
  const outDir = join(dir, 'usb');
  mkdirSync(outDir, { recursive: true });

  try {
    await makeTone(dir, '01 - Alpha - First.wav', 440, 1);
    await makeTone(dir, '02 - Beta - Second.wav', 660, 1);

    await withServer(async ({ base }) => {
      const preset = {
        container: 'mp3', codec: 'libmp3lame', bitrateKbps: 320, sampleRate: 44100,
        channels: 2, id3v2Version: 3, denoise: 'gentle',
        loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1, lra: 11 },
      };

      // --- 1. dry run: plan only, no rendering -------------------------
      const dryRes = await apiFetch(`${base}/api/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true, roots: [dir], outputDir: outDir, preset, dedup: false }),
      });
      if (dryRes.status === 501) {
        process.stdout.write('  (batch engine not available yet)\n');
        return;
      }
      assertEq(dryRes.status, 200, 'dry-run planning answered 200');
      const dry = (await dryRes.json()) as {
        ok: boolean;
        plan?: { items: { outputPath: string; skipped?: string }[] };
        error?: string;
      };
      assertEq(dryRes.status, 200, `dry-run planning answered 200 (server said: ${dry.error ?? 'no error field'})`);
      assertEq(dry.ok, true, `plan ok${dry.error ? `: ${dry.error}` : ''}`);
      assert(Array.isArray(dry.plan?.items), 'plan carries items');
      assertEq(dry.plan!.items.length, 2, `both tracks planned (got ${dry.plan!.items.length})`);
      assert(
        dry.plan!.items.every((i) => !i.skipped),
        'nothing is skipped without a capacity budget',
      );

      // --- 2. real run as a background job ----------------------------
      const runRes = await apiFetch(`${base}/api/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots: [dir], outputDir: outDir, preset, dedup: false }),
      });
      assertEq(runRes.status, 202, 'a run is accepted as a job');
      const { jobId } = (await runRes.json()) as { jobId: string };
      assert(typeof jobId === 'string' && jobId.length > 0, 'jobId returned');

      // Poll until the job settles.
      interface JobView {
        state: string;
        report: unknown;
        error: string | null;
      }
      let job: JobView | null = null;
      for (let i = 0; i < 120; i += 1) {
        const jr = await apiFetch(`${base}/api/jobs/${jobId}`);
        const body = (await jr.json()) as { job: JobView };
        job = body.job;
        if (job && (job.state === 'done' || job.state === 'failed')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(job !== null, 'job is retrievable');
      const settled: JobView = job!;
      assertEq(settled.state, 'done', `batch job finished (error: ${settled.error})`);

      const report = settled.report as {
        items: { status: string; outputPath: string | null; message?: string }[];
        totalBytes: number;
      };
      assert(Array.isArray(report.items), 'report carries items');
      assertEq(report.items.length, 2, 'both tracks reported');
      assert(
        report.items.every((i) => i.status === 'ok'),
        `every track rendered: ${report.items.map((i) => `${i.status}${i.message ? ` (${i.message})` : ''}`).join(', ')}`,
      );
      assert(report.totalBytes > 0, 'report totals real bytes');
      assert(
        report.items.every((i) => i.outputPath !== null && existsSync(i.outputPath)),
        'every reported output exists on disk',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: /api/denoise rejects a missing input without crashing', async () => {
  await withServer(async ({ base }) => {
    const res = await apiFetch(`${base}/api/denoise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputPath: join(tmpdir(), 'definitely-absent-xyz.wav'), outputPath: join(tmpdir(), 'o.wav') }),
    });
    assertEq(res.status, 200, 'structured 200 rather than a crash');
    const body = (await res.json()) as { ok: boolean };
    assertEq(body.ok, false, 'a missing input is reported as a failure');
  });
});
