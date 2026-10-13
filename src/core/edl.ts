/**
 * The EDL model and every edit operation.
 *
 * All functions here are PURE with respect to audio: they transform the edit
 * decision list only. No file is read, no sample is touched. This is what makes
 * undo/redo, cut/copy/paste and split/merge cheap and lossless.
 */

import type { ChannelCount, Clip, EffectInstance, Project, SourceRef, Timeline } from './types.ts';

let idCounter = 0;

/** Deterministic-ish id generator; uniqueness within a session is all we need. */
export function newId(prefix = 'c'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export interface ClipInit {
  sourceId: string;
  srcIn?: number;
  srcOut: number;
  gainDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  crossfadeInSec?: number;
  effects?: EffectInstance[];
  label?: string;
}

export function makeClip(init: ClipInit): Clip {
  const srcIn = init.srcIn ?? 0;
  if (!(init.srcOut > srcIn)) {
    throw new Error(`Invalid clip range: srcIn=${srcIn} srcOut=${init.srcOut}`);
  }
  const clip: Clip = {
    id: newId(),
    sourceId: init.sourceId,
    srcIn,
    srcOut: init.srcOut,
    gainDb: init.gainDb ?? 0,
    fadeInSec: init.fadeInSec ?? 0,
    fadeOutSec: init.fadeOutSec ?? 0,
    crossfadeInSec: init.crossfadeInSec ?? 0,
    effects: init.effects ?? [],
  };
  if (init.label !== undefined) clip.label = init.label;
  return clip;
}

export function makeTimeline(clips: Clip[], sampleRate = 44100, channels: ChannelCount = 2): Timeline {
  return { clips, sampleRate, channels };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export function clipDuration(c: Clip): number {
  return Math.max(0, c.srcOut - c.srcIn);
}

/**
 * Overlap a clip contributes to the clip before it.
 *
 * `crossfadeInSec` means "this clip starts `n` seconds before the previous clip
 * ends", so the two overlap and the timeline is `n` seconds shorter than the sum
 * of the clip durations. The renderer really does produce that shorter file
 * (`acrossfade` overlaps the streams), so every duration/position query here has
 * to subtract it or the playhead and `verify()` both drift.
 *
 * A crossfade can never exceed the shorter of the two neighbouring clips.
 */
export function crossfadeOverlap(t: Timeline, index: number): number {
  const c = t.clips[index];
  if (!c || c.crossfadeInSec <= 0 || index === 0) return 0;
  const prev = t.clips[index - 1]!;
  return Math.max(0, Math.min(c.crossfadeInSec, clipDuration(prev), clipDuration(c)));
}

export function timelineDuration(t: Timeline): number {
  let total = 0;
  for (let i = 0; i < t.clips.length; i += 1) {
    total += clipDuration(t.clips[i]!) - crossfadeOverlap(t, i);
  }
  return Math.max(0, total);
}

/** Start time of each clip on the timeline, keyed by clip id. */
export function clipStarts(t: Timeline): Map<string, number> {
  const out = new Map<string, number>();
  let t0 = 0;
  for (let i = 0; i < t.clips.length; i += 1) {
    const c = t.clips[i]!;
    // A crossfading clip starts before the running end, but the running end
    // still advances by the clip's own duration minus its overlap.
    t0 -= crossfadeOverlap(t, i);
    out.set(c.id, Math.max(0, t0));
    t0 += clipDuration(c);
  }
  return out;
}

export function findClip(t: Timeline, id: string): Clip {
  const c = t.clips.find((x) => x.id === id);
  if (!c) throw new Error(`No clip with id ${id}`);
  return c;
}

function indexOfClip(t: Timeline, id: string): number {
  const i = t.clips.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`No clip with id ${id}`);
  return i;
}

/**
 * Locate which clip contains a timeline position.
 * A position exactly at a boundary belongs to the *later* clip, which is what
 * "split at the playhead" needs.
 */
export function locate(t: Timeline, timeSec: number): { clip: Clip; index: number; offset: number } | null {
  let cursor = 0;
  for (let i = 0; i < t.clips.length; i += 1) {
    const c = t.clips[i]!;
    const d = clipDuration(c);
    // Mirrors clipStarts(): a crossfading clip begins `overlap` earlier than the
    // previous clip's end, so the playhead stays consistent with the timeline.
    const start = cursor - crossfadeOverlap(t, i);
    const end = start + d;
    if (timeSec < end || i === t.clips.length - 1) {
      return { clip: c, index: i, offset: Math.max(0, Math.min(d, timeSec - start)) };
    }
    cursor = end;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Edit operations — every one returns a NEW timeline                  */
/* ------------------------------------------------------------------ */

/** Split the clip under `timeSec` into two, returning the new timeline. */
export function split(t: Timeline, timeSec: number): Timeline {
  const hit = locate(t, timeSec);
  if (!hit) return t;
  const { clip, index, offset } = hit;
  const d = clipDuration(clip);

  // A split at either edge would create an empty clip; treat it as a no-op.
  if (offset <= 0 || offset >= d) return t;

  const at = clip.srcIn + offset;
  const left: Clip = { ...clip, id: newId(), srcOut: at, fadeOutSec: 0, effects: clip.effects.map(cloneEffect) };
  const right: Clip = {
    ...clip,
    id: newId(),
    srcIn: at,
    fadeInSec: 0,
    crossfadeInSec: 0,
    effects: clip.effects.map(cloneEffect),
  };

  const clips = [...t.clips];
  clips.splice(index, 1, left, right);
  return { ...t, clips };
}

/** Split every clip that spans `timeSec`. Convenience wrapper around split. */
export function splitAt(t: Timeline, timeSec: number): Timeline {
  return split(t, timeSec);
}

/** Remove the clip with `id`. */
export function removeClip(t: Timeline, id: string): Timeline {
  return { ...t, clips: t.clips.filter((c) => c.id !== id) };
}

/** Remove a time range [fromSec, toSec) from the timeline. */
export function deleteRange(t: Timeline, fromSec: number, toSec: number): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  if (to - from <= 0) return t;

  let split0 = t;
  const b = locate(split0, from);
  if (b && b.offset > 0) split0 = split(split0, from);

  let split1 = split0;
  const e = locate(split1, to);
  if (e && e.offset > 0) split1 = split(split1, to);

  const starts = clipStarts(split1);
  const kept = split1.clips.filter((c) => {
    const s = starts.get(c.id)!;
    const en = s + clipDuration(c);
    return en <= from || s >= to;
  });
  return { ...split1, clips: kept };
}

/** Keep only [fromSec, toSec); the complement of deleteRange. */
export function trimToRange(t: Timeline, fromSec: number, toSec: number): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  const without = deleteRange(t, 0, from);
  // deleteRange shifted the tail left by `from`, so the end is now relative.
  return deleteRange(without, to - from, timelineDuration(without) + 1);
}

/**
 * Silence a time range by replacing it with generated silence.
 *
 * The range is split into clip boundaries *first*, then the clips that fall
 * inside it are dropped and one silence clip of the same length is spliced in at
 * the position where they were. Computing the insertion point from the unsplit
 * timeline (the previous implementation) put the silence at the end of the
 * timeline for any range that started inside a clip, because a clip's start is
 * only ever `>= from` when `from` is 0.
 */
export function silenceRange(t: Timeline, fromSec: number, toSec: number, sourceId = '__silence__'): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  if (to - from <= 0) return t;

  const total = timelineDuration(t);
  if (from >= total) return t;
  // A range that runs past the end only silences up to the end.
  const gapLen = Math.min(to, total) - from;
  if (gapLen <= 0) return t;

  let base = t;
  const b = locate(base, from);
  if (b && b.offset > 0) base = split(base, from);

  const e = locate(base, to);
  if (e && e.offset > 0) base = split(base, to);

  const starts = clipStarts(base);
  const kept: Clip[] = [];
  let insertAt = -1;
  for (const c of base.clips) {
    const s = starts.get(c.id) ?? 0;
    const en = s + clipDuration(c);
    if (en <= from || s >= to) {
      kept.push(c);
      continue;
    }
    // The first clip that the range covers marks where the silence belongs.
    if (insertAt < 0) insertAt = kept.length;
  }
  if (insertAt < 0) insertAt = kept.length;

  const gap = makeClip({ sourceId, srcIn: 0, srcOut: gapLen, label: 'silence' });
  const clips = [...kept];
  clips.splice(insertAt, 0, gap);
  return { ...base, clips };
}

