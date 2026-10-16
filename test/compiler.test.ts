/**
 * Compiler tests: EDL -> ffmpeg argv.
 *
 * The compiler is a pure function, so the entire render plan is asserted here
 * without invoking ffmpeg. These are the tests that catch a broken filter graph
 * before it costs a 40-minute batch run.
 */

import { assert, assertEq, test } from './harness.ts';
import { compile } from '../src/core/compiler.ts';
import type { CompileInput } from '../src/core/compiler.ts';
import { buildEffectChain, denoiseParams, Stage, EFFECTS } from '../src/core/effects.ts';
import * as EDL from '../src/core/edl.ts';
import type { EffectInstance, ExportPreset } from '../src/core/types.ts';

const preset: ExportPreset = EDL.usbPreset();

function baseInput(over: Partial<CompileInput> = {}): CompileInput {
  const clip = EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 10 });
  return {
    timeline: EDL.makeTimeline([clip], 44100, 2),
    preset,
    sourcePaths: { src0: 'C:/music/a.mp3' },
    outputPath: 'C:/out/a.mp3',
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Effect chain building                                               */
/* ------------------------------------------------------------------ */

test('denoiseParams maps each strength to distinct afftdn settings', () => {
  const g = denoiseParams('gentle');
  const m = denoiseParams('moderate');
  const s = denoiseParams('strong');
  assert(g !== m && m !== s && g !== s, 'the three strengths differ');
  assert(g.startsWith('afftdn='), 'uses afftdn');
});

test('buildEffectChain orders effects by processing stage, not insertion order', () => {
  const effects: EffectInstance[] = [
    { id: '1', enabled: true, type: 'gain', gainDb: 3 },       // Gain (60)
    { id: '2', enabled: true, type: 'denoise', strength: 'gentle' }, // Denoise (20)
    { id: '3', enabled: true, type: 'highpass', freq: 80 },      // Eq (30)
  ];
  const { chain } = buildEffectChain(effects);
  const iDenoise = chain.indexOf('afftdn');
  const iEq = chain.indexOf('highpass');
  const iGain = chain.indexOf('volume');

  assert(iDenoise >= 0 && iEq >= 0 && iGain >= 0, 'all three effects present');
  assert(iDenoise < iEq, 'denoise runs before eq');
  assert(iEq < iGain, 'eq runs before gain');
});

test('buildEffectChain skips disabled effects', () => {
  const { chain } = buildEffectChain([
    { id: '1', enabled: false, type: 'gain', gainDb: 6 },
  ]);
  assertEq(chain, '', 'disabled effect produces no filter');
});

test('a zero-dB gain produces no filter', () => {
  const { chain } = buildEffectChain([{ id: '1', enabled: true, type: 'gain', gainDb: 0 }]);
  assertEq(chain, '', 'unity gain is a no-op');
});

test('EQ bands chain into one equalizer filter per band', () => {
  const { chain } = buildEffectChain([
    {
      id: '1',
      enabled: true,
      type: 'eq',
      bands: [
        { freq: 100, gainDb: -3, widthOctaves: 1 },
        { freq: 3000, gainDb: 2, widthOctaves: 1.5 },
      ],
    },
  ]);
  assertEq((chain.match(/equalizer=/g) ?? []).length, 2, 'one filter per band');
  assert(chain.includes('f=100'), 'first band frequency');
  assert(chain.includes('f=3000'), 'second band frequency');
});

test('every effect type has a registry entry', () => {
  const types: EffectInstance['type'][] = [
    'gain', 'normalize', 'eq', 'reverb', 'echo', 'reverse', 'denoise',
    'declick', 'declip', 'highpass', 'lowpass', 'compressor', 'limiter', 'speed',
  ];
  for (const t of types) {
    assert(EFFECTS[t] !== undefined, `registry has ${t}`);
    assert(typeof EFFECTS[t].stage === 'number', `${t} has a stage`);
  }
});

test('stage ordering constants are strictly increasing in pipeline order', () => {
  const order = [Stage.Repair, Stage.Denoise, Stage.Eq, Stage.Dynamics, Stage.Space, Stage.Gain, Stage.Speed];
  for (let i = 1; i < order.length; i += 1) {
    assert(order[i]! > order[i - 1]!, `stage ${i} comes after ${i - 1}`);
  }
});

/* ------------------------------------------------------------------ */
/* Compilation                                                         */
/* ------------------------------------------------------------------ */

test('a single-clip timeline compiles to one input and one filter chain', () => {
  const r = compile(baseInput());
  assertEq(r.inputs, ['C:/music/a.mp3'], 'one input');
  assert(r.args.includes('-filter_complex'), 'has filter_complex');
  assert(r.filterComplex.includes('atrim=start=0:end=10'), 'trims to the clip range');
  assert(r.filterComplex.includes('aresample=44100'), 'resamples to the preset rate');
  assertEq(r.args[r.args.length - 1], 'C:/out/a.mp3', 'output path is last');
});

test('USB preset compiles to MP3 320k CBR with ID3v2.3', () => {
  const r = compile(baseInput());
  const args = r.args.join(' ');
  assert(args.includes('-c:a libmp3lame'), 'libmp3lame encoder');
  assert(args.includes('-b:a 320k'), '320 kbps');
  // CBR for libmp3lame is `-b:a` with the rate pinned, NOT `-abr 1` — that
  // flag selects ABR mode and the stream lands near half the requested rate.
  assert(!args.includes('-abr'), 'no ABR flag (it would defeat CBR)');
  assert(args.includes('-minrate 320k'), 'CBR floor');
  assert(args.includes('-maxrate 320k'), 'CBR ceiling');
  assert(args.includes('-bufsize 640k'), 'CBR buffer');
  assert(args.includes('-id3v2_version 3'), 'ID3v2.3');
  assert(args.includes('-ar 44100'), 'sample rate');
  assert(args.includes('-ac 2'), 'stereo');
});

test('two clips from one source declare that source only once', () => {
  const c1 = EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 5 });
  const c2 = EDL.makeClip({ sourceId: 'src0', srcIn: 20, srcOut: 25 });
  const r = compile(baseInput({ timeline: EDL.makeTimeline([c1, c2], 44100, 2) }));
  assertEq(r.inputs.length, 1, 'source declared once');
  assert(r.filterComplex.includes('concat=n=2'), 'clips concatenated');
});

