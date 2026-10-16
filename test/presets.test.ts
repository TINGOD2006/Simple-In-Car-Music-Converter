/**
 * The preset list is UI data, but every field on it is a claim about what the
 * ENGINE will do: which muxer gets opened, which extension comes out, whether the
 * audio is thrown away. These tests keep the two sides in agreement, so adding a
 * format to the picker cannot quietly offer a target the encoder refuses, or a
 * target the verifier rejects after the file has already been written.
 */

import { containerExtension } from '../src/core/batch.ts';
import { isLossy } from '../src/core/compiler.ts';
import { DEFAULT_PRESET_ID, PRESETS, choiceById, presetById } from '../web/src/presets.ts';
import { assert, assertEq, test } from './harness.ts';

test('presets: every id is unique and the default one is real', () => {
  const ids = PRESETS.map((p) => p.id);
  assertEq(new Set(ids).size, ids.length, 'two presets share an id, so the picker cannot name one of them');
  assert(ids.includes(DEFAULT_PRESET_ID), `the default preset ${DEFAULT_PRESET_ID} is not in PRESETS`);
  assertEq(choiceById(DEFAULT_PRESET_ID).id, DEFAULT_PRESET_ID, 'choiceById must find the default');
});

test('presets: an unknown id falls back to the first preset instead of throwing', () => {
  // The page never sends an unknown id, but a stale bundle could, and a throw here
  // would blank the whole tab.
  assertEq(choiceById('not-a-preset' as never).id, PRESETS[0]!.id, 'unknown id falls back to the first entry');
});

test('presets: the declared extension is the one the engine writes', () => {
  for (const choice of PRESETS) {
    const engine = containerExtension(presetById(choice.id));
    assertEq(engine, `.${choice.extension}`, `${choice.id}: the picker promises .${choice.extension}`);
    // containerExtension falls back to '.bin' for a container it does not know, which
    // would mean the picker is offering a muxer the engine was never taught.
    assert(engine !== '.bin', `${choice.id}: the engine does not know this container`);
  }
});

test("presets: the lossy flag matches the engine's own codec list", () => {
  for (const choice of PRESETS) {
    assertEq(
      isLossy(presetById(choice.id).codec),
      choice.lossy,
      `${choice.id}: the UI's ⚠ rules are only honest if this matches the engine`,
    );
  }
  // Both kinds must exist, or the whole 無損/有損 warning machinery is dead code.
  assert(PRESETS.some((p) => p.lossy), 'no lossy target is offered');
  assert(PRESETS.some((p) => !p.lossy), 'no lossless target is offered');
});

test('presets: only a lossy codec carries a bitrate', () => {
  for (const choice of PRESETS) {
    const preset = presetById(choice.id);
    assertEq(
      preset.bitrateKbps !== null,
      isLossy(preset.codec),
      `${choice.id}: -b:a on a lossless codec is ignored at best and rejected at worst`,
    );
    if (preset.bitrateKbps !== null) {
      assert(preset.bitrateKbps > 0, `${choice.id}: bitrate must be positive`);
    }
  }
});

test('presets: only the MP3 target carries an ID3 version', () => {
  for (const choice of PRESETS) {
    const preset = presetById(choice.id);
    // -id3v2_version is an mp3 muxer option; on any other muxer it is an error.
    assertEq(
      preset.id3v2Version !== null,
      preset.container === 'mp3',
      `${choice.id}: ID3 options belong to the mp3 muxer only`,
    );
  }
});

test('presets: every target is stereo and names a sample rate libopus accepts', () => {
  for (const choice of PRESETS) {
    const preset = presetById(choice.id);
    assertEq(preset.channels, 2, `${choice.id}: this product feeds car stereos`);
    assert(Number.isInteger(preset.sampleRate) && preset.sampleRate > 0, `${choice.id}: sample rate must be a positive integer`);
    if (preset.codec === 'libopus') {
      // libopus refsamples 8/12/16/24/48 kHz and rejects anything else, so Opus is
      // the one target that cannot simply follow the others.
      const allowed = [8000, 12000, 16000, 24000, 48000];
      assert(allowed.includes(preset.sampleRate), `libopus cannot encode ${preset.sampleRate} Hz`);
    } else {
      assertEq(preset.sampleRate, 44100, `${choice.id}: the audio CD rate is the compatible default`);
    }
  }
});

test('presets: the picker offers more than one format and every entry is labelled', () => {
  assert(PRESETS.length >= 2, 'a format picker with one choice is not a picker');
  for (const choice of PRESETS) {
    assert(choice.label.trim().length > 0, `${choice.id}: missing label`);
    assert(choice.description.trim().length > 0, `${choice.id}: missing description`);
    // The label is what the user reads, so it must not be the bare id.
    assert(choice.label !== choice.id, `${choice.id}: the label is just the id`);
  }
  const labels = PRESETS.map((p) => p.label);
  assertEq(new Set(labels).size, labels.length, 'two presets share a label');
});

test('presets: the audio loudness target is the one the tuner was built around', () => {
  for (const choice of PRESETS) {
    const { loudness } = presetById(choice.id);
    assert(loudness.enabled, `${choice.id}: loudness normalisation is the product's whole point`);
    assertEq(loudness.integratedLufs, -14, `${choice.id}: -14 LUFS is the calibrated car target`);
    assertEq(loudness.truePeakDb, -1, `${choice.id}: -1 dBTP leaves headroom for the car DSP`);
  }
});
