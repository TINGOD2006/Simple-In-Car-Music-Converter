/**
 * Duplicate detection.
 *
 * Two tiers, because they answer different questions:
 *
 *  1. **Exact** — same bytes, or same content hash. Free, and certain.
 *  2. **Acoustic** — same recording, different encode. A chromaprint fingerprint
 *     survives re-encoding, bitrate changes and small level differences, which is
 *     exactly what a music folder collected over years is full of.
 *
 * The fingerprint is produced by ffmpeg's `chromaprint` muxer writing to a file
 * (never stdout — see ffbin.ts). The compressed/base64 form is decoded in-process
 * by `decodeFingerprint`, a port of chromaprint's `FingerprintDecompressor`, so
 * comparison needs no external library.
 *
 * Calibration note (measured on this machine, synthetic material): identical
 * content -> 1.000; the same content re-encoded at 64k/128k -> 1.000; a copy
 * truncated to 5 s of 12 s -> 1.000; a copy offset by 3 s -> 0.89; *different*
 * melodic material -> 0.44-0.78. The default threshold of 0.90 sits above the
 * distinct-material band, so it catches re-encodes without merging distinct tracks.
 *
 * Stationary material (a sustained tone, a held drone) is the one case that breaks
 * this separation: it produces a *constant* chroma vector, and two unrelated tones
 * then differ in only a couple of bits, scoring ~0.91 — above the threshold. See
 * `isStationary`; such comparisons are declined rather than guessed at.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runFfmpeg } from './ffbin.ts';

/* ------------------------------------------------------------------ */
/* Fingerprinting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Compute a chromaprint fingerprint for `file`.
 *
 * Returns `null` (never throws) when ffmpeg is missing, the file is unreadable,
 * or it is too short to fingerprint — a single bad file must not abort a batch.
 *
 * The result file uses the `.fp` extension: some sandboxes intercept `.raw`
 * writes and redirect them to a scratch directory that may not exist.
 */
export async function fingerprint(
  ffmpeg: string,
  file: string,
  scratch: string,
): Promise<string | null> {
  if (!existsSync(file)) return null;

  const out = join(scratch, `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.fp`);
  try {
    const r = await runFfmpeg(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', file,
        '-f', 'chromaprint',
        '-fp_format', 'base64',
        out,
      ],
      { cwd: scratch },
    );
    if (r.code !== 0 || !existsSync(out)) return null;
    const text = readFileSync(out, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Fingerprint decoding                                                */
/* ------------------------------------------------------------------ */

function unpackedInt3Size(packed: number): number {
  return Math.floor((packed * 8) / 3);
}
function packedInt3Size(unpacked: number): number {
  return Math.floor((unpacked * 3 + 7) / 8);
}
function packedInt5Size(unpacked: number): number {
  return Math.floor((unpacked * 5 + 7) / 8);
}
function unpackedInt5Size(packed: number): number {
  return Math.floor((packed * 8) / 5);
}

/** Reverse of chromaprint's generated `PackInt3Array` (8 values <-> 3 bytes). */
function unpackInt3(buf: Buffer, off: number, count: number): Int32Array {
  const out = new Int32Array(count);
  let o = 0;
  let i = off;
  while (count - o >= 8 && i + 2 < buf.length) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    i += 3;
    out[o++] = b0 & 0x07;
    out[o++] = (b0 >> 3) & 0x07;
    out[o++] = ((b0 >> 6) & 0x03) | ((b1 & 0x01) << 2);
    out[o++] = (b1 >> 1) & 0x07;
    out[o++] = (b1 >> 4) & 0x07;
    out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x03) << 1);
    out[o++] = (b2 >> 2) & 0x07;
    out[o++] = (b2 >> 5) & 0x07;
  }
  const r = count - o;
  if (r === 7) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07;
    out[o++] = ((b0 >> 6) & 0x03) | ((b1 & 0x01) << 2);
    out[o++] = (b1 >> 1) & 0x07; out[o++] = (b1 >> 4) & 0x07;
    out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x03) << 1); out[o++] = (b2 >> 2) & 0x07;
  } else if (r === 6) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07;
    out[o++] = ((b0 >> 6) & 0x03) | ((b1 & 0x01) << 2);
    out[o++] = (b1 >> 1) & 0x07; out[o++] = (b1 >> 4) & 0x07;
    out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x03) << 1);
  } else if (r === 5) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07;
    out[o++] = ((b0 >> 6) & 0x03) | ((b1 & 0x01) << 2);
    out[o++] = (b1 >> 1) & 0x07; out[o++] = (b1 >> 4) & 0x07;
  } else if (r === 4) {
    const b0 = buf[i]!, b1 = buf[i + 1]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07;
    out[o++] = ((b0 >> 6) & 0x03) | ((b1 & 0x01) << 2); out[o++] = (b1 >> 1) & 0x07;
  } else if (r === 3) {
    const b0 = buf[i]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07; out[o++] = (b0 >> 6) & 0x03;
  } else if (r === 2) {
    const b0 = buf[i]!;
    out[o++] = b0 & 0x07; out[o++] = (b0 >> 3) & 0x07;
  } else if (r === 1) {
    out[o++] = buf[i]! & 0x07;
  }
  return out;
}