test('two clips from different sources declare two inputs', () => {
  const c1 = EDL.makeClip({ sourceId: 'a', srcIn: 0, srcOut: 5 });
  const c2 = EDL.makeClip({ sourceId: 'b', srcIn: 0, srcOut: 5 });
  const r = compile(
    baseInput({
      timeline: EDL.makeTimeline([c1, c2], 44100, 2),
      sourcePaths: { a: 'C:/m/a.mp3', b: 'C:/m/b.mp3' },
    }),
  );
  assertEq(r.inputs.length, 2, 'two inputs');
  assertEq(r.inputs[0], 'C:/m/a.mp3', 'first input path');
  assertEq(r.inputs[1], 'C:/m/b.mp3', 'second input path');
});

test('a crossfade compiles to acrossfade instead of concat', () => {
  const c1 = EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 5 });
  const c2 = EDL.makeClip({ sourceId: 'src0', srcIn: 20, srcOut: 25, crossfadeInSec: 0.5 });
  const r = compile(baseInput({ timeline: EDL.makeTimeline([c1, c2], 44100, 2) }));
  assert(r.filterComplex.includes('acrossfade=d=0.5'), 'crossfade present');
  assert(!r.filterComplex.includes('concat=n=2'), 'no hard concat for this pair');
});

test('a silence clip is generated with anullsrc rather than an input file', () => {
  const t = EDL.silenceRange(
    EDL.makeTimeline([EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 10 })], 44100, 2),
    3,
    6,
  );
  const r = compile(baseInput({ timeline: t }));
  assert(r.args.join(' ').includes('anullsrc'), 'uses anullsrc for silence');
  assertEq(r.inputs.length, 1, 'silence adds no file input');
});

test('fades compile to afade filters', () => {
  const clip = EDL.makeClip({ sourceId: 'src0', srcIn: 0, srcOut: 10, fadeInSec: 1, fadeOutSec: 2 });
  const r = compile(baseInput({ timeline: EDL.makeTimeline([clip], 44100, 2) }));
  assert(r.filterComplex.includes('afade=t=in:st=0:d=1'), 'fade in');
  assert(r.filterComplex.includes('afade=t=out:st=8:d=2'), 'fade out at 10-2');
});

