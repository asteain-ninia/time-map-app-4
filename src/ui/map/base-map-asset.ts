// UI layer (map): the bundled preset 出界図 (base-map) asset loader (FR-03).
//
// The render layer already knows HOW to paint a base map: `buildBaseMapPrimitive`
// turns a decoded image + equirectangular meta into a `BaseMapPrimitive`, and the
// Canvas2D renderer draws it (canvas2d-renderer.drawBaseMap, 技術方針 2.4). What
// was missing was the actual IMAGE: the host previously composited only the
// graticule, leaving the central map blank of land. This module supplies the
// bundled preset land image so the FR-03 background (陸地輪郭) is drawn.
//
// The asset is a land-only equirectangular SVG distilled from the reference
// 出界図 (reference/data/base-map.svg): the terrain/land fills are kept and the
// design-grid strokes + text labels are stripped, so it composes cleanly UNDER our
// own graticule rather than fighting a second grid. It is imported with Vite's
// `?url` suffix, so the build bundles it and serves it from the app's OWN origin —
// admitted by the renderer CSP (`img-src 'self'`) and loaded fully offline
// (FR-02 / FR-03). Decoding is async (SVG → raster); callers paint the grid first
// and re-composite once `onReady` fires.
//
// DOM-only by nature (it constructs an `Image`); like host-ports.ts it is exercised
// in the real Electron renderer + E2E, not the node render-layer unit tests.

import presetBaseMapUrl from '../../render/assets/base-map-land.svg?url';
import { FULL_WORLD_META, type EquirectangularMeta } from '../../domain/basemap/index';

/** The bundled preset land image's equirectangular world rectangle (full world). */
export const PRESET_BASEMAP_META: EquirectangularMeta = FULL_WORLD_META;

/** The bundled preset 出界図 asset URL (same-origin, offline; FR-02 / FR-03). */
export const PRESET_BASEMAP_URL: string = presetBaseMapUrl;

/**
 * Load the bundled preset base-map image. Resolves with a decoded `HTMLImageElement`
 * ready for `drawImage`, or `null` if the asset cannot be decoded — the caller then
 * keeps the graticule-only background (受け入れ基準: 読込失敗 → グリッド維持). The
 * failure path is SILENT (no console error) so a missing/garbled asset never trips
 * the E2E "no renderer console errors during launch" gate; the visible fallback is
 * the clean graticule, which is itself an acceptable base per the task.
 *
 * `doc` defaults to the ambient document so the renderer host can call it with no
 * argument; it is injectable for completeness.
 */
export function loadPresetBaseMap(
  doc: Document = document,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = doc.createElement('img');
    // Decode off the layout/paint path; we only need the bitmap for the canvas.
    img.decoding = 'async';
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => resolve(null), { once: true });
    img.src = PRESET_BASEMAP_URL;
  });
}
