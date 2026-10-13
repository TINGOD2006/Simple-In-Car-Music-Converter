/**
 * EDL model tests: every edit operation, plus the invariants that make the model
 * worth having (no audio is touched, undo/redo is exact).
 */

import { assert, assertClose, assertEq, assertThrows, test } from './harness.ts';
import * as EDL from '../src/core/edl.ts';
import type { Clip, Timeline } from '../src/core/types.ts';

function tl(clips: Clip[]): Timeline {
  return EDL.makeTimeline(clips, 44100, 2);
}

function oneClip(dur: number, sourceId = 'a'): Timeline {
  return tl([EDL.makeClip({ sourceId, srcIn: 0, srcOut: dur })]);
}

/* ------------------------------------------------------------------ */

test('makeClip rejects an empty or inverted range', () => {
  assertThrows(() => EDL.makeClip({ sourceId: 'a', srcIn: 5, srcOut: 5 }), 'zero-length clip');
  assertThrows(() => EDL.makeClip({ sourceId: 'a', srcIn: 5, srcOut: 2 }), 'inverted clip');
});

test('timelineDuration sums clip durations', () => {
  const t = tl([
    EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 10 }),
    EDL.makeClip({ sourceId: 'a', srcIn: 20, srcOut: 25 }),
  ]);
  assertClose(EDL.timelineDuration(t), 15, 1e-9, 'duration');
});

test('clipStarts gives cumulative offsets', () => {
  const a = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 10 });
  const b = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 5 });
  const starts = EDL.clipStarts(tl([a, b]));
  assertEq(starts.get(a.id), 0, 'first clip starts at 0');
  assertEq(starts.get(b.id), 10, 'second clip starts at 10');
});

test('split divides one clip into two contiguous halves', () => {
  const t = oneClip(10);
  const out = EDL.split(t, 4);
  assertEq(out.clips.length, 2, 'two clips after split');
  assertEq(out.clips[0]!.srcIn, 0, 'left srcIn');
  assertEq(out.clips[0]!.srcOut, 4, 'left srcOut');
  assertEq(out.clips[1]!.srcIn, 4, 'right srcIn');
  assertEq(out.clips[1]!.srcOut, 10, 'right srcOut');
  assertClose(EDL.timelineDuration(out), 10, 1e-9, 'duration preserved by split');
});

test('split at an edge is a no-op', () => {
  const t = oneClip(10);
  assertEq(EDL.split(t, 0).clips.length, 1, 'split at 0 does nothing');
  assertEq(EDL.split(t, 10).clips.length, 1, 'split at end does nothing');
});

test('split then mergeAdjacent restores a single clip', () => {
  const t = oneClip(10);
  const split = EDL.split(t, 4);
  const merged = EDL.mergeAdjacent(split);
  assertEq(merged.clips.length, 1, 'rejoined to one clip');
  assertEq(merged.clips[0]!.srcIn, 0, 'merged srcIn');
  assertEq(merged.clips[0]!.srcOut, 10, 'merged srcOut');
});

test('mergeAdjacent keeps a gap between non-contiguous clips', () => {
  const t = tl([
    EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 4 }),
    EDL.makeClip({ sourceId: 'a', srcIn: 6, srcOut: 10 }),
  ]);
  assertEq(EDL.mergeAdjacent(t).clips.length, 2, 'gap prevents merging');
});

test('deleteRange removes exactly the requested span', () => {
  const t = oneClip(10);
  const out = EDL.deleteRange(t, 2, 5);
  assertClose(EDL.timelineDuration(out), 7, 1e-9, 'duration after delete');
  assertEq(out.clips.length, 2, 'two clips remain');
  assertEq(out.clips[0]!.srcOut, 2, 'first clip ends at 2');
  assertEq(out.clips[1]!.srcIn, 5, 'second clip resumes at 5');
});

test('deleteRange across a clip boundary works', () => {
  const t = tl([
    EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 4 }),
    EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 4 }),
  ]);
  const out = EDL.deleteRange(t, 2, 6);
  assertClose(EDL.timelineDuration(out), 4, 1e-9, 'duration after cross-clip delete');
});

test('deleteRange of the whole timeline leaves nothing', () => {
  const out = EDL.deleteRange(oneClip(10), 0, 10);
  assertEq(out.clips.length, 0, 'no clips remain');
  assertClose(EDL.timelineDuration(out), 0, 1e-9, 'zero duration');
});

test('trimToRange keeps only the requested window', () => {
  const out = EDL.trimToRange(oneClip(10), 3, 7);
  assertClose(EDL.timelineDuration(out), 4, 1e-9, 'trimmed duration');
});

test('silenceRange replaces a span with a silence clip of equal length', () => {
  const out = EDL.silenceRange(oneClip(10), 3, 6);
  assertClose(EDL.timelineDuration(out), 10, 1e-9, 'duration unchanged by silencing');
  const silence = out.clips.find((c) => c.sourceId === '__silence__');
  assert(silence !== undefined, 'a silence clip exists');
  assertClose(EDL.clipDuration(silence!), 3, 1e-9, 'silence length matches the span');
});