test('loudnorm two-pass uses the measured values', () => {
  const r = compile(
    baseInput({
      loudnorm: {
        measured: { inputI: -21.5, inputTp: -3.2, inputLra: 8.1, inputThresh: -31.5, targetOffset: 0.04 },
        integratedLufs: -14,
        truePeakDb: -1.0,
        lra: 11,
      },
    }),
  );
  const f = r.filterComplex;
  assert(f.includes('loudnorm=I=-14'), 'target loudness');
  assert(f.includes('TP=-1'), 'true peak ceiling');
  assert(f.includes('measured_I=-21.5'), 'uses the measured integrated loudness');
  assert(f.includes('measured_TP=-3.2'), 'uses the measured true peak');
  assert(f.includes('linear=true'), 'linear mode preserves dynamics');
});

test('loudnorm raises the LRA target when the source is wider than the preset', () => {
  // Regression: `linear=true` is only honoured while target LRA >= measured LRA.
  // With a wider source ffmpeg silently falls back to dynamic mode, which both
  // misses the integrated target and squeezes the dynamics — measured on a
  // -30/-9/-30 dB source, LRA=11 landed at -12.35 LUFS (off 1.65) whereas
  // LRA=22 landed at -13.96 (off 0.04). The target must be raised to the
  // source's own LRA so linear mode survives.
  const wide = compile(
    baseInput({
      loudnorm: {
        measured: { inputI: -30.66, inputTp: -27.06, inputLra: 21.0, inputThresh: -42.9, targetOffset: 0.21 },
        integratedLufs: -14,
        truePeakDb: -1.0,
        lra: 11,
      },
    }),
  );
  assert(wide.filterComplex.includes('LRA=21'), 'the wider measured LRA becomes the target');
  assert(wide.filterComplex.includes('measured_LRA=21'), 'the measurement is still reported verbatim');
  assert(wide.filterComplex.includes('linear=true'), 'linear mode is still requested');

  // A source narrower than the preset must keep the preset's target untouched.
  const narrow = compile(
    baseInput({
      loudnorm: {
        measured: { inputI: -21.5, inputTp: -3.2, inputLra: 8.1, inputThresh: -31.5, targetOffset: 0.04 },
        integratedLufs: -14,
        truePeakDb: -1.0,
        lra: 11,
      },
    }),
  );
  assert(narrow.filterComplex.includes('LRA=11'), 'a narrow source keeps the preset LRA target');
});

test('the measurement pass emits ebur128 and writes no audio', () => {
  const r = compile(
    baseInput({ measure: { integratedLufs: -14, truePeakDb: -1, lra: 11 }, loudnorm: null }),
  );
  assert(r.filterComplex.includes('ebur128=peak=true'), 'measures with ebur128');
  assert(!r.filterComplex.includes('print_format=json'), 'no loudnorm JSON pass');
  assert(!r.filterComplex.includes('measured_I'), 'measurement pass has no measured values yet');
});

test('a silent measurement skips loudnorm instead of emitting -inf', () => {
  // ebur128 reports digital silence as I=-70 LUFS / Peak=-inf dBFS. Passing that
  // through produces `measured_TP=-inf`, which ffmpeg rejects with "Result too
  // large" and a non-zero exit, so the whole export would fail on a silent track.
  const r = compile(
    baseInput({
      loudnorm: {
        measured: { inputI: -70, inputTp: -Infinity, inputLra: 0, inputThresh: -70, targetOffset: 0 },
        integratedLufs: -14,
        truePeakDb: -1.0,
        lra: 11,
      },
    }),
  );
  assert(!r.filterComplex.includes('loudnorm'), 'no loudnorm filter for a silent program');
  assert(!r.filterComplex.includes('inf'), 'no non-finite value reaches ffmpeg');
});

test('a normal measurement still compiles the linear loudnorm second pass', () => {
  const r = compile(
    baseInput({
      loudnorm: {
        measured: { inputI: -21.5, inputTp: -3.2, inputLra: 8.1, inputThresh: -31.5, targetOffset: 0 },
        integratedLufs: -14,
        truePeakDb: -1.0,
        lra: 11,
      },
    }),
  );
  assert(r.filterComplex.includes('measured_I=-21.5'), 'measured integrated level is applied');
  assert(r.filterComplex.includes('measured_TP=-3.2'), 'measured true peak is applied');
  assert(r.filterComplex.includes('linear=true'), 'linear mode requested');
});

