/**
 * Tag handling: reading, repairing and deriving metadata.
 *
 * The hard problem here is *mojibake*: a file tagged on a Traditional-Chinese
 * Windows machine (CP950/Big5) or a Simplified-Chinese one (GBK), then read back
 * as Latin-1 by a player that assumed the tags were ISO-8859-1. The bytes are
 * intact, only their interpretation is wrong, so the repair is a re-decode.
 *
 * `repairMojibake` is deliberately conservative: it only rewrites a string when
 * a candidate re-decode is *strictly valid* and actually differs from the input.
 * A correct UTF-8 tag therefore passes through untouched, which matters because
 * mangling already-correct metadata is worse than leaving a rare encoding alone.
 */

import { basename, extname } from 'node:path';
import type { MediaInfo } from './types.ts';

export interface TagSet {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: string;
  year?: string;
  genre?: string;
  comment?: string;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * ffprobe reports tag keys in whatever case the container used (`ARTIST`,
 * `artist`, `TPE1`...). Look them up case-insensitively and map the common
 * aliases onto our canonical field names.
 */
const TAG_ALIASES: Record<keyof TagSet, string[]> = {
  title: ['title', 'tit2', 'inam', 'sonm'],
  artist: ['artist', 'tpe1', 'iart', 'soar'],
  album: ['album', 'talb', 'ipal', 'soal'],
  albumArtist: ['album_artist', 'albumartist', 'tpe2', 'aart'],
  track: ['track', 'trck', 'iprt', 'itrk'],
  year: ['date', 'year', 'tyer', 'icrd'],
  genre: ['genre', 'tcon', 'ignr'],
  comment: ['comment', 'comm', 'icmt'],
};

function lookup(tags: Record<string, string>, keys: string[]): string | undefined {
  const lowered = new Map<string, string>();
  for (const [k, v] of Object.entries(tags)) lowered.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lowered.get(k);
    if (v !== undefined && v.trim() !== '') return v;
  }
  return undefined;
}

/** Extract a canonical TagSet from a probed file's container metadata. */
export function readTags(info: MediaInfo): TagSet {
  const raw = info.format.tags ?? {};
  const out: TagSet = {};
  for (const field of Object.keys(TAG_ALIASES) as (keyof TagSet)[]) {
    const v = lookup(raw, TAG_ALIASES[field]);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Mojibake repair                                                     */
/* ------------------------------------------------------------------ */

function isLatin1Representable(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0xff) return false;
  return true;
}

function hasHighByte(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return true;
  return false;
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    // `fatal` is what makes this safe: an invalid sequence throws instead of
    // silently producing U+FFFD, so we never "repair" into replacement garbage.
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Repair a string that was decoded with the wrong single-byte charset.
 *
 * Strategy: if every code point fits in one byte, the string may be a byte
 * sequence that was mis-decoded. Re-encode to bytes and try the plausible
 * original encodings in order of how *specific* they are:
 *
 *   1. UTF-8  — the overwhelmingly common case (a UTF-8 tag read as Latin-1)
 *   2. Big5   — Traditional Chinese (CP950), the common case on this project
 *   3. GB18030 — Simplified Chinese (superset of GBK)
 *
 * A candidate only wins when it decodes validly *and* differs from the input, so
 * ASCII and already-correct strings are returned unchanged.
 */
export function repairMojibake(s: string): string {
  if (!s) return s;
  if (!hasHighByte(s)) return s;
  if (!isLatin1Representable(s)) return s;

  const bytes = Buffer.from(s, 'latin1');

  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null && utf8 !== s) return utf8;

  for (const enc of ['big5', 'gb18030']) {
    const decoded = tryDecode(bytes, enc);
    if (decoded !== null && decoded !== s) return decoded;
  }

  return s;
}

/* ------------------------------------------------------------------ */
/* Filename parsing                                                    */
/* ------------------------------------------------------------------ */

const AUDIO_EXT_RE =
  /\.(mp3|wav|flac|ogg|oga|opus|aac|m4a|mp4|wma|aiff|aif|alac|ape|wv|tta|ac3|dts|mka|amr|au|ra|rm|caf|mpc|spx|mp2|m4b|m4r|asf|weba|dff|dsf)$/i;

/** Strip the extension and any leading track number from a basename. */
function stripExtension(name: string): string {
  return name.replace(AUDIO_EXT_RE, '');
}

/**
 * Derive metadata from a filename.
 *
 * Handles the layouts that actually accumulate in a music folder:
 *   "01 - Artist - Title.mp3"   -> track, artist, title
 *   "Artist - Title.mp3"        -> artist, title
 *   "01 Title.mp3"              -> track, title
 *   "01. Artist - Title.flac"   -> track, artist, title
 *   "Title.mp3"                 -> title
 *   "01 - Title.mp3"            -> track, title  (no artist)
 *
 * Underscores are treated as spaces (a common download artefact) and the result
 * is trimmed. Nothing is invented: fields that are not present stay undefined.
 */
export function deriveTagsFromFilename(p: string): TagSet {
  const name = stripExtension(basename(p)).trim();
  if (!name) return {};

  // Normalise separators that are really just word separators.
  const cleaned = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  // Leading track number: "01 ", "01 - ", "01. ", "1-01 " (disc-track).
  let track: string | undefined;
  let rest = cleaned;
  const trackMatch = rest.match(/^(\d{1,3}(?:-\d{1,3})?)\s*[-.)\]]?\s+(.*)$/);
  if (trackMatch) {
    track = trackMatch[1]!;
    rest = trackMatch[2]!.trim();
  }

  if (!rest) return track ? { track } : {};

  // "Artist - Title" (split on the first separator that has spaces around it,
  // or a bare hyphen surrounded by non-digits).
  const dashSplit = rest.split(/\s+[-–—]\s+/);
  if (dashSplit.length >= 2) {
    const artist = dashSplit[0]!.trim();
    const title = dashSplit.slice(1).join(' - ').trim();
    const out: TagSet = {};
    if (artist) out.artist = artist;
    if (title) out.title = title;
    if (track) out.track = track;
    if (out.title || out.artist) return out;
  }

  const out: TagSet = { title: rest };
  if (track) out.track = track;
  return out;
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