test('insertClips places a clip at a timeline position', () => {
  const t = oneClip(10);
  const ins = EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 2 });
  const out = EDL.insertClips(t, 5, [ins]);
  assertEq(out.clips.length, 3, 'three clips after insert');
  assertClose(EDL.timelineDuration(out), 12, 1e-9, 'duration grew by the insert');
  assertEq(out.clips[1]!.sourceId, 'b', 'inserted clip sits in the middle');
});

test('copyRange then pasteAt duplicates audio without touching the source', () => {
  const t = oneClip(10);
  const clip = EDL.copyRange(t, 2, 5);
  assertEq(clip.clips.length, 1, 'one clip copied');
  assertClose(EDL.clipDuration(clip.clips[0]!), 3, 1e-9, 'copied length');

  const pasted = EDL.pasteAt(t, 10, clip);
  assertClose(EDL.timelineDuration(pasted), 13, 1e-9, 'duration after paste');
  assertEq(pasted.clips.length, 2, 'two clips after paste');
});

test('moveClip reorders without changing duration', () => {
  const a = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 3 });
  const b = EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 5 });
  const t = tl([a, b]);
  const moved = EDL.moveClip(t, a.id, 1);
  assertEq(moved.clips[0]!.id, b.id, 'b is now first');
  assertClose(EDL.timelineDuration(moved), 8, 1e-9, 'duration unchanged by reorder');
});

test('mergeClips refuses clips from different sources', () => {
  const a = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 3 });
  const b = EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 5 });
  assertThrows(() => EDL.mergeClips(tl([a, b]), a.id, b.id), 'cross-source merge');
});

test('locate maps a time to the containing clip and offset', () => {
  const a = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 4 });
  const b = EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 6 });
  const t = tl([a, b]);

  const at1 = EDL.locate(t, 1)!;
  assertEq(at1.clip.id, a.id, 'time 1 is in clip a');
  assertClose(at1.offset, 1, 1e-9, 'offset within a');

  // A position exactly on the seam belongs to the later clip.
  const at4 = EDL.locate(t, 4)!;
  assertEq(at4.clip.id, b.id, 'boundary belongs to the later clip');
  assertClose(at4.offset, 0, 1e-9, 'offset 0 at the boundary');
});

test('findClip throws for an unknown id', () => {
  assertThrows(() => EDL.findClip(oneClip(5), 'nope'), 'unknown clip id');
});

/* ------------------------------------------------------------------ */
/* Undo / redo                                                         */
/* ------------------------------------------------------------------ */

test('History undo and redo restore exact states', () => {
  const t0 = oneClip(10);
  const h = new EDL.History(t0);
  assert(!h.canUndo, 'nothing to undo initially');

  const t1 = EDL.split(t0, 5);
  h.commit('split', t1);
  assert(h.canUndo, 'can undo after a commit');
  assertEq(h.current.clips.length, 2, 'current has two clips');

  const undone = h.undo();
  assertEq(undone.clips.length, 1, 'undo restored one clip');
  assertClose(EDL.timelineDuration(undone), 10, 1e-9, 'undo restored duration');

  const redone = h.redo();
  assertEq(redone.clips.length, 2, 'redo re-applied the split');
  assert(!h.canRedo, 'nothing left to redo');
});

test('History discards the redo branch after a new commit', () => {
  const t0 = oneClip(10);
  const h = new EDL.History(t0);
  h.commit('split', EDL.split(t0, 5));
  h.undo();
  h.commit('delete', EDL.deleteRange(t0, 1, 2));
  assert(!h.canRedo, 'redo branch was discarded');
});

test('History honours its limit', () => {
  const h = new EDL.History(oneClip(10), 3);
  for (let i = 1; i <= 5; i += 1) h.commit(`c${i}`, oneClip(10));
  assert(h.labels.length <= 3, `labels length ${h.labels.length} should be <= 3`);
});

/* ------------------------------------------------------------------ */
/* Invariant: edit operations never mutate the input timeline            */
/* ------------------------------------------------------------------ */

test('edit operations do not mutate their input timeline', () => {
  const t = oneClip(10);
  const before = JSON.stringify(t);

  EDL.split(t, 5);
  EDL.deleteRange(t, 1, 3);
  EDL.silenceRange(t, 2, 4);
  EDL.mergeAdjacent(t);
  EDL.insertClips(t, 5, [EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 1 })]);
  EDL.copyRange(t, 1, 2);
  EDL.trimToRange(t, 1, 5);

  assertEq(JSON.stringify(t), before, 'input timeline is unchanged');
});

test('usbPreset matches the agreed USB specification', () => {
  const p = EDL.usbPreset();
  assertEq(p.container, 'mp3', 'container');
  assertEq(p.codec, 'libmp3lame', 'codec');
  assertEq(p.bitrateKbps, 320, 'bitrate');
  assertEq(p.sampleRate, 44100, 'sample rate');
  assertEq(p.channels, 2, 'channels');
  assertEq(p.id3v2Version, 3, 'ID3v2 version');
  assertEq(p.loudness.integratedLufs, -14, 'loudness target');
  assertEq(p.loudness.truePeakDb, -1.0, 'true peak ceiling');
});