test('an empty timeline is rejected', () => {
  let threw = false;
  try {
    compile(baseInput({ timeline: EDL.makeTimeline([], 44100, 2) }));
  } catch {
    threw = true;
  }
  assert(threw, 'empty timeline throws');
});

test('a missing source path is reported clearly', () => {
  let msg = '';
  try {
    compile(baseInput({ sourcePaths: {} }));
  } catch (err) {
    msg = (err as Error).message;
  }
  assert(msg.includes('No path registered'), `clear error, got: ${msg}`);
});

test('metadata tags compile to -metadata flags', () => {
  const r = compile(baseInput({ tags: { title: 'Song', artist: 'Band' } }));
  const args = r.args.join(' ');
  assert(args.includes('-metadata title=Song'), 'title tag');
  assert(args.includes('-metadata artist=Band'), 'artist tag');
});

test('an empty tag value is skipped', () => {
  const r = compile(baseInput({ tags: { title: 'Song', album: '' } }));
  const args = r.args.join(' ');
  assert(!args.includes('album='), 'empty album omitted');
});

test('lossless presets omit the bitrate flags', () => {
  const flac: ExportPreset = { ...preset, container: 'flac', codec: 'flac', bitrateKbps: null, id3v2Version: null };
  const r = compile(baseInput({ preset: flac }));
  const args = r.args.join(' ');
  assert(args.includes('-c:a flac'), 'flac codec');
  assert(!args.includes('-b:a'), 'no bitrate for lossless');
  assert(!args.includes('-id3v2_version'), 'no ID3v2 for flac');
});

test('the filter graph always ends in a mapped program label', () => {
  const r = compile(baseInput());
  const mapIdx = r.args.indexOf('-map');
  assert(mapIdx >= 0, 'has -map');
  assertEq(r.args[mapIdx + 1], '[prog]', 'maps the program label');
  assert(r.filterComplex.endsWith('[prog]'), 'graph defines [prog] last');
});

test('reverb compiles to a working multi-tap echo, not an afir placeholder', () => {
  // This build's `afir` cannot take an impulse response from a file (`ir` is an
  // integer index into `nbirs` input streams) and outputs silence when fed one,
  // so reverb is a multi-tap aecho. The old contract emitted a literal `@@IR@@`
  // token that reached ffmpeg and failed every render.
  const clip = EDL.makeClip({
    sourceId: 'src0',
    srcIn: 0,
    srcOut: 10,
    effects: [{ id: 'e1', enabled: true, type: 'reverb', preset: 'large-hall', mix: 0.3 }],
  });
  const r = compile(baseInput({ timeline: EDL.makeTimeline([clip], 44100, 2) }));
  assert(!r.filterComplex.includes('@@IR@@'), 'no unresolved placeholder reaches ffmpeg');
  assert(!r.filterComplex.includes('afir'), 'afir is not used (it is broken in this build)');
  assert(r.filterComplex.includes('aecho='), 'reverb compiles to aecho');
  assertEq(r.warnings, [], 'a reverb preset alone needs no warning');
});

test('reverb mix scales the wet taps and stays inside ffmpeg limits', () => {
  const build = (mix: number): string => {
    const clip = EDL.makeClip({
      sourceId: 'src0',
      srcIn: 0,
      srcOut: 10,
      effects: [{ id: 'e1', enabled: true, type: 'reverb', preset: 'plate', mix }],
    });
    return compile(baseInput({ timeline: EDL.makeTimeline([clip], 44100, 2) })).filterComplex;
  };
  const dry = build(0);
  const wet = build(1);
  assert(dry !== wet, 'mix changes the rendered chain');
  // A mix of 1 must not produce an out-of-range (or negative) decay.
  const decays = wet.match(/aecho=1:1:[\d|]+:([\d.|]+)/)?.[1] ?? '';
  assert(decays.length > 0, 'decay list is present');
  for (const d of decays.split('|')) {
    const v = Number(d);
    assert(Number.isFinite(v) && v >= 0 && v <= 1, `decay ${d} is in range`);
  }
});