/** Insert clips at a timeline position. */
export function insertClips(t: Timeline, timeSec: number, incoming: Clip[]): Timeline {
  if (incoming.length === 0) return t;

  let base = t;
  const hit = locate(base, timeSec);
  if (hit && hit.offset > 0) base = split(base, timeSec);

  const starts = clipStarts(base);
  const at = base.clips.findIndex((c) => (starts.get(c.id) ?? 0) >= timeSec);
  const idx = at < 0 ? base.clips.length : at;

  const clips = [...base.clips];
  clips.splice(idx, 0, ...incoming.map((c) => ({ ...c, id: newId(), effects: c.effects.map(cloneEffect) })));
  return { ...base, clips };
}

/** Append clips at the end. */
export function appendClips(t: Timeline, incoming: Clip[]): Timeline {
  return {
    ...t,
    clips: [...t.clips, ...incoming.map((c) => ({ ...c, id: newId(), effects: c.effects.map(cloneEffect) }))],
  };
}

/**
 * Merge adjacent clips that come from the same source and are contiguous in
 * the source, so a cut-then-rejoin leaves no seam.
 */
export function mergeAdjacent(t: Timeline): Timeline {
  const out: Clip[] = [];
  for (const c of t.clips) {
    const prev = out[out.length - 1];
    const mergeable =
      prev !== undefined &&
      prev.sourceId === c.sourceId &&
      Math.abs(prev.srcOut - c.srcIn) < 1e-9 &&
      prev.gainDb === c.gainDb &&
      prev.fadeOutSec === 0 &&
      c.fadeInSec === 0 &&
      c.crossfadeInSec === 0 &&
      sameEffects(prev.effects, c.effects);
    if (mergeable) {
      out[out.length - 1] = { ...prev, srcOut: c.srcOut, fadeOutSec: c.fadeOutSec };
    } else {
      out.push(c);
    }
  }
  return { ...t, clips: out };
}

