// S7 — pre-decode guard for UNTRUSTED project base-map image bytes (Codex review #3).
//
// The .tmap ZIP is external input: its base-map entry can be a decompression /
// decode bomb — a few KB of compressed data declaring a gigantic pixel surface that
// exhausts renderer memory/CPU the moment `createImageBitmap` inflates it. The shell
// IO layer is deliberately NOT touched (the renderer boundary defence is sufficient
// and keeps one guard, not two); this module is that defence, run by the render host
// BEFORE any decode:
//   1. byte-size cap ({@link MAX_BASE_MAP_IMAGE_BYTES}),
//   2. format ALLOW-LIST via header signature (PNG / JPEG only — the formats a .tmap
//      user base map is stored as; anything else, incl. SVG, resolves to the preset,
//      so no script-bearing format ever reaches a decoder),
//   3. lightweight header parse of the declared dimensions (PNG IHDR / JPEG SOF —
//      no full decode),
//   4. dimension caps: per-axis via the domain's OWN boundary validator
//      (`validateImageDescriptor`, MAX/MIN_IMAGE_DIMENSION_PX — 単一真実源) plus a
//      total-pixel cap ({@link MAX_BASE_MAP_IMAGE_PIXELS}) so per-axis-legal surface
//      bombs (e.g. 32768×8192) are still rejected.
//
// A rejected image is NOT an error path for the user: the host treats it as
// "not loadable" and the domain's `resolveDisplayedBasemap` falls back to the preset
// silently (既存規約 読込失敗→プリセット). Pure, framework-free byte parsing — unit
// tested in node without a DOM.

import { validateImageDescriptor, MAX_BASE_MAP_IMAGE_BYTES } from '../../domain/basemap/index';

/**
 * Maximum accepted base-map image FILE size in bytes (64 MB). Re-exported from the
 * domain (single source, 教訓 5.29) so this guard and the main-process pre-read cap
 * (ipc-handlers.handleOpenImage) share ONE bound; the value lives in the domain layer
 * so the shell can import it without depending on the renderer/ui layer.
 */
export { MAX_BASE_MAP_IMAGE_BYTES };

/**
 * Maximum accepted DECODED pixel surface (width × height). 16384×8192 — the largest
 * full-world 2:1 equirectangular map we accept — decodes to ~512 MB RGBA, the upper
 * bound of what the renderer can reasonably hold. The domain's per-axis
 * MAX_IMAGE_DIMENSION_PX (32768) alone would admit a 32768×16384 surface (~2 GB
 * RGBA), so the total-pixel cap is the decode-bomb defence the per-axis bound cannot
 * provide.
 */
export const MAX_BASE_MAP_IMAGE_PIXELS = 16384 * 8192;

/** Why the guard rejected the bytes (testable verdicts; the UI stays silent). */
export const BASE_MAP_IMAGE_REJECTION = {
  /** File size above {@link MAX_BASE_MAP_IMAGE_BYTES}. */
  TooManyBytes: 'tooManyBytes',
  /** Not a PNG / JPEG signature (allow-list; includes empty bytes / SVG / GIF …). */
  UnknownFormat: 'unknownFormat',
  /** Allow-listed signature but the dimension header is missing / garbled. */
  MalformedHeader: 'malformedHeader',
  /** Declared dimensions out of bounds (per-axis domain caps or the pixel cap). */
  BadDimensions: 'badDimensions',
  /**
   * Header-valid but the bytes do NOT actually decode to an image (FR-04 差し替え):
   * a truncated / corrupt PNG-or-JPEG whose signature + dimension header pass this
   * sync guard yet fail a real `createImageBitmap` decode. Never produced by
   * {@link checkBaseMapImageBytes} itself (it does no decode); it is the verdict the
   * FR-04 replace flow's async decode probe returns so a broken image is rejected
   * BEFORE it is adopted + saved as a half asset (see file-ops/basemap-replace).
   */
  Undecodable: 'undecodable',
} as const;

export type BaseMapImageRejection =
  (typeof BASE_MAP_IMAGE_REJECTION)[keyof typeof BASE_MAP_IMAGE_REJECTION];

/** The MIME types on the allow-list (also stamped onto the decode Blob explicitly). */
export type BaseMapImageMime = 'image/png' | 'image/jpeg';

