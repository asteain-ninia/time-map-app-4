// Grid + base-map batch building for the render layer (U18 / FR-03 / FR-06 /
// FR-07 / FR-13 / FR-17). Render layer: pure functions that turn the U18 domain
// grid model + a camera/viewport into declarative `DrawPrimitive`s for the
// `MapRenderer` (技術方針 2.4). No Canvas API here — only the pure transform
// (vtransform) + the U18 domain model are consumed (依存方向 render→domain).
//
// SCOPE:
//   - build the BASE-MAP primitive (背景, drawn first → 最背面; FR-06: it is a draw
//     primitive only, never a hit-test target — the renderer's hitTest goes through
//     screenToWorld and never consults primitives, so the base map cannot steal
//     input, 受け入れ基準 6),
//   - build the GRATICULE primitives: parallels (full-band), meridians (covering
//     the continuous viewport span so they tile across the seam, FR-07), with the
//     equator / prime-meridian / antimeridian EMPHASIZED via the U18 SINGLE判定
//     (shared by line + label, 受け入れ基準 8),
//   - build constant-on-screen-font LABELS (FR-13 / FR-17): the font px is a
//     screen-space constant carried on the primitive (the renderer never zooms it),
//     so this shares FR-17's mechanism rather than re-deriving it.
//
// The actual ±360° wrap-replication of every primitive across the seam is done by
// the renderer's draw loop (canvas2d-renderer uses wrapTurnsForViewport); this
// module emits ONE world-space copy of the grid/base-map and lets the renderer
// tile it (single source for wrap tiling, 教訓 §4). Meridians are still enumerated
// across the full continuous viewport span so a deep zoom-in near the seam draws
// every visible meridian even within a single turn.

import {
  type GridEmphasis,
  GRID_EMPHASIS,
  type GridSpacingDeg,
  type EquirectangularMeta,
  graticuleLatitudes,
  graticuleLongitudes,
  latitudeEmphasis,
  longitudeEmphasis,
  formatLatitudeLabel,
  formatLongitudeLabel,
  LAT_MIN_DEG,
  LAT_MAX_DEG,
} from '../domain/basemap/index';

import type { Camera, Viewport } from './camera';
import type {
  BaseMapPrimitive,
  DrawPrimitive,
  GridLinePrimitive,
  LabelPrimitive,
} from './map-renderer';
import { screenToWorld } from './vtransform';

/**
 * Visual style for the graticule (spec FR-13 ON/OFF・間隔・色・不透明度 + emphasis).
 * `color` / `opacity` are the project-setting values (FR-109); the spacing comes
 * from the same settings. Emphasis lines use a wider width + full opacity so they
 * are visually distinct (受け入れ基準 8).
 */
export interface GridStyle {
  readonly spacing: GridSpacingDeg;
  /** Base CSS color for normal grid lines / labels (FR-109 gridColor). */
  readonly color: string;
  /** Opacity [0,1] for normal grid lines (FR-109 gridOpacity). */
  readonly opacity: number;
  /** Normal grid line width in CSS px (screen-fixed, FR-17). */
  readonly lineWidthPx: number;
  /** Emphasized line width in CSS px (wider than normal, 受け入れ基準 8). */
  readonly emphasisLineWidthPx: number;
  /** Color for emphasized lines/labels (visually distinct, 受け入れ基準 8). */
  readonly emphasisColor: string;
  /** Constant on-screen label font px (FR-13 / FR-17 ズーム非依存). */
  readonly labelFontPx: number;
}

/** Sensible default grid style (the UI/store override color/opacity/spacing). */
export const DEFAULT_GRID_STYLE: GridStyle = {
  spacing: 10,
  color: '#888888',
  opacity: 0.5,
  lineWidthPx: 1,
  emphasisLineWidthPx: 2,
  emphasisColor: '#cc3333',
  labelFontPx: 11,
};

/**
 * Convert a CSS hex color + opacity to an `rgba()` string. The renderer's
 * stroke/fill take a single CSS color string, so opacity (FR-109) is folded into
 * the color here — one place, so a grid line and its label share the same alpha
 * (教訓 §4). Non-`#rrggbb` inputs are passed through unchanged (the boundary
 * validates color format; this is a display helper, not the validator).
 */