/** Reverse of chromaprint's generated `PackInt5Array` (8 values <-> 5 bytes). */
function unpackInt5(buf: Buffer, off: number, count: number): Int32Array {
  const out = new Int32Array(count);
  let o = 0;
  let i = off;
  while (count - o >= 8 && i + 4 < buf.length) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!, b3 = buf[i + 3]!, b4 = buf[i + 4]!;
    i += 5;
    out[o++] = b0 & 0x1f;
    out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f;
    out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x0f) << 1);
    out[o++] = ((b2 >> 4) & 0x0f) | ((b3 & 0x01) << 4);
    out[o++] = (b3 >> 1) & 0x1f;
    out[o++] = ((b3 >> 6) & 0x03) | ((b4 & 0x07) << 2);
    out[o++] = (b4 >> 3) & 0x1f;
  }
  const r = count - o;
  if (r === 7) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!, b3 = buf[i + 3]!;
    out[o++] = b0 & 0x1f; out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f; out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x0f) << 1);
    out[o++] = ((b2 >> 4) & 0x0f) | ((b3 & 0x01) << 4); out[o++] = (b3 >> 1) & 0x1f;
    out[o++] = (b3 >> 6) & 0x03;
  } else if (r === 6) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!, b3 = buf[i + 3]!;
    out[o++] = b0 & 0x1f; out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f; out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x0f) << 1);
    out[o++] = ((b2 >> 4) & 0x0f) | ((b3 & 0x01) << 4); out[o++] = (b3 >> 1) & 0x1f;
  } else if (r === 5) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    out[o++] = b0 & 0x1f; out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f; out[o++] = ((b1 >> 7) & 0x01) | ((b2 & 0x0f) << 1);
    out[o++] = (b2 >> 4) & 0x0f;
  } else if (r === 4) {
    const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
    out[o++] = b0 & 0x1f; out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f; out[o++] = (b2 & 0x0f) << 1;
  } else if (r === 3) {
    const b0 = buf[i]!, b1 = buf[i + 1]!;
    out[o++] = b0 & 0x1f; out[o++] = ((b0 >> 5) & 0x07) | ((b1 & 0x03) << 3);
    out[o++] = (b1 >> 2) & 0x1f;
  } else if (r === 2) {
    const b0 = buf[i]!;
    out[o++] = b0 & 0x1f; out[o++] = (b0 >> 5) & 0x07;
  } else if (r === 1) {
    out[o++] = buf[i]! & 0x1f;
  }
  return out;
}

/**
 * Decode a base64 compressed chromaprint fingerprint into 32-bit sub-fingerprints.
 *
 * Returns `null` for anything malformed rather than throwing: fingerprints come
 * from external tooling and a corrupt one must degrade to "cannot compare".
 */
