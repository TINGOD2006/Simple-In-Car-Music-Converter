/**
 * Export presets offered by the UI.
 *
 * These are *data* only — the engine is what actually encodes. `usbPreset()` here
 * mirrors `src/core/edl.ts`'s USB default: MP3 320 kbps CBR, 44.1 kHz, stereo,
 * ID3v2.3, -14 LUFS / -1.0 dBTP, gentle denoise.
 *
 * `extension` and `lossy` are duplicated from the engine on purpose: the page is a
 * separate bundle and cannot import `src/core`. `test/presets.test.ts` pins both
 * against the engine's own `containerExtension()` and `isLossy()` so the two can
 * never drift apart silently.
 */

import type { ExportPreset } from './api-types.ts';

export interface PresetChoice {
  id: 'usb' | 'aac' | 'ogg' | 'opus' | 'wma' | 'flac' | 'wav';
  label: string;
  description: string;
  /** Target file extension, WITHOUT the dot. Mirrors `containerExtension()`. */
  extension: string;
  /** Whether the target codec is lossy. Mirrors `isLossy()`. */
  lossy: boolean;
  make: () => ExportPreset;
}

/** The loudness target every preset shares: the car-stereo standard. */
const LOUDNESS = { enabled: true, integratedLufs: -14, truePeakDb: -1.0, lra: 11 } as const;

const STEREO_44100 = { sampleRate: 44100, channels: 2 } as const;

export const PRESETS: PresetChoice[] = [
  {
    id: 'usb',
    label: 'USB (MP3 320k CBR)',
    description: '車機最相容。44.1 kHz 立體聲、ID3v2.3、-14 LUFS / -1.0 dBTP。',
    extension: 'mp3',
    lossy: true,
    make: () => ({
      container: 'mp3',
      codec: 'libmp3lame',
      bitrateKbps: 320,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: 3,
      denoise: 'gentle',
    }),
  },
  {
    id: 'aac',
    label: 'AAC (M4A 256k)',
    description: '新式車機與手機通用。同流量下通常比 MP3 好聽，老舊車機可能不支援。',
    extension: 'm4a',
    lossy: true,
    make: () => ({
      container: 'm4a',
      codec: 'aac',
      bitrateKbps: 256,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'ogg',
    label: 'OGG Vorbis 256k',
    description: '開放格式，檔案比 MP3 小。多數車機不支援，主要給電腦與手機播放。',
    extension: 'ogg',
    lossy: true,
    make: () => ({
      container: 'ogg',
      codec: 'libvorbis',
      bitrateKbps: 256,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'opus',
    label: 'Opus 192k',
    description: '目前效率最好的有損格式，但必須是 48 kHz，且車機支援度最低。',
    extension: 'opus',
    lossy: true,
    make: () => ({
      container: 'opus',
      codec: 'libopus',
      bitrateKbps: 192,
      // libopus only encodes at 8/12/16/24/48 kHz. 44.1 kHz is refused outright,
      // so this preset deliberately differs from every other one here.
      sampleRate: 48000,
      channels: 2,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'wma',
    label: 'WMA 192k',
    description: '舊款車機常見。現代播放器多半已不支援，建議只在確定需要時使用。',
    extension: 'wma',
    lossy: true,
    make: () => ({
      container: 'wma',
      codec: 'wmav2',
      bitrateKbps: 192,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'flac',
    label: 'FLAC (無損)',
    description: '無損保存，適合歸檔或高階車機。',
    extension: 'flac',
    lossy: false,
    make: () => ({
      container: 'flac',
      codec: 'flac',
      bitrateKbps: null,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
  {
    id: 'wav',
    label: 'WAV (未壓縮)',
    description: '最大相容性與最高保真，檔案最大。',
    extension: 'wav',
    lossy: false,
    make: () => ({
      container: 'wav',
      codec: 'pcm_s16le',
      bitrateKbps: null,
      ...STEREO_44100,
      loudness: { ...LOUDNESS },
      id3v2Version: null,
      denoise: 'gentle',
    }),
  },
];

/** The preset the panel starts on. */
export const DEFAULT_PRESET_ID: PresetChoice['id'] = 'usb';

export function choiceById(id: PresetChoice['id']): PresetChoice {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

export function presetById(id: PresetChoice['id']): ExportPreset {
  return choiceById(id).make();
}
