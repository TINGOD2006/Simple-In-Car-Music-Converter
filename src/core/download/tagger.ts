/**
 * Writing metadata (and cover art) onto downloaded raw audio, per container.
 *
 * Arg tables come from a planning-time probe against ffmpeg 8.1 (2026-10-18):
 *   - .mp3 / .m4a accept a second (cover) input remuxed as attached_pic; mp3
 *     additionally needs `-id3v2_version 3` so Windows Explorer reads it.
 *   - .ogg / .webm take text tags only (`-map_metadata -1 -metadata k=v`);
 *     ogg outright rejects picture streams ("Unsupported codec id").
 *
 * Everything runs through runFfmpeg so a hung child cannot wedge the queue
 * (the batch engine learned that lesson the hard way).
 *
 * Tags are written in place: ffmpeg writes to a temp sibling, which is renamed
 * over the raw file only after a clean exit — a failed tag never destroys the
 * downloaded audio.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { runFfmpeg, timeoutMessage } from '../ffbin.ts';
import type { TrackMeta } from './types.ts';

/** Which containers accept embedded cover art. */
export const CONTAINER_SUPPORT: Record<string, { cover: boolean }> = {
  '.mp3': { cover: true },
  '.m4a': { cover: true },
  '.ogg': { cover: false },
  '.webm': { cover: false },
};

export interface WriteTagsOptions {
  ffmpeg: string;
  /** 1-based track number written as the `track` tag. */
  trackNumber?: number;
  /** Cover image (JPEG/PNG) to embed; ignored where CONTAINER_SUPPORT says no. */
  coverPath?: string | null;
  /** ffmpeg kill timer; default 60 s — tagging a song is not a render. */
  timeoutMs?: number;
}

function metadataArgs(meta: TrackMeta, trackNumber?: number): string[] {
  const args = ['-map_metadata', '-1'];
  args.push('-metadata', `title=${meta.title}`);
  args.push('-metadata', `artist=${meta.artists}`);
  if (meta.album) args.push('-metadata', `album=${meta.album}`);
  if (trackNumber !== undefined) args.push('-metadata', `track=${trackNumber}`);
  return args;
}

/**
 * Write tags (and cover, where supported) onto `rawPath` in place.
 *
 * @returns the tagged path (the same path — the file was replaced atomically).
 */
export async function writeTags(
  rawPath: string,
  meta: TrackMeta,
  opts: WriteTagsOptions,
): Promise<string> {
  const ext = extname(rawPath).toLowerCase();
  const support = CONTAINER_SUPPORT[ext];
  if (!support) {
    throw new Error(`無法寫入標籤：不支援的音訊容器 ${ext}`);
  }

  const wantCover = support.cover && opts.coverPath != null;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawPath];
  if (wantCover) args.push('-i', opts.coverPath!);

  if (wantCover) {
    args.push('-map', '0:a', '-map', '1');
    args.push('-c', 'copy');
  } else {
    args.push('-c', 'copy');
  }
  args.push(...metadataArgs(meta, opts.trackNumber));
  if (ext === '.mp3') args.push('-id3v2_version', '3');
  if (wantCover) args.push('-disposition:v', 'attached_pic');

  const dir = dirname(rawPath);
  const temp = join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tagging${ext}`);
  args.push(temp);

  const result = await runFfmpeg(opts.ffmpeg, args, { cwd: dir, timeoutMs: opts.timeoutMs ?? 60_000 });
  if (result.code !== 0) {
    rmSync(temp, { force: true });
    const tail = result.timedOut
      ? timeoutMessage(rawPath, opts.timeoutMs ?? 60_000)
      : `ffmpeg 結束碼 ${result.code}`;
    throw new Error(`寫入標籤失敗（${rawPath}）：${tail}`);
  }
  renameSync(temp, rawPath);
  return rawPath;
}

let coverSeq = 0;

/**
 * Download cover art into `dir` (as `cover-<n>.jpg`).
 *
 * Network trouble of any kind — bad status, timeout, refused connection —
 * resolves to null: a missing cover degrades gracefully, it never fails the
 * download of the audio it decorates.
 */
export async function fetchCover(
  coverUrl: string,
  dir: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  try {
    const res = await fetch(coverUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    coverSeq = (coverSeq + 1) % 1_000_000;
    const out = join(dir, `cover-${Date.now().toString(36)}-${coverSeq.toString(36)}.jpg`);
    writeFileSync(out, buf);
    return out;
  } catch {
    return null;
  }
}