export function decodeFingerprint(b64: string): Int32Array | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(b64.trim(), 'base64');
  } catch {
    return null;
  }
  if (raw.length < 4) return null;

  const size = (raw[1]! << 16) | (raw[2]! << 8) | raw[3]!;
  if (size <= 0) return null;

  const bits = unpackInt3(raw, 4, unpackedInt3Size(raw.length - 4));

  // The normal bits are terminated by the size-th zero; count exceptions (==7).
  let found = 0;
  let exceptional = 0;
  let used = bits.length;
  for (let i = 0; i < bits.length; i += 1) {
    const b = bits[i]!;
    if (b === 0) {
      found += 1;
      if (found === size) {
        used = i + 1;
        break;
      }
    } else if (b === 7) {
      exceptional += 1;
    }
  }
  if (found !== size) return null;

  const sub = Int32Array.from(bits.subarray(0, used));
  if (exceptional > 0) {
    const off2 = 4 + packedInt3Size(used);
    const packed5 = packedInt5Size(exceptional);
    if (raw.length < off2 + packed5) return null;
    const exc = unpackInt5(raw, off2, unpackedInt5Size(packed5));
    for (let i = 0, j = 0; i < sub.length; i += 1) {
      if (sub[i] === 7) {
        sub[i] = sub[i]! + (exc[j++] ?? 0);
      }
    }
  }

  // UnpackBits: bit == 0 terminates a value; otherwise XOR the accumulated bits.
  const out = new Int32Array(size).fill(-1);
  let idx = 0;
  let lastBit = 0;
  let value = 0;
  for (let j = 0; j < sub.length; j += 1) {
    const bit = sub[j]!;
    if (bit === 0) {
      out[idx] = value >>> 0;
      idx += 1;
      lastBit = 0;
    } else {
      lastBit += bit;
      value ^= 1 << (lastBit - 1);
    }
  }
  return out;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/**
 * Number of *distinct* values in a decoded fingerprint.
 *
 * This absolute count is the honest test of whether a fingerprint carries any
 * information at all. Stationary material — a sustained tone, a test signal, a
 * held drone — collapses the chroma vector to a single repeated value no matter
 * how many sub-fingerprints it yields; real music yields dozens.
 */
export function distinctValues(fp: Int32Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < fp.length; i += 1) seen.add(fp[i]!);
  return seen.size;
}

/**
 * Fraction of *distinct* values in a decoded fingerprint, 0..1.
 *
 * Companion to `distinctValues`; see `isStationary` for why both are needed.
 */
export function distinctRatio(fp: Int32Array): number {
  if (fp.length === 0) return 0;
  const seen = new Set<number>();
  // Sampling the first 64 values is enough to tell stationary from moving content
  // and keeps the guard cheap on long fingerprints.
  const n = Math.min(fp.length, 64);
  for (let i = 0; i < n; i += 1) seen.add(fp[i]!);
  return seen.size / n;
}

/**
 * Below this many *distinct values*, a fingerprint is stationary, whatever its
 * length. Real music measured 39-95 distinct values; sustained tones measured 1.
 */
export const MIN_DISTINCT_VALUES = 4;

/** Below this, a fingerprint is too stationary to compare; see `isStationary`. */
export const MIN_DISTINCT_RATIO = 0.05;

/**
 * True when a fingerprint is too stationary to be evidence of anything.
 *
 * Two checks, because either alone has a hole:
 *
 *  - the absolute distinct count catches *short* stationary fingerprints, which a
 *    ratio cannot. An 11-sub-fingerprint tone that repeats one value scores
 *    1/11 = 0.09 — over the ratio floor purely because the denominator is small.
 *    Measured: a 660 Hz FLAC (19 values, ratio 0.053) and an unrelated 880 Hz MP3
 *    (11 values, ratio 0.091) are both single-valued, yet both cleared a
 *    ratio-only floor and merged at similarity 0.9375, silently deleting a track.
 *  - the ratio catches long, mostly-stationary fingerprints.
 *
 * Real music lands far above both floors (39-95 distinct values, ratio 0.91-1.00).
 */
export function isStationary(fp: Int32Array): boolean {
  return distinctValues(fp) < MIN_DISTINCT_VALUES || distinctRatio(fp) < MIN_DISTINCT_RATIO;
}

