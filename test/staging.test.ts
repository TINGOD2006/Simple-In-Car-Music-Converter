/**
 * staging.ts — the sweeper is allowed to be forgetful, never destructive.
 *
 * Every test here is about a *decision the sweeper makes*, not about a string it
 * prints: files are really created, really aged with `utimesSync`, really held open,
 * and then really checked on disk. The rule-(b) tests each carry a control file in
 * the same directory with the same age, so "kept" cannot pass by accident — the
 * sweep must remove the control in the same call.
 *
 * Sandbox note (docs/ENVIRONMENT.md 2.3 / library.test.ts): node cannot mkdir under
 * the workspace, so scratch lives under os.tmpdir().
 */

import { existsSync, fchmodSync, mkdirSync, openSync, closeSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assert, assertEq, test } from './harness.ts';
import { STAGING_MARK, isStagingName, sweepStaleStaging } from '../src/core/staging.ts';

const ROOT = join(tmpdir(), 'aus-staging');
const HOUR = 60 * 60 * 1000;

function scratch(tag: string): string {
  const d = join(ROOT, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Backdate a file's mtime, the way a crashed run leaves it behind. */
function age(file: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Delete a scratch tree, retrying while a just-killed holder releases handles. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(100);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Hold `file` open from another process with an explicit share mode, i.e. the one
 * kind of "in use" that Windows actually enforces against our own probes.
 *
 * A *Node* handle cannot do this. libuv opens with
 * `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so on this machine a
 * second `openSync('r+')` on a file we already hold SUCCEEDS and `unlinkSync`
 * deletes it anyway — verified, and recorded in docs/SPEC.md 9.4. Only .NET's
 * `[System.IO.File]::Open(..., FileShare.X)` produces the sharing violations rule
 * (b) exists to respect. The child signals readiness through a file because piped
 * stdio is denied in this environment (docs/ENVIRONMENT.md 2.1).
 *
 * Measured on this machine (same probe as docs/SPEC.md 9.4), for a stale staging
 * file held by the child:
 *
 *   FileShare.None      -> statSync ok, openSync('r+') EBUSY, unlinkSync EBUSY
 *   FileShare.Read      -> statSync ok, openSync('r+') EBUSY, unlinkSync EBUSY
 *   FileShare.ReadWrite -> statSync ok, openSync('r+') ok,    unlinkSync EBUSY
 *
 * So a `None`/`Read` holder is never deleted, but which guard saves it cannot be
 * told apart (rule (b) and the unlink fallback both fire). `ReadWrite` is the libuv
 * shape — another AudioUsbStudio instance mid-render — and there rule (b) cannot
 * see the holder at all, which makes it the case that isolates the unlink guard.
 *
 * Returns null when no holder could be established, so the caller can skip instead
 * of failing on an environment that has no PowerShell.
 */
async function startExclusiveHolder(
  file: string,
  ready: string,
  share: 'None' | 'Read' | 'ReadWrite' = 'None',
): Promise<ChildProcess | null> {
  const q = (s: string): string => s.replace(/'/g, "''");
  const script =
    `$fs = [System.IO.File]::Open('${q(file)}', 'Open', 'ReadWrite', '${share}'); ` +
    `Set-Content -LiteralPath '${q(ready)}' -Value 'held' -NoNewline; ` +
    `Start-Sleep -Seconds 30; $fs.Close()`;

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });

  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    // The sentinel is written only *after* the handle is taken, so its presence
    // proves the file is genuinely exclusively held.
    if (existsSync(ready)) return child;
    if (spawnFailed) break;
    await delay(50);
  }
  await stopHolder(child);
  return null;
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit').then(
    () => true,
    () => true,
  );
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  await Promise.race([exited, delay(5000)]);
}

/* ------------------------------------------------------------------ */
/* The naming contract                                                 */
/* ------------------------------------------------------------------ */

test('staging: STAGING_MARK is the exact string every writer and reader shares', () => {
  assertEq(STAGING_MARK, '.aus-tmp-', 'the mark is exactly what batch.ts puts in the name');
  assert(
    isStagingName(`Song${STAGING_MARK}u9nvkk.mp3`),
    'a name built the way batch.ts builds it is recognised',
  );
  // The reported name from the real incident must be recognised byte for byte.
  assert(
    isStagingName('Attack on Titan - Ending 5 FullName of Loveby cinema staff.aus-tmp-u9nvkk.mp3'),
    'the exact staging name from the 199-item incident report is recognised',
  );
});

test('staging: isStagingName matches the mark in any casing, and only the mark', () => {
  const yes = [
    'song.aus-tmp-u9nvkk.mp3',
    'song.AUS-TMP-u9nvkk.mp3',
    'SONG.Aus-Tmp-U9NVKK.MP3',
    'song.aus-tmp-.mp3',
    'song.aus-tmp-abc123.flac',
    '.aus-tmp-abc123.mp3',
    'a.aus-tmp-b.aus-tmp-c.mp3',
  ];
  for (const n of yes) assert(isStagingName(n), `"${n}" carries the mark and must be recognised`);

  const no = [
    'song.mp3',
    'aus-tmp-song.mp3',
    'song.aus-tmpx.mp3',
    'song.aus-tmp.mp3',
    'song.mp3.aus-tmp',
    'song.aus tmp.mp3',
    'notes.txt',
    '',
  ];
  for (const n of no) assert(!isStagingName(n), `"${n}" does not carry the mark`);
});

/* ------------------------------------------------------------------ */
/* Rule (a): only stale staging files                                  */
/* ------------------------------------------------------------------ */

test('staging: a stale staging file is removed and a fresh one is kept', () => {
  const dir = scratch('stale');
  try {
    const old = join(dir, 'Song - Artist.aus-tmp-aaa111.mp3');
    const fresh = join(dir, 'Other - Artist.aus-tmp-bbb222.mp3');
    writeFileSync(old, 'left behind by a crashed run');
    writeFileSync(fresh, 'a render is still writing this');
    age(old, 2 * HOUR);

    const r = sweepStaleStaging([dir]);
    assertEq(r.removed, [old], 'the two-hour-old staging file was removed');
    assertEq(r.kept, [fresh], 'the fresh staging file was kept');
    assert(!existsSync(old), 'the stale file is gone from disk');
    assert(existsSync(fresh), 'the fresh file is still on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staging: olderThanMs decides the boundary and nothing else', () => {
  const dir = scratch('window');
  try {
    const file = join(dir, 'Song.aus-tmp-ccc333.mp3');
    writeFileSync(file, 'thirty minutes old');
    age(file, 30 * 60 * 1000);

    const kept = sweepStaleStaging([dir], HOUR);
    assertEq(kept.removed, [], 'half an hour old is inside a one-hour window: kept');
    assertEq(kept.kept, [file], 'and reported as kept');
    assert(existsSync(file), 'still on disk');

    const swept = sweepStaleStaging([dir], 10 * 60 * 1000);
    assertEq(swept.removed, [file], 'the same file is stale once the window is ten minutes');
    assertEq(swept.kept, [], 'nothing left to keep');
    assert(!existsSync(file), 'and it is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staging: a non-staging file is never touched, however old or unreachable', () => {
  const dir = scratch('normal');
  try {
    const song = join(dir, 'Song.mp3');
    const cover = join(dir, 'cover.jpg');
    const ghost = join(dir, 'LooksLikeAudio.aus-tmpx.mp3');
    writeFileSync(song, 'a real track');
    writeFileSync(cover, 'a real cover');
    writeFileSync(ghost, 'mark without its dash');
    age(song, 30 * 24 * HOUR);
    age(cover, 30 * 24 * HOUR);
    age(ghost, 30 * 24 * HOUR);

    // A one-millisecond window makes everything old enough to delete.
    const r = sweepStaleStaging([dir], 1);
    assertEq(r.removed, [], 'no non-staging file was removed');
    assertEq(r.kept, [], 'and none was even reported as a candidate');
    for (const f of [song, cover, ghost]) {
      assert(existsSync(f), `${f} survives a sweep with a one-millisecond window`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Rule (b): never delete something that is in use                      */
/* ------------------------------------------------------------------ */

test('staging: a stale staging file held open by an exclusive writer is kept, not deleted', async () => {
  // A foreign holder that grants no write sharing. Both guards fire here (rule (b)
  // refuses the open, and the unlink would fail anyway), so this test pins the
  // end-to-end promise — another process's file is never deleted — while the two
  // tests below isolate each guard separately.
  if (process.platform !== 'win32') {
    process.stdout.write('  (skipping: the exclusive-share holder is Windows-only)\n');
    return;
  }
  const dir = scratch('exclusive');
  let child: ChildProcess | null = null;
  try {
    const held = join(dir, 'Song - Artist.aus-tmp-lock01.mp3');
    const loose = join(dir, 'Other - Artist.aus-tmp-lock02.mp3');
    const ready = join(dir, 'holder-ready');
    writeFileSync(held, 'the writer is still filling this in');
    writeFileSync(loose, 'a stale leftover nobody is using');
    age(held, 2 * HOUR);
    age(loose, 2 * HOUR);

    child = await startExclusiveHolder(held, ready);
    if (child === null) {
      process.stdout.write('  (skipping: could not start an exclusive holder process)\n');
      return;
    }

    const r = sweepStaleStaging([dir]);
    assert(r.kept.includes(held), `the held file was kept: ${JSON.stringify(r)}`);
    assert(!r.removed.includes(held), 'and was never reported as removed');
    assert(existsSync(held), 'the held file is still on disk after the sweep');
    assertEq(
      r.removed,
      [loose],
      'the equally old, unheld staging file was removed in the same sweep (the holder is what saved it)',
    );
  } finally {
    if (child) await stopHolder(child);
    await rmRetry(dir);
  }
});

test('staging: a stale staging file another process holds with write sharing is kept even though we can open it', async () => {
  // The libuv shape, and the one that matters most in practice: another
  // AudioUsbStudio instance is mid-render into this staging file with a handle that
  // shares read+write, so our rule-(b) probe `openSync('r+')` SUCCEEDS and cannot
  // see it. The guard that saves that render from being deleted is the unlink
  // fallback: Windows still refuses `unlinkSync` with EBUSY. If that fallback were
  // gone, this test is the one that would catch it.
  if (process.platform !== 'win32') {
    process.stdout.write('  (skipping: the sharing-mode holder is Windows-only)\n');
    return;
  }
  const dir = scratch('shared-write');
  let child: ChildProcess | null = null;
  try {
    const held = join(dir, 'Song - Artist.aus-tmp-writ01.mp3');
    const loose = join(dir, 'Other - Artist.aus-tmp-writ02.mp3');
    const ready = join(dir, 'holder-ready');
    writeFileSync(held, 'the writer is still filling this in');
    writeFileSync(loose, 'a stale leftover nobody is using');
    age(held, 2 * HOUR);
    age(loose, 2 * HOUR);

    child = await startExclusiveHolder(held, ready, 'ReadWrite');
    if (child === null) {
      process.stdout.write('  (skipping: could not start a sharing holder process)\n');
      return;
    }

    // Precondition, asserted so this test cannot pass for the boring reason: with
    // write sharing granted, rule (b) really does look straight through the holder.
    const fd = openSync(held, 'r+');
    closeSync(fd);

    const r = sweepStaleStaging([dir]);
    assert(r.kept.includes(held), `the held file was kept: ${JSON.stringify(r)}`);
    assert(!r.removed.includes(held), 'and was never reported as removed');
    assert(existsSync(held), 'the file another process is writing is still on disk');
    assertEq(r.removed, [loose], 'the equally old, unheld staging file was removed in the same sweep');
  } finally {
    if (child) await stopHolder(child);
    await rmRetry(dir);
  }
});

test('staging: a stale staging file this process holds open via openSync is kept when it cannot be opened for write', () => {
  // The file is held open with a real fd for the whole sweep, and put into the state
  // a live writer leaves behind: unwritable. `fchmodSync` goes through that very fd,
  // and on Windows it sets FILE_ATTRIBUTE_READONLY, which makes the sweep's
  // `openSync('r+')` probe fail exactly the way a foreign exclusive holder makes it
  // fail (EBUSY). What is pinned is rule (b)'s contract: a staging file the sweep
  // cannot open for write is never deleted.
  //
  // It is also the only scenario on Windows where rule (b) is *observably* the thing
  // that saves the file: a read-only file cannot be opened for write, yet it can
  // still be unlinked, so forcing `canOpenForWrite` to `true` really does delete it
  // and really does fail this test (mutation-checked).
  const dir = scratch('held-fd');
  try {
    const held = join(dir, 'Held - Artist.aus-tmp-fd0001.mp3');
    const loose = join(dir, 'Loose - Artist.aus-tmp-fd0002.mp3');
    writeFileSync(held, 'mid-render bytes');
    writeFileSync(loose, 'a stale leftover nobody is using');
    age(held, 2 * HOUR);
    age(loose, 2 * HOUR);

    const fd = openSync(held, 'r+');
    try {
      fchmodSync(fd, 0o444);
      const r = sweepStaleStaging([dir]);
      assert(r.kept.includes(held), `the held file was kept: ${JSON.stringify(r)}`);
      assert(!r.removed.includes(held), 'and was never reported as removed');
      assert(existsSync(held), 'the held file is still on disk');
      assertEq(r.removed, [loose], 'the equally old, unheld file was removed in the same sweep');
    } finally {
      fchmodSync(fd, 0o666);
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Shape of the walk                                                   */
/* ------------------------------------------------------------------ */

test('staging: the walk recurses into subdirectories but never deletes a directory', () => {
  const dir = scratch('nested');
  try {
    const album = join(dir, 'album');
    const markDir = join(dir, 'not-a-file.aus-tmp-dir');
    mkdirSync(album, { recursive: true });
    mkdirSync(markDir, { recursive: true });

    const deep = join(album, 'Deep - Artist.aus-tmp-ddd444.mp3');
    const insideMarkDir = join(markDir, 'Inner - Artist.aus-tmp-eee555.mp3');
    writeFileSync(deep, 'left behind deep in the tree');
    writeFileSync(insideMarkDir, 'left behind in a staging-named directory');
    age(deep, 3 * HOUR);
    age(insideMarkDir, 3 * HOUR);

    const r = sweepStaleStaging([dir]);
    assertEq(r.removed, [deep, insideMarkDir].sort(), 'staging files are swept at any depth');
    assertEq(r.kept, [], 'and nothing was left dangling');
    assert(!existsSync(deep) && !existsSync(insideMarkDir), 'the staging files themselves are gone');
    assert(existsSync(album), 'the album directory itself was never a candidate');
    assert(existsSync(markDir), 'a staging-named directory is left alone, not deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staging: a missing or unreadable directory is skipped instead of throwing', () => {
  const dir = scratch('missing');
  try {
    const r = sweepStaleStaging([join(dir, 'does-not-exist'), join(dir, 'nor-this-one')]);
    assertEq(r.removed, [], 'nothing to remove');
    assertEq(r.kept, [], 'nothing to keep either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