/** Merge two specific clips; returns unchanged timeline when they are not adjacent. */
export function mergeClips(t: Timeline, firstId: string, secondId: string): Timeline {
  const i = indexOfClip(t, firstId);
  const j = indexOfClip(t, secondId);
  if (Math.abs(i - j) !== 1) return t;
  const [a, b] = i < j ? [t.clips[i]!, t.clips[j]!] : [t.clips[j]!, t.clips[i]!];
  if (a.sourceId !== b.sourceId) {
    throw new Error('Cannot merge clips from different sources');
  }
  const merged: Clip = { ...a, srcOut: b.srcOut, fadeOutSec: b.fadeOutSec };
  const clips = t.clips.filter((c) => c.id !== a.id && c.id !== b.id);
  clips.splice(Math.min(i, j), 0, merged);
  return { ...t, clips };
}

export interface Clipboard {
  clips: Clip[];
}

export function copyRange(t: Timeline, fromSec: number, toSec: number): Clipboard {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  let base = t;
  const b = locate(base, from);
  if (b && b.offset > 0) base = split(base, from);
  const e = locate(base, to);
  if (e && e.offset > 0) base = split(base, to);

  const starts = clipStarts(base);
  const picked = base.clips.filter((c) => {
    const s = starts.get(c.id)!;
    const en = s + clipDuration(c);
    return s >= from - 1e-9 && en <= to + 1e-9;
  });
  return { clips: picked.map((c) => ({ ...c, id: newId(), effects: c.effects.map(cloneEffect) })) };
}

export function pasteAt(t: Timeline, timeSec: number, clip: Clipboard): Timeline {
  return insertClips(t, timeSec, clip.clips);
}

/** Move a clip to a new index (drag-reorder). */
export function moveClip(t: Timeline, id: string, toIndex: number): Timeline {
  const from = indexOfClip(t, id);
  const clips = [...t.clips];
  const [c] = clips.splice(from, 1);
  const dest = Math.max(0, Math.min(clips.length, toIndex));
  clips.splice(dest, 0, c!);
  return { ...t, clips };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function cloneEffect(e: EffectInstance): EffectInstance {
  return structuredClone(e);
}

function sameEffects(a: EffectInstance[], b: EffectInstance[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* Undo / redo — snapshots of the timeline                             */
/* ------------------------------------------------------------------ */

export interface HistoryEntry {
  label: string;
  timeline: Timeline;
}

export class History {
  private entries: HistoryEntry[] = [];
  private cursor = -1;
  private readonly limit: number;

  constructor(initial: Timeline, limit = 200) {
    this.limit = limit;
    this.entries.push({ label: 'initial', timeline: initial });
    this.cursor = 0;
  }

  get current(): Timeline {
    return this.entries[this.cursor]!.timeline;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  get labels(): string[] {
    return this.entries.map((e) => e.label);
  }

  /** Record a new state, discarding any redo branch. */
  commit(label: string, timeline: Timeline): void {
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push({ label, timeline });
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
    this.cursor = this.entries.length - 1;
  }

  undo(): Timeline {
    if (this.canUndo) this.cursor -= 1;
    return this.current;
  }

  redo(): Timeline {
    if (this.canRedo) this.cursor += 1;
    return this.current;
  }
}

/* ------------------------------------------------------------------ */
/* Project helpers                                                     */
/* ------------------------------------------------------------------ */

export function makeProject(
  name: string,
  sources: Record<string, SourceRef>,
  timeline: Timeline,
  exportPreset: Project['export'],
): Project {
  return {
    version: 1,
    id: newId('p'),
    name,
    sources,
    timeline,
    export: exportPreset,
  };
}

/** USB-ready default: MP3 320 kbps CBR, 44.1 kHz, stereo, ID3v2.3, -14 LUFS. */
export function usbPreset(): Project['export'] {
  return {
    container: 'mp3',
    codec: 'libmp3lame',
    bitrateKbps: 320,
    sampleRate: 44100,
    channels: 2,
    loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
    id3v2Version: 3,
    denoise: 'gentle',
  };
}