/** Field-by-field merge: `primary` wins wherever it has a non-empty value. */
export function mergeTags(primary: TagSet, fallback: TagSet): TagSet {
  const out: TagSet = {};
  const fields: (keyof TagSet)[] = [
    'title', 'artist', 'album', 'albumArtist', 'track', 'year', 'genre', 'comment',
  ];
  for (const f of fields) {
    const p = primary[f];
    const b = fallback[f];
    const chosen = p !== undefined && p.trim() !== '' ? p : b;
    if (chosen !== undefined && chosen.trim() !== '') out[f] = chosen;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Filename sanitising and planning                                    */
/* ------------------------------------------------------------------ */

/** Characters Windows forbids in a filename, plus control characters. */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** Device names Windows reserves (case-insensitive, with or without extension). */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const DEFAULT_MAX_LEN = 120;

/**
 * Make a string safe to use as a Windows filename.
 *
 * Rules applied, in order:
 *  - illegal characters and control characters become '_'
 *  - runs of whitespace collapse to one space
 *  - leading/trailing whitespace and trailing dots are removed (Windows silently
 *    drops trailing dots, which would desynchronise a manifest from disk)
 *  - a reserved device name is prefixed with '_'
 *  - an empty result becomes 'untitled'
 *  - the result is truncated to `maxLen` (by default 120, leaving room for the
 *    extension and for a FAT32 path budget)
 */
export function sanitizeFilename(s: string, maxLen = DEFAULT_MAX_LEN): string {
  let out = (s ?? '').replace(ILLEGAL_CHARS, '_');
  out = out.replace(/\s+/g, ' ').trim();
  // Trailing dots/spaces are stripped by Windows; do it here so the name we
  // report is the name that lands on disk.
  out = out.replace(/[. ]+$/g, '').trim();

  if (out === '') return 'untitled';

  const base = out.replace(/\.[^.]*$/, '');
  if (RESERVED_NAMES.has(base.toLowerCase()) || RESERVED_NAMES.has(out.toLowerCase())) {
    out = '_' + out;
  }

  const limit = Math.max(1, Math.floor(maxLen));
  if (out.length > limit) {
    out = out.slice(0, limit);
    // Do not leave a dangling dot or space after truncation.
    out = out.replace(/[. ]+$/g, '');
    if (out === '') out = 'untitled';
  }
  return out;
}

/** Filename patterns offered by the UI, keyed by a human-readable label. */
export const FILENAME_PATTERNS: Record<string, string> = {
  'track artist title': '{track} {artist} - {title}',
  'artist title': '{artist} - {title}',
  'title': '{title}',
  'track title': '{track} {title}',
  'artist album track title': '{artist} - {album} - {track} {title}',
};

/** Substitute `{field}` placeholders in `pattern` from `tags`. */
function renderPattern(pattern: string, tags: TagSet): string {
  const raw = pattern.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = tags[key as keyof TagSet];
    return v ?? '';
  });
  // An empty placeholder leaves its surrounding separator behind: the default
  // `{artist} - {title}` on a file with no artist tag renders "- Song", and a
  // missing title renders "Artist -". Both are unusable filenames, so drop
  // separators that have nothing on one side of them and collapse the ones that
  // end up back to back.
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_]+/, '')
    .replace(/[\s\-_]+$/, '')
    .replace(/(?:\s*-\s*){2,}/g, ' - ')
    .trim();
}

/**
 * Assign a unique output filename (without extension) to every entry.
 *
 * Collisions are resolved deterministically by appending ` (2)`, ` (3)`, ... in
 * input order, so the same input always produces the same plan. Entries whose
 * pattern renders to nothing fall back to the entry id, which is always unique.
 */
export function planFilenames(entries: { id: string; tags: TagSet }[], pattern: string): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();

  for (const e of entries) {
    let base = sanitizeFilename(renderPattern(pattern, e.tags));
    if (base === 'untitled') base = sanitizeFilename(e.id);

    const key = base.toLowerCase();
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    if (seen > 0) {
      // Keep the suffix inside the length budget.
      const suffix = ` (${seen + 1})`;
      const trimmed = sanitizeFilename(base, Math.max(1, DEFAULT_MAX_LEN - suffix.length));
      base = trimmed + suffix;
    }
    out.set(e.id, base);
  }
  return out;
}