/**
 * Similarity of two base64 fingerprints, 0..1.
 *
 * The shorter fingerprint is slid across the longer one and the *best* alignment
 * wins, so a track that is a truncated or offset copy of another still matches.
 * The score is `1 - bit error rate` at that alignment.
 *
 * Returns 0 when either side is undecodable, too short, or too stationary to
 * compare, so an unusable fingerprint can never cause a false duplicate.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const A = decodeFingerprint(a);
  const B = decodeFingerprint(b);
  if (!A || !B) return 0;
  if (A.length === 0 || B.length === 0) return 0;

  // Stationary content carries no discriminating information: two different
  // sustained tones differ in only a couple of bits and would otherwise clear the
  // threshold. Declining the comparison is the safe direction — a missed duplicate
  // costs a redundant copy, a false one deletes a song the user wanted.
  if (isStationary(A) || isStationary(B)) return 0;

  const needle = A.length <= B.length ? A : B;
  const hay = A.length <= B.length ? B : A;
  // Fewer than a handful of sub-fingerprints is not evidence of anything.
  if (needle.length < 4) return 0;

  const offsets = hay.length - needle.length + 1;
  if (offsets <= 0) return 0;

  // The *lowest* bit error rate across alignments is the best match. Tracking the
  // maximum here instead (which this did) returns the score of the *worst*
  // alignment, so a genuine copy that happens to be truncated or offset — the very
  // case the sliding window exists for — scored ~0.5 and was silently missed.
  let bestError = 1;
  for (let off = 0; off < offsets; off += 1) {
    let diff = 0;
    for (let i = 0; i < needle.length; i += 1) {
      diff += popcount(needle[i]! ^ hay[off + i]!);
    }
    const ber = diff / (32 * needle.length);
    if (ber < bestError) bestError = ber;
    if (bestError === 0) break;
  }
  return 1 - bestError;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/** Default acoustic-duplicate threshold; see the calibration note above. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

export interface DupCandidate {
  id: string;
  path: string;
  durationSec?: number;
  /** Audio bitrate in bits/s, when known; drives the keeper choice. */
  bitRate?: number | null;
  fp?: string | null;
}

/**
 * Group duplicates and decide which copy to keep.
 *
 * Detection order, cheapest first:
 *  1. two files with the *same path* (a scan of overlapping roots)
 *  2. identical content hash -> "identical content"
 *  3. fingerprint similarity >= threshold -> "acoustic match (N%)"
 *  4. same duration AND same file size -> "same size and duration"
 *
 * The keeper within a group is the highest-bitrate, then longest, then
 * lexicographically-first path — deterministic, and biased toward keeping the
 * best-quality copy rather than merely the first one seen.
 *
 * Input order is preserved in the output so a report reads in scan order.
 */
