// S7 base-map byte guard (Codex review #3 — 非信頼 .tmap 画像バイトの資源枯渇防御).
// The .tmap ZIP is untrusted external input: a small compressed entry can declare a
// huge pixel surface (decompression/decode bomb) and exhaust renderer memory/CPU at
// `createImageBitmap`. The guard runs BEFORE any decode: byte-size cap, PNG/JPEG
// format allow-list (header signature), lightweight header dimension parse, and
// dimension caps that REUSE the domain's own bounds (MAX/MIN_IMAGE_DIMENSION_PX via
// validateImageDescriptor — 単一真実源) plus an explicit total-pixel cap. A rejected
// image falls back to the preset in the host (silent, 既存規約) — asserted in the
// host-ports basemap tests; here we pin the pure verdicts.

import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_DIMENSION_PX } from '../../domain/basemap/index';

import {
  BASE_MAP_IMAGE_REJECTION,
  MAX_BASE_MAP_IMAGE_BYTES,
  MAX_BASE_MAP_IMAGE_PIXELS,
  checkBaseMapImageBytes,
} from './base-map-image-guard';

function writeU32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/** Minimal PNG header: signature + IHDR chunk carrying width/height. */
function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32(b, 8, 13); // IHDR data length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  writeU32(b, 16, width);
  writeU32(b, 20, height);
  return b;
}

/** Minimal JPEG: SOI + an APP0 segment (must be SKIPPED) + SOF0 with dimensions. */
function jpegBytes(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

describe('checkBaseMapImageBytes (S7 decode-bomb guard)', () => {
  it('accepts a valid PNG header: mime + header-parsed dimensions', () => {
    const check = checkBaseMapImageBytes(pngBytes(4096, 2048));
    expect(check).toEqual({
      ok: true,
      mimeType: 'image/png',
      widthPx: 4096,
      heightPx: 2048,
    });
  });

  it('accepts a valid JPEG, parsing SOF dimensions PAST a leading APP0 segment', () => {
    const check = checkBaseMapImageBytes(jpegBytes(1200, 600));
    expect(check).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
      widthPx: 1200,
      heightPx: 600,
    });
  });

  it('rejects bytes above MAX_BASE_MAP_IMAGE_BYTES regardless of content', () => {
    const huge = new Uint8Array(MAX_BASE_MAP_IMAGE_BYTES + 1);
    huge.set(pngBytes(2, 2)); // even a valid header does not save an oversized payload
    const check = checkBaseMapImageBytes(huge);
    expect(check).toEqual({ ok: false, reason: BASE_MAP_IMAGE_REJECTION.TooManyBytes });
  });

  it('rejects formats outside the PNG/JPEG allow-list (SVG / random / empty)', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const random = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const bytes of [svg, random, new Uint8Array()]) {
      expect(checkBaseMapImageBytes(bytes)).toEqual({
        ok: false,
        reason: BASE_MAP_IMAGE_REJECTION.UnknownFormat,
      });
    }
  });

  it('rejects a PNG signature with a garbled / truncated IHDR', () => {
    // Signature only — no IHDR chunk at all.
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkBaseMapImageBytes(truncated)).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.MalformedHeader,
    });
    // Full length but the chunk tag is not IHDR.
    const wrongTag = pngBytes(4, 2);
    wrongTag.set([0x49, 0x44, 0x41, 0x54], 12); // 'IDAT'
    expect(checkBaseMapImageBytes(wrongTag)).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.MalformedHeader,
    });
  });

  it('rejects a JPEG with no SOF frame header (dimensions unknowable)', () => {
    // SOI + APP0 only, then EOI — never a SOF.
    const noSof = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(checkBaseMapImageBytes(noSof)).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.MalformedHeader,
    });
  });

  it('rejects per-axis dimensions above the domain MAX_IMAGE_DIMENSION_PX (単一真実源)', () => {
    const tooWide = pngBytes(MAX_IMAGE_DIMENSION_PX + 1, 2);
    expect(checkBaseMapImageBytes(tooWide)).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.BadDimensions,
    });
  });

  it('rejects a total pixel count above MAX_BASE_MAP_IMAGE_PIXELS (per-axis OK, surface bomb)', () => {
    // Each axis is within MAX_IMAGE_DIMENSION_PX (32768), but the surface (32768×8192)
    // is 4× the pixel cap — the classic small-file/huge-surface decode bomb.
    const bomb = pngBytes(32768, 8192);
    expect(32768).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION_PX);
    expect(32768 * 8192).toBeGreaterThan(MAX_BASE_MAP_IMAGE_PIXELS);
    expect(checkBaseMapImageBytes(bomb)).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.BadDimensions,
    });
  });

  it('accepts the pixel-cap boundary exactly (16384×8192 full-world 2:1)', () => {
    expect(16384 * 8192).toBe(MAX_BASE_MAP_IMAGE_PIXELS);
    const check = checkBaseMapImageBytes(pngBytes(16384, 8192));
    expect(check.ok).toBe(true);
  });

  it('rejects degenerate dimensions below the domain MIN (a 1×1 is not a map)', () => {
    expect(checkBaseMapImageBytes(pngBytes(1, 1))).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.BadDimensions,
    });
    expect(checkBaseMapImageBytes(pngBytes(0, 2048))).toEqual({
      ok: false,
      reason: BASE_MAP_IMAGE_REJECTION.BadDimensions,
    });
  });
});
