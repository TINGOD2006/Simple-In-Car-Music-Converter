/**
 * Pure timeline edit operations for the UI.
 *
 * IMPORTANT: these functions mirror the *semantics* of `src/core/edl.ts` but they
 * do NOT import it. The web package stays self-contained so `vite build` can never
 * be broken by an in-flight sibling module. They are pure data transforms — no
 * audio is read, decoded or processed anywhere in this package.
 */

import type { Clip, EffectInstance, Timeline } from './api-types.ts';

let idCounter = 0;

/** Unique within a session; same scheme as the engine's `newId`. */
export function newId(prefix = 'c'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function cloneEffect(e: EffectInstance): EffectInstance {
  return structuredClone(e);
}

export function clipDuration(c: Clip): number {
  return Math.max(0, c.srcOut - c.srcIn);
}

export function timelineDuration(t: Timeline): number {
  return t.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Start time of each clip on the timeline, keyed by clip id. */
export function clipStarts(t: Timeline): Map<string, number> {
  const out = new Map<string, number>();
  let t0 = 0;
  for (const c of t.clips) {
    out.set(c.id, t0);
    t0 += clipDuration(c);
  }
  return out;
}

export function locate(
  t: Timeline,
  timeSec: number,
): { clip: Clip; index: number; offset: number } | null {
  let t0 = 0;
  for (let i = 0; i < t.clips.length; i += 1) {
    const c = t.clips[i];
    if (!c) continue;
    const d = clipDuration(c);
    if (timeSec < t0 + d || i === t.clips.length - 1) {
      return { clip: c, index: i, offset: Math.max(0, Math.min(d, timeSec - t0)) };
    }
    t0 += d;
  }
  return null;
}

function cloneClip(c: Clip, overrides: Partial<Clip> = {}): Clip {
  return { ...c, effects: c.effects.map(cloneEffect), ...overrides };
}

/** Split the clip under `timeSec`. Returns the same timeline for a no-op. */
export function split(t: Timeline, timeSec: number): Timeline {
  const hit = locate(t, timeSec);
  if (!hit) return t;
  const { clip, index, offset } = hit;
  const d = clipDuration(clip);
  if (offset <= 0 || offset >= d) return t;

  const at = clip.srcIn + offset;
  const left = cloneClip(clip, { id: newId(), srcOut: at, fadeOutSec: 0 });
  const right = cloneClip(clip, { id: newId(), srcIn: at, fadeInSec: 0, crossfadeInSec: 0 });

  const clips = [...t.clips];
  clips.splice(index, 1, left, right);
  return { ...t, clips };
}

export function removeClip(t: Timeline, id: string): Timeline {
  return { ...t, clips: t.clips.filter((c) => c.id !== id) };
}

/** Remove `[fromSec, toSec)`; the surrounding audio closes the gap. */
export function deleteRange(t: Timeline, fromSec: number, toSec: number): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  if (to - from <= 1e-9) return t;

  let base = t;
  const b = locate(base, from);
  if (b && b.offset > 0) base = split(base, from);

  const e = locate(base, to);
  if (e && e.offset > 0) base = split(base, to);

  const starts = clipStarts(base);
  const kept = base.clips.filter((c) => {
    const s = starts.get(c.id) ?? 0;
    const en = s + clipDuration(c);
    return en <= from + 1e-9 || s >= to - 1e-9;
  });
  return { ...base, clips: kept };
}

/**
 * Replace `[fromSec, toSec)` with a generated-silence clip.
 *
 * The silence is a *reference* to the engine's `__silence__` pseudo-source; the UI
 * never synthesises samples itself.
 */
export function silenceRange(t: Timeline, fromSec: number, toSec: number): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  if (to - from <= 1e-9) return t;

  const cut = deleteRange(t, from, to);
  const gap: Clip = {
    id: newId(),
    sourceId: '__silence__',
    srcIn: 0,
    srcOut: to - from,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    crossfadeInSec: 0,
    effects: [],
    label: 'silence',
  };

  // Re-insert at the position the cut happened, by walking the surviving clips.
  const starts = clipStarts(cut);
  let idx = cut.clips.findIndex((c) => (starts.get(c.id) ?? 0) >= from - 1e-9);
  if (idx < 0) idx = cut.clips.length;
  const clips = [...cut.clips];
  clips.splice(idx, 0, gap);
  return { ...cut, clips };
}

/** Trim the timeline down to `[fromSec, toSec)` — the complement of deleteRange. */
export function trimToRange(t: Timeline, fromSec: number, toSec: number): Timeline {
  const from = Math.min(fromSec, toSec);
  const to = Math.max(fromSec, toSec);
  const head = deleteRange(t, 0, from);
  return deleteRange(head, to - from, timelineDuration(head) + 1);
}