/** The guard verdict: ok carries the sniffed MIME + header dimensions. */
export type BaseMapImageCheck =
  | {
      readonly ok: true;
      readonly mimeType: BaseMapImageMime;
      readonly widthPx: number;
      readonly heightPx: number;
    }
  | { readonly ok: false; readonly reason: BaseMapImageRejection };

/** Big-endian u32 / u16 reads via shifts (safe for subarray views, unlike DataView on .buffer). */
const readU32 = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const readU16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((v, i) => bytes[i] === v);
}

/** PNG dimensions from the IHDR chunk (always the first chunk per spec), or null. */
function sniffPngDimensions(
  bytes: Uint8Array,
): { widthPx: number; heightPx: number } | null {
  // signature(8) + chunk length(4) + 'IHDR'(4) + width(4) + height(4) = 24 bytes.
  if (bytes.length < 24) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  return { widthPx: readU32(bytes, 16), heightPx: readU32(bytes, 20) };
}

/** JPEG SOI signature (FF D8 FF …). */
function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** True for the SOFn markers that carry frame dimensions (C0–CF minus C4/C8/CC). */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG dimensions from the first SOF frame header, scanning the segment chain
 * (each non-standalone segment declares its own length, so the scan skips APPn /
 * quantization / etc. in O(#segments) without decoding), or null when malformed /
 * no SOF before EOI / end of bytes.
 */
function sniffJpegDimensions(
  bytes: Uint8Array,
): { widthPx: number; heightPx: number } | null {
  let pos = 2; // past SOI
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    let marker = bytes[pos + 1]!;
    // Skip fill bytes (a run of FFs before the marker byte).
    while (marker === 0xff && pos + 2 < bytes.length) {
      pos += 1;
      marker = bytes[pos + 1]!;
    }
    pos += 2; // past FF + marker
    if (marker === 0xd9) return null; // EOI before any SOF
    // Standalone markers without a length field: TEM / RSTn / (a stray) SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (pos + 1 >= bytes.length) return null;
    const segLen = readU16(bytes, pos);
    if (segLen < 2) return null;
    if (isSofMarker(marker)) {
      // SOF segment data: length(2) precision(1) height(2) width(2) …
      if (pos + 6 >= bytes.length) return null;
      return { widthPx: readU16(bytes, pos + 5), heightPx: readU16(bytes, pos + 3) };
    }
    pos += segLen;
  }
  return null;
}

/** Apply the dimension caps to header-parsed dimensions (domain bounds + pixel cap). */
function checkedDimensions(
  dims: { widthPx: number; heightPx: number },
  mimeType: BaseMapImageMime,
): BaseMapImageCheck {
  // Per-axis bounds via the domain's OWN boundary validator (MAX/MIN_IMAGE_DIMENSION_PX
  // — the single source the base-map差し替え flow also uses, 教訓 §4 単一真実源). The
  // header-parsed values are always finite integers, so only the range checks can fail.
  const validated = validateImageDescriptor({
    widthPx: dims.widthPx,
    heightPx: dims.heightPx,
    source: '',
  });
  if (!validated.ok) {
    return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.BadDimensions };
  }
  if (dims.widthPx * dims.heightPx > MAX_BASE_MAP_IMAGE_PIXELS) {
    return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.BadDimensions };
  }
  return { ok: true, mimeType, widthPx: dims.widthPx, heightPx: dims.heightPx };
}

/**
 * The guard entry: check untrusted base-map image bytes BEFORE any decode (see the
 * module doc for the four stages). Pure and synchronous; the host caches the verdict
 * per byte-array reference so the O(bytes) header scan runs once per load, not per
 * frame. A rejected verdict makes the host display the preset (silent fallback).
 */
export function checkBaseMapImageBytes(bytes: Uint8Array): BaseMapImageCheck {
  if (bytes.length > MAX_BASE_MAP_IMAGE_BYTES) {
    return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.TooManyBytes };
  }
  if (hasPngSignature(bytes)) {
    const dims = sniffPngDimensions(bytes);
    if (dims === null) return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.MalformedHeader };
    return checkedDimensions(dims, 'image/png');
  }
  if (hasJpegSignature(bytes)) {
    const dims = sniffJpegDimensions(bytes);
    if (dims === null) return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.MalformedHeader };
    return checkedDimensions(dims, 'image/jpeg');
  }
  return { ok: false, reason: BASE_MAP_IMAGE_REJECTION.UnknownFormat };
}
