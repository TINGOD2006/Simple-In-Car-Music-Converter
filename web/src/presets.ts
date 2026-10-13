/**
 * Export presets offered by the UI.
 *
 * These are *data* only — the engine is what actually encodes. `usbPreset()` here
 * mirrors `src/core/edl.ts`'s USB default: MP3 320 kbps CBR, 44.1 kHz, stereo,
 * ID3v2.3, -14 LUFS / -1.0 dBTP, gentle denoise.
 */

import type { ExportPreset } from './api-types.ts';

export interface PresetChoice {
  id: 'usb' | 'flac' | 'wav';
  label: string;
  description: string;
  make: () => ExportPreset;
}

export const PRESETS: PresetChoice[] = [
  {
    id: 'usb',
    label: 'USB (MP3 320k CBR)',
    description: '車機最相容。44.1 kHz 立體聲、ID3v2.3、-14 LUFS / -1.0 dBTP。',
    make: () => ({
      container: 'mp3',
      codec: 'libmp3lame',
      bitrateKbps: 320,
      sampleRate: 44100,
      channels: 2,
      loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
      id3v2Version: 3,
      denoise: 'gentle',
    }),
  },
  {
    id: 'flac',
    label: 'FLAC (無損)',
    description: '無損保存，適合歸檔或高階車機。',
    make: () => ({
      container: 'flac',
      codec: 'flac',
      bitrateKbps: null,
      sampleRate: 44100,
      channels: 2,
      loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'wav',
    label: 'WAV (未壓縮)',
    description: '最大相容性與最高保真，檔案最大。',
    make: () => ({
      container: 'wav',
      codec: 'pcm_s16le',
      bitrateKbps: null,
      sampleRate: 44100,
      channels: 2,
      loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
];

export function presetById(id: PresetChoice['id']): ExportPreset {
  const found = PRESETS.find((p) => p.id === id);
  return (found ?? PRESETS[0]!).make();
}