export function moveClip(t: Timeline, id: string, toIndex: number): Timeline {
  const from = t.clips.findIndex((c) => c.id === id);
  if (from < 0) return t;
  const clips = [...t.clips];
  const [c] = clips.splice(from, 1);
  if (!c) return t;
  const dest = Math.max(0, Math.min(clips.length, toIndex));
  clips.splice(dest, 0, c);
  return { ...t, clips };
}

export function appendClips(t: Timeline, incoming: Clip[]): Timeline {
  return {
    ...t,
    clips: [...t.clips, ...incoming.map((c) => cloneClip(c, { id: newId() }))],
  };
}

/** Build a clip from a source file, covering the whole file by default. */
export function makeClip(
  sourceId: string,
  srcIn: number,
  srcOut: number,
  label?: string,
): Clip {
  const clip: Clip = {
    id: newId(),
    sourceId,
    srcIn,
    srcOut,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    crossfadeInSec: 0,
    effects: [],
  };
  if (label !== undefined) clip.label = label;
  return clip;
}

/* ------------------------------------------------------------------ */
/* Coordinate mapping: timeline seconds <-> one source's own seconds       */
/* ------------------------------------------------------------------ */

export interface SourceHit {
  clipId: string;
  sourceId: string;
  /** Position inside the source file, i.e. `[srcIn, srcOut)`. */
  sourceSec: number;
  /** Start of the clip on the timeline. */
  clipStart: number;
  clipEnd: number;
}

/**
 * Which clip a timeline second lands in, and where that is inside the source file.
 *
 * The waveform canvas draws ONE source at a time, so every timeline coordinate it
 * shows (playhead, selection, markers) has to be translated into that source's own
 * time base — otherwise a trimmed or split timeline draws its playhead at the wrong
 * place. Past the end of the timeline the last clip's end is reported.
 */
export function timelineToSource(t: Timeline, timeSec: number): SourceHit | null {
  const starts = clipStarts(t);
  for (const c of t.clips) {
    const clipStart = starts.get(c.id) ?? 0;
    const d = clipDuration(c);
    if (timeSec >= clipStart && timeSec < clipStart + d) {
      return {
        clipId: c.id,
        sourceId: c.sourceId,
        sourceSec: c.srcIn + (timeSec - clipStart),
        clipStart,
        clipEnd: clipStart + d,
      };
    }
  }
  const last = t.clips[t.clips.length - 1];
  if (!last) return null;
  const clipStart = starts.get(last.id) ?? 0;
  return {
    clipId: last.id,
    sourceId: last.sourceId,
    sourceSec: last.srcOut,
    clipStart,
    clipEnd: clipStart + clipDuration(last),
  };
}

/**
 * Inverse of `timelineToSource`: a source second inside `clipId` mapped back to the
 * timeline. `sourceSec` is clamped to the clip's own `[srcIn, srcOut)` range so a
 * click on a neighbouring part of the same waveform can never escape the clip.
 */
export function sourceToTimeline(t: Timeline, clipId: string, sourceSec: number): number | null {
  const c = t.clips.find((x) => x.id === clipId);
  if (!c) return null;
  const clipStart = clipStarts(t).get(c.id) ?? 0;
  const clamped = Math.max(c.srcIn, Math.min(c.srcOut, sourceSec));
  return clipStart + (clamped - c.srcIn);
}

/** Clips that reference `sourceId`, in timeline order. */
export function clipsUsingSource(
  t: Timeline,
  sourceId: string,
): { clip: Clip; start: number; duration: number }[] {
  const starts = clipStarts(t);
  const out: { clip: Clip; start: number; duration: number }[] = [];
  for (const clip of t.clips) {
    if (clip.sourceId !== sourceId) continue;
    out.push({ clip, start: starts.get(clip.id) ?? 0, duration: clipDuration(clip) });
  }
  return out;
}

export function emptyTimeline(sampleRate = 44100, channels: 1 | 2 = 2): Timeline {
  return { clips: [], sampleRate, channels };
}

/** Update one clip by id via a shallow-override producer. */
export function updateClip(
  t: Timeline,
  id: string,
  patch: Partial<Clip> | ((c: Clip) => Partial<Clip>),
): Timeline {
  return {
    ...t,
    clips: t.clips.map((c) => {
      if (c.id !== id) return c;
      const p = typeof patch === 'function' ? patch(c) : patch;
      return { ...c, ...p };
    }),
  };
}