export function findDuplicates(
  entries: DupCandidate[],
  opts: { threshold?: number } = {},
): { keep: string; drop: string[]; reason: string }[] {
  const threshold = opts.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const n = entries.length;
  if (n < 2) return [];

  // Union-find over indices.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const reasons = new Map<string, string>();

  // Cheap keys first: exact path and content hash.
  const byPath = new Map<string, number>();
  const byHash = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const e = entries[i]!;
    const pkey = e.path.replace(/\\/g, '/').toLowerCase();
    const prevPath = byPath.get(pkey);
    if (prevPath !== undefined) {
      union(prevPath, i);
      reasons.set(`${prevPath}|${i}`, 'same path');
    } else {
      byPath.set(pkey, i);
    }

    // Hash only when the file exists; a missing file is reported elsewhere.
    try {
      const hash = createHash('sha1').update(readFileSync(e.path)).digest('hex');
      const prevHash = byHash.get(hash);
      if (prevHash !== undefined) {
        union(prevHash, i);
        reasons.set(`${prevHash}|${i}`, 'identical content');
      } else {
        byHash.set(hash, i);
      }
    } catch {
      /* unreadable file: fall through to the fingerprint stage */
    }
  }

  // Acoustic comparison. Fingerprints are decoded once and reused.
  const decoded = new Map<number, Int32Array | null>();
  const getDecoded = (i: number): Int32Array | null => {
    if (!decoded.has(i)) {
      const fp = entries[i]!.fp;
      decoded.set(i, fp ? decodeFingerprint(fp) : null);
    }
    return decoded.get(i) ?? null;
  };

  const hasFp = entries.filter((e) => typeof e.fp === 'string' && e.fp !== '').length;
  if (hasFp >= 2) {
    for (let i = 0; i < n; i += 1) {
      const ai = getDecoded(i);
      if (!ai || ai.length < 4) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (find(i) === find(j)) continue;
        const bj = getDecoded(j);
        if (!bj || bj.length < 4) continue;
        const s = similarity(entries[i]!.fp!, entries[j]!.fp!);
        if (s >= threshold) {
          union(i, j);
          reasons.set(`${i}|${j}`, `acoustic match (${(s * 100).toFixed(1)}%)`);
        }
      }
    }
  }

  // Fallback: identical size and duration is evidence of the same file.
  //
  // This runs only where the fingerprint could NOT decide: if both sides have a
  // usable fingerprint, the acoustic stage above is authoritative, and a score
  // below the threshold is a positive finding of *difference*. Letting the
  // size+duration rule overrule it deleted distinct songs, because two tracks of
  // equal length in the same format are routinely byte-identical in size.
  for (let i = 0; i < n; i += 1) {
    const a = entries[i]!;
    if (a.durationSec === undefined || a.durationSec <= 0) continue;
    const ai = getDecoded(i);
    const aHasFp = ai !== null && ai.length >= 4;
    for (let j = i + 1; j < n; j += 1) {
      if (find(i) === find(j)) continue;
      const b = entries[j]!;
      if (b.durationSec === undefined || b.durationSec <= 0) continue;
      if (Math.abs(a.durationSec - b.durationSec) > 0.5) continue;
      const bj = getDecoded(j);
      const bHasFp = bj !== null && bj.length >= 4;
      // Both fingerprints usable => the acoustic verdict already stands.
      if (aHasFp && bHasFp) continue;
      let sizeA = -1;
      let sizeB = -2;
      try {
        sizeA = readFileSync(a.path).length;
      } catch {
        continue;
      }
      try {
        sizeB = readFileSync(b.path).length;
      } catch {
        continue;
      }
      if (sizeA === sizeB) {
        union(i, j);
        reasons.set(`${i}|${j}`, 'same size and duration');
      }
    }
  }

  // Collect groups, preserving first-appearance order.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const out: { keep: string; drop: string[]; reason: string }[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;

    // Keeper, in priority order:
    //   1. higher audio bitrate — a 320 kbps copy beats a 128 kbps rip of the
    //      same song, which is the whole point of de-duplicating for a USB
    //   2. longer duration — biased toward the complete copy over a truncated one
    //   3. earlier in input order — i.e. the scan order the caller supplied, so
    //      the user's own root priority decides ties. Byte-identical copies are
    //      equal in every measurable way, so the honest answer is "the first one
    //      seen" rather than an arbitrary alphabetical preference.
    // Bitrate is unknown for some inputs (e.g. raw WAV reports none); unknown
    // never outranks a known value, it only falls through to the next rule.
    const bitrateOf = (i: number): number => {
      const b = entries[i]!.bitRate;
      return typeof b === 'number' && b > 0 ? b : -1;
    };
    const sorted = [...idxs].sort((x, y) => {
      const bx = bitrateOf(x);
      const by = bitrateOf(y);
      if (by !== bx) return by - bx;
      const dx = entries[x]!.durationSec ?? 0;
      const dy = entries[y]!.durationSec ?? 0;
      if (dy !== dx) return dy - dx;
      return x - y;
    });
    const keepIdx = sorted[0]!;
    const drops = sorted.slice(1).map((i) => entries[i]!.id);

    let reason = 'duplicate';
    for (const i of idxs) {
      for (const j of idxs) {
        const r = reasons.get(`${Math.min(i, j)}|${Math.max(i, j)}`);
        if (r) {
          reason = r;
          break;
        }
      }
      if (reason !== 'duplicate') break;
    }

    out.push({ keep: entries[keepIdx]!.id, drop: drops, reason });
  }

  return out;
}