export function withOpacity(color: string, opacity: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (m === null) return color;
  const hex = m[1]!;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The line color + width for a given emphasis kind (single resolution, 教訓 5.29). */
function lineStyleFor(
  emphasis: GridEmphasis,
  style: GridStyle,
): { stroke: string; widthPx: number } {
  if (emphasis === GRID_EMPHASIS.None) {
    return { stroke: withOpacity(style.color, style.opacity), widthPx: style.lineWidthPx };
  }
  // Emphasized lines are full-opacity + the distinct emphasis color/width.
  return { stroke: style.emphasisColor, widthPx: style.emphasisLineWidthPx };
}

/** The label color for a given emphasis kind (SAME判定 as the line, 受け入れ基準 8). */
function labelColorFor(emphasis: GridEmphasis, style: GridStyle): string {
  return emphasis === GRID_EMPHASIS.None
    ? withOpacity(style.color, style.opacity)
    : style.emphasisColor;
}

/**
 * The base-map primitive (背景, drawn first). Pure: it places the image at the
 * given equirectangular world meta; the renderer tiles it across the seam (FR-07)
 * and never adds it to hit-testing (FR-06). The image source is supplied by the
 * render adapter (the bundled preset asset or the project-copied user map).
 */
export function buildBaseMapPrimitive(
  image: CanvasImageSource,
  meta: EquirectangularMeta,
): BaseMapPrimitive {
  return {
    kind: 'basemap',
    image,
    lonWest: meta.lonWest,
    lonEast: meta.lonEast,
    latNorth: meta.latNorth,
    latSouth: meta.latSouth,
  };
}

/**
 * The continuous-scalar longitude span [west, east] currently covered by the
 * viewport, via the shared transform (so meridian enumeration matches what is on
 * screen, FR-07). A degenerate viewport/camera yields the full world [−180, 180]
 * so a not-yet-measured frame still draws the world grid.
 */
export function viewportLonSpan(
  camera: Camera,
  viewport: Viewport,
): { west: number; east: number } {
  if (
    !Number.isFinite(viewport.widthCss) ||
    viewport.widthCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  ) {
    return { west: -180, east: 180 };
  }
  const west = screenToWorld({ x: 0, y: 0 }, camera, viewport).lon;
  const east = screenToWorld({ x: viewport.widthCss, y: 0 }, camera, viewport).lon;
  return { west, east };
}

/**
 * Build the graticule primitives (parallels + meridians + labels) for the current
 * camera/viewport (FR-13). Returns an empty array when the grid is OFF
 * (`enabled === false`, 受け入れ基準 9: ON/OFF切替) — an explicit empty frame, never
 * a skipped draw (教訓 5.18).
 *
 * Parallels span the full world band [−90, 90]; the renderer clips off-screen.
 * Meridians cover the continuous viewport span so they tile across the seam.
 * Labels are anchored at the prime meridian (for parallels) and the equator (for
 * meridians) within the visible band, at a constant on-screen font (FR-17).
 */
export function buildGridPrimitives(
  enabled: boolean,
  style: GridStyle,
  camera: Camera,
  viewport: Viewport,
): DrawPrimitive[] {
  if (!enabled) return [];
  const out: DrawPrimitive[] = [];
  const { west, east } = viewportLonSpan(camera, viewport);

  // --- Parallels (constant latitude lines) drawn across the visible lon span ---
  for (const lat of graticuleLatitudes(style.spacing)) {
    const emphasis = latitudeEmphasis(lat);
    const { stroke, widthPx } = lineStyleFor(emphasis, style);
    const line: GridLinePrimitive = {
      kind: 'gridline',
      points: [
        { lon: west, lat },
        { lon: east, lat },
      ],
      widthPx,
      stroke,
    };
    out.push(line);
    // Parallel label, anchored near the left edge so it stays visible while panning.
    const label: LabelPrimitive = {
      kind: 'label',
      at: { lon: west, lat },
      text: formatLatitudeLabel(lat),
      fontPx: style.labelFontPx,
      fill: labelColorFor(emphasis, style),
    };
    out.push(label);
  }

  // --- Meridians (constant longitude lines) across the full latitude band ------
  for (const lon of graticuleLongitudes(west, east, style.spacing)) {
    const emphasis = longitudeEmphasis(lon);
    const { stroke, widthPx } = lineStyleFor(emphasis, style);
    const line: GridLinePrimitive = {
      kind: 'gridline',
      points: [
        { lon, lat: LAT_MAX_DEG },
        { lon, lat: LAT_MIN_DEG },
      ],
      widthPx,
      stroke,
    };
    out.push(line);
    // Meridian label anchored at the equator; the TEXT is U05-normalized so it
    // reads the true longitude across the seam (受け入れ基準 13).
    const label: LabelPrimitive = {
      kind: 'label',
      at: { lon, lat: 0 },
      text: formatLongitudeLabel(lon),
      fontPx: style.labelFontPx,
      fill: labelColorFor(emphasis, style),
    };
    out.push(label);
  }

  return out;
}
