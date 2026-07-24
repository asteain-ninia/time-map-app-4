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
import { screenToWorld, worldToScreen } from './vtransform';

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

// --- V1 判読性: label thinning + placement ----------------------------------
//
// The graticule LINES may be arbitrarily dense (they are hairlines and read fine), but
// the LABELS are ~11px text boxes ~35 CSS px wide ("170°W"). At the FR-11 fit-all zoom
// the 10° meridian pitch is only ~22 px, so labelling every meridian produced a
// continuous unreadable run-on ("180°0°170°W60°W…") — a STRUCTURAL certainty (pitch <
// glyph width), not a chance collision. The rules below fix that without touching the
// domain layer (which owns enumeration + text only, never draw density):
//
//   - thin the LABELS to a minimum on-screen pitch; never thin the LINES;
//   - anchor the thinning to the GLOBAL `value/spacing` integer grid (not to the
//     viewport edge) so panning does not make labels blink in and out / dance;
//   - always keep the emphasized lines' labels (0° / 180° / equator) — reusing the U18
//     SINGLE emphasis判定, never a second `lon === 0` test (受け入れ基準 8) — AND keep the
//     meridian step a DIVISOR of those lines' own index period, so an always-kept label
//     lands ON the thinned grid instead of between two of its positions (otherwise the
//     minimum pitch is guaranteed for every label EXCEPT the emphasized ones, and a
//     ±360° pan silently changes which labels survive: see alignStepToEmphasisPeriod);
//   - place text BESIDE / BELOW its own line and clamp it inside the canvas, so no glyph
//     is bisected by its line nor sliced off by the viewport edge — spending only the
//     part of the label gap the thinning did not already reserve for the neighbour;
//   - resolve the EQUATOR ROW (its own label + every meridian label) as ONE constraint so
//     the pair cannot be squashed back together by a canvas-edge clamp;
//   - give every grid label a halo, at the SAME FR-109 alpha as its text, so it survives
//     a dark or busy base map yet still disappears completely at gridOpacity 0.

/**
 * Minimum on-screen distance (CSS px) between two KEPT grid labels. Sized for the
 * widest ordinary graticule label ("170°W" ≈ 35 px at 11 px sans-serif) plus a visible
 * gap, so consecutive labels read as separate tokens.
 */
export const MIN_LABEL_PITCH_PX = 48;

/**
 * Alpha of the contrasting outline drawn under a FULLY OPAQUE grid label (HB3-26 halo
 * channel, V1 1-e). The graticule text is thin and semi-transparent by design (FR-109
 * gridOpacity), so over a brown/green base map it otherwise disappears; near-opaque
 * white reads under both the normal grey and the emphasized red.
 */
const GRID_LABEL_HALO_ALPHA = 0.85;

/**
 * The halo color for a grid label at a given FR-109 `gridOpacity`.
 *
 * The halo rides the SAME alpha as the text it outlines: a label is ONE visual object,
 * so fading the graticule must fade its outline too. Keeping the halo at a fixed
 * near-opaque white made `gridOpacity = 0` — "make the graticule invisible" — leave a
 * field of white digit OUTLINES stencilled over the map (the fill was `rgba(…, 0)` but
 * `strokeText` still painted), i.e. the one setting that must erase the grid instead
 * drew a ghost of it.
 */
export function gridLabelHalo(opacity: number): string {
  return withOpacity('#ffffff', GRID_LABEL_HALO_ALPHA * Math.min(1, Math.max(0, opacity)));
}

/**
 * Contrasting outline for a FULL-STRENGTH grid label. Emphasized labels
 * (0° / ±180° / equator) use this: like their LINES they are opacity-independent
 * (受け入れ基準 8 — the emphasis must stay visually distinct at any gridOpacity).
 */
export const GRID_LABEL_HALO = gridLabelHalo(1);

/** Parallel label: pushed right off the left canvas edge so no glyph is sliced (1-b). */
const LAT_LABEL_INSET_PX = 6;
/** Parallel label: lifted so the text sits ABOVE its own line instead of on it. */
const LAT_LABEL_LIFT_PX = -4;
/** Meridian label: dropped BELOW the equator so the line does not bisect the digits. */
const LON_LABEL_DROP_PX = 14;
/** Breathing room kept between a clamped label and the canvas edge. */
const LABEL_EDGE_MARGIN_PX = 2;

/**
 * Mean advance width of a graticule-label glyph as a fraction of the font size. The
 * render layer is PURE (no `measureText` — that would need a Canvas context, which only
 * `canvas2d-renderer` may touch), so the edge clamp below needs an estimate. Graticule
 * text is a closed alphabet — digits, `°`, `N/S/E/W`, `.` — whose sans-serif advances sit
 * around 0.5–0.6 em; 0.62 over-estimates slightly, which is the safe direction for a
 * "keep it inside the canvas" clamp.
 */
const LABEL_CHAR_WIDTH_RATIO = 0.62;

/** Estimated on-screen width (CSS px) of a graticule label. See {@link LABEL_CHAR_WIDTH_RATIO}. */
export function estimateGridLabelWidthPx(text: string, fontPx: number): number {
  return text.length * fontPx * LABEL_CHAR_WIDTH_RATIO;
}

/**
 * The label STEP for a given on-screen line pitch: keep every `step`-th label so the
 * kept ones are ≥ {@link MIN_LABEL_PITCH_PX} apart. A pitch that already clears the
 * minimum yields 1 (label everything). A degenerate pitch (0 / negative / NaN — an
 * unmeasured viewport or a degenerate camera) resolves to the named default 1 rather
 * than an infinite step that would silently erase every label (教訓 5.18).
 */
export function labelStepForPitch(pitchPx: number, minPitchPx = MIN_LABEL_PITCH_PX): number {
  if (!Number.isFinite(pitchPx) || pitchPx <= 0) return 1;
  return Math.max(1, Math.ceil(minPitchPx / pitchPx));
}

/**
 * The period, in GRID INDICES (`round(lon / spacing)`), at which the EMPHASIZED
 * meridians repeat: 0° and ±180° are 180° apart, so they occupy every
 * `180 / spacing`-th index of the global label grid. Every allowed spacing
 * (0.1 / 0.5 / 1 / 5 / 10 / 15 / 30) divides 180, so this is an exact integer; the
 * `round` only absorbs float representation error (180 / 0.1 is not exactly 1800).
 */
export function emphasisIndexPeriod(spacing: number): number {
  if (!Number.isFinite(spacing) || spacing <= 0) return 1;
  return Math.max(1, Math.round(180 / spacing));
}

/**
 * Round a raw label step UP to the smallest DIVISOR of the emphasized meridians' index
 * period — the invariant that makes "always label the emphasized lines" compatible with
 * "kept labels are ≥ MIN_LABEL_PITCH_PX apart".
 *
 * WHY (the bug this closes): the thinning keeps a label iff `index % step === 0`, but
 * the emphasized meridians (0° / ±180°) were kept UNCONDITIONALLY. Their index is a
 * multiple of {@link emphasisIndexPeriod}; when `step` does not divide that period the
 * emphasized label falls BETWEEN two grid positions, so its distance to the neighbouring
 * kept label is one or two grid cells instead of `step` cells — far under the minimum
 * pitch. At the default 10° spacing (period 18) the raw step is 5 at zoom 1.0 and 4 at
 * zoom 1.3, neither of which divides 18: `180°` overlapped its neighbour by ~5–20 px on
 * an ordinary wheel zoom-out, re-creating the very run-on the thinning exists to prevent.
 *
 * The same divisibility also fixes the ±360° PAN periodicity: one turn shifts every index
 * by `2 × period`, so a step dividing the period leaves the surviving label SET — and
 * therefore the on-screen pattern — invariant under a whole-turn pan (the continuous
 * scalar `centerLon` is never folded, so this must hold by construction).
 *
 * Rounding is always UPWARD (never below the raw step) so the pitch guarantee cannot
 * regress; the period itself is the cap. A degenerate raw step resolves to the named
 * default 1 rather than erasing every label (教訓 5.18).
 *
 * DEGENERATE TAIL: a raw step ABOVE the period (only reachable below zoom ≈ 0.27, i.e.
 * under the FR-10 minimum zoom of 1) saturates at the period, where the only surviving
 * labels are the emphasized ones themselves; they are then closer than the minimum pitch,
 * but thinning them away would violate 受け入れ基準 8. Saturating is the closest the
 * thinning can get while keeping the emphasized labels.
 */
export function alignStepToEmphasisPeriod(rawStep: number, period: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 1) return 1;
  if (!Number.isFinite(period) || period <= 1) return 1;
  const wanted = Math.ceil(rawStep);
  if (wanted >= period) return period;
  for (let s = wanted; s < period; s += 1) {
    if (period % s === 0) return s;
  }
  return period;
}

/** On-screen distance between adjacent grid lines, in CSS px (0 when degenerate). */
function linePitchPx(extentPx: number, spanDeg: number, spacing: number): number {
  if (!Number.isFinite(extentPx) || !Number.isFinite(spanDeg) || spanDeg <= 0) return 0;
  return (extentPx * spacing) / spanDeg;
}

/**
 * Whether a grid line at `value` survives the label thinning. The step grid is anchored
 * to the GLOBAL integer index `round(value / spacing)` — a viewport-relative index would
 * shift by one whenever a pan crossed a grid line, making the surviving labels flicker
 * and slide (V1 「パン時に踊らない」).
 */
function onLabelStep(value: number, spacing: number, step: number): boolean {
  if (step <= 1) return true;
  return Math.round(value / spacing) % step === 0;
}

/**
 * Adjust a label's vertical offset so the text stays fully inside the canvas (1-c: the
 * `90°N` label used to be sliced in half by the top edge). Only applies when the line's
 * own anchor is ON screen — an off-screen parallel must NOT be dragged into view, or
 * every hidden label would pile up along the edge. `fontPx` is the ascent budget for the
 * alphabetic baseline; the bottom keeps a descender allowance.
 */
function clampLabelOffsetY(
  anchorY: number,
  offsetY: number,
  heightCss: number,
  fontPx: number,
): number {
  if (!Number.isFinite(anchorY) || anchorY < 0 || anchorY > heightCss) return offsetY;
  const minY = fontPx + LABEL_EDGE_MARGIN_PX;
  const maxY = heightCss - LABEL_EDGE_MARGIN_PX;
  if (!(maxY > minY)) return offsetY;
  const clamped = Math.min(maxY, Math.max(minY, anchorY + offsetY));
  return clamped - anchorY;
}

/**
 * Adjust a CENTRE-aligned label's horizontal offset so its text box stays inside the
 * canvas. Without this the ±180° meridian at the very canvas edge (the fit-all view
 * spans exactly one turn, so a meridian lands on x = 0 / x = widthCss) had HALF its
 * glyphs sliced off — "180°" read as "0°", i.e. an actively WRONG value, the worst
 * failure mode of the 1-b family. Same guard as {@link clampLabelOffsetY}: only a line
 * whose anchor is on screen is nudged, so hidden meridians never pile up at the edge.
 */
function clampCenteredOffsetX(
  anchorX: number,
  offsetX: number,
  widthCss: number,
  halfWidthPx: number,
  maxNudgePx: number,
): number {
  if (!Number.isFinite(anchorX) || anchorX < 0 || anchorX > widthCss) return offsetX;
  const minX = halfWidthPx + LABEL_EDGE_MARGIN_PX;
  const maxX = widthCss - halfWidthPx - LABEL_EDGE_MARGIN_PX;
  if (!(maxX > minX)) return offsetX;
  const clamped = Math.min(maxX, Math.max(minX, anchorX + offsetX));
  const wanted = clamped - anchorX;
  // BUDGETED nudge (the interaction the two rules used to miss): the thinning only
  // guarantees a gap of `keptPitch` between ANCHORS, so sliding an edge label inward by
  // its full half-width eats into that gap and can collide with the neighbour the
  // thinning just paid for. `maxNudgePx` is the part of the gap that is not already
  // spoken for by the two text boxes; spending more of it than that would trade a
  // clipped edge label for an overlapping PAIR, which is strictly worse.
  if (!Number.isFinite(maxNudgePx) || maxNudgePx <= 0) return offsetX;
  return Math.sign(wanted) * Math.min(Math.abs(wanted), maxNudgePx);
}

/**
 * Half the estimated width of the WIDEST meridian label a given spacing can produce —
 * the meridian one step short of the antimeridian ("170°W" at 10°, "179.9°W" at 0.1°).
 * The nudge budget above must assume the neighbour is that wide, because a label only
 * knows its OWN text (the render layer builds primitives one at a time).
 */
function widestMeridianLabelHalfPx(spacing: number, fontPx: number): number {
  return estimateGridLabelWidthPx(formatLongitudeLabel(spacing - 180), fontPx) / 2;
}

/**
 * The two vertical offsets of the EQUATOR ROW, resolved together: the row all meridian
 * labels share (dropped below the equator line) and the equator's own parallel label
 * (lifted above it).
 *
 * WHY TOGETHER (V1 1-d 再発): both were clamped into the canvas INDEPENDENTLY, so a
 * vertical pan that pushed the equator within {@link LON_LABEL_DROP_PX} of the top or
 * bottom edge squashed one against the edge while the other kept its raw offset — the
 * gap collapsed from 18 px to ~1 px and the meridian digits landed back on top of the
 * equator's `0°` in the corner, exactly the triple collision the layout exists to
 * prevent. Resolving both against ONE constraint (`meridianY − equatorLabelY ≥ fontPx`)
 * makes the separation an invariant of the layout rather than a coincidence of the
 * default camera. The equator label yields first (it moves UP, away from the meridian
 * row); only when it is already pinned to the top margin is the meridian row pushed
 * DOWN instead.
 */
function resolveEquatorRowOffsets(
  anchorY: number,
  heightCss: number,
  fontPx: number,
): { meridianOffsetY: number; equatorLabelOffsetY: number } {
  const meridianOffsetY = clampLabelOffsetY(anchorY, LON_LABEL_DROP_PX, heightCss, fontPx);
  const equatorOffsetY = clampLabelOffsetY(anchorY, LAT_LABEL_LIFT_PX, heightCss, fontPx);
  const minY = fontPx + LABEL_EDGE_MARGIN_PX;
  const maxY = heightCss - LABEL_EDGE_MARGIN_PX;
  let meridianY = anchorY + meridianOffsetY;
  let equatorY = anchorY + equatorOffsetY;
  if (Number.isFinite(anchorY) && maxY > minY && meridianY - equatorY < fontPx) {
    equatorY = Math.max(minY, meridianY - fontPx);
    if (meridianY - equatorY < fontPx) meridianY = Math.min(maxY, equatorY + fontPx);
  }
  return {
    meridianOffsetY: meridianY - anchorY,
    equatorLabelOffsetY: equatorY - anchorY,
  };
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
 * The label HALO for a given emphasis kind — resolved from the SAME判定 (and the same
 * alpha) as {@link labelColorFor}, so text and outline can never disagree about how
 * visible the label is (FR-109 gridOpacity = 0 must erase BOTH).
 */
function labelHaloFor(emphasis: GridEmphasis, style: GridStyle): string {
  return emphasis === GRID_EMPHASIS.None ? gridLabelHalo(style.opacity) : GRID_LABEL_HALO;
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
 * The latitude span [south, north] currently covered by the viewport, via the SAME
 * shared transform as {@link viewportLonSpan} (so the parallel label thinning measures
 * the pitch the user actually sees). A degenerate viewport/camera yields the full band
 * [−90, 90] so a not-yet-measured frame still behaves like the whole world.
 */
export function viewportLatSpan(
  camera: Camera,
  viewport: Viewport,
): { south: number; north: number } {
  if (
    !Number.isFinite(viewport.heightCss) ||
    viewport.heightCss <= 0 ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  ) {
    return { south: LAT_MIN_DEG, north: LAT_MAX_DEG };
  }
  const north = screenToWorld({ x: 0, y: 0 }, camera, viewport).lat;
  const south = screenToWorld({ x: 0, y: viewport.heightCss }, camera, viewport).lat;
  return { south, north };
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
  const { south, north } = viewportLatSpan(camera, viewport);

  // V1 判読性: how many grid steps must be skipped between two LABELS so the kept ones
  // do not collide. Derived from the on-screen pitch of the lines themselves, so it
  // relaxes back to "label everything" as soon as the user zooms in far enough.
  const lonLinePitchPx = linePitchPx(viewport.widthCss, east - west, style.spacing);
  // The meridian step must additionally DIVIDE the emphasized meridians' index period,
  // because those labels are kept unconditionally: a step that does not divide it puts
  // 0° / ±180° between two grid positions and their neighbours collide (fix-forward
  // HIGH). The same divisibility makes the kept set invariant under a ±360° pan.
  const lonLabelStep = alignStepToEmphasisPeriod(
    labelStepForPitch(lonLinePitchPx),
    emphasisIndexPeriod(style.spacing),
  );
  // Distance between two KEPT meridian labels' anchors — the budget the canvas-edge
  // nudge is allowed to spend without colliding with the neighbour it protects.
  const keptLonLabelPitchPx = lonLabelStep * lonLinePitchPx;
  const widestLabelHalfPx = widestMeridianLabelHalfPx(style.spacing, style.labelFontPx);
  // Parallels need no such alignment: the only emphasized latitude is the equator, whose
  // grid index is 0 — a multiple of EVERY step — so it is never off the label grid.
  const latLabelStep = labelStepForPitch(
    linePitchPx(viewport.heightCss, north - south, style.spacing),
  );
  // The equator's screen row carries BOTH the equator's own parallel label and the row
  // every meridian label sits on; their offsets are resolved together so the pair stays
  // separated even when a vertical pan pins the row against a canvas edge (1-d 再発).
  const equatorAnchorY = worldToScreen({ lon: 0, lat: 0 }, camera, viewport).y;
  const equatorRow = resolveEquatorRowOffsets(
    equatorAnchorY,
    viewport.heightCss,
    style.labelFontPx,
  );

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
      // Already spans the full continuous viewport span — the renderer must NOT
      // re-tile it across turns (would compound translucent alpha, Codex high #2).
      wrap: false,
    };
    out.push(line);
    // The LINE is always drawn; only its LABEL is subject to thinning. An emphasized
    // parallel (the equator) keeps its label at ANY step — via the U18 SINGLE emphasis
    // 判定 already resolved above, not a second `lat === 0` test (受け入れ基準 8).
    if (emphasis === GRID_EMPHASIS.None && !onLabelStep(lat, style.spacing, latLabelStep)) {
      continue;
    }
    // Parallel label: inset from the left edge (so no glyph is sliced, 1-b) and lifted
    // above its own line (so the hairline does not strike through the text). The ±90°
    // labels are clamped back inside the canvas (1-c).
    const anchor = { lon: west, lat };
    const label: LabelPrimitive = {
      kind: 'label',
      at: anchor,
      text: formatLatitudeLabel(lat),
      fontPx: style.labelFontPx,
      fill: labelColorFor(emphasis, style),
      halo: labelHaloFor(emphasis, style),
      offsetPx: {
        x: LAT_LABEL_INSET_PX,
        y:
          // The equator shares its row with every meridian label, so its lift comes from
          // the jointly-resolved row (above) rather than an independent clamp. The
          // branch reuses the U18 SINGLE emphasis判定 — never a second `lat === 0` test.
          emphasis === GRID_EMPHASIS.Equator
            ? equatorRow.equatorLabelOffsetY
            : clampLabelOffsetY(
                worldToScreen(anchor, camera, viewport).y,
                LAT_LABEL_LIFT_PX,
                viewport.heightCss,
                style.labelFontPx,
              ),
      },
      align: 'left',
      baseline: 'alphabetic',
      wrap: false,
    };
    out.push(label);
  }

  // --- Meridians (constant longitude lines) across the full latitude band ------
  // Every meridian label shares the equator's screen row, resolved ONCE above.
  const meridianLabelOffsetY = equatorRow.meridianOffsetY;
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
      // Meridians are enumerated across the full continuous span (below), so they
      // are already seam-tiled: opt out of the renderer turn-loop (Codex high #2).
      wrap: false,
    };
    out.push(line);
    // Same rule as the parallels: thin the LABEL only, and never thin away an
    // emphasized meridian (0° / ±180°) — the SAME判定 that styled the line.
    if (emphasis === GRID_EMPHASIS.None && !onLabelStep(lon, style.spacing, lonLabelStep)) {
      continue;
    }
    // Meridian label anchored at the equator, centred on its own meridian and dropped
    // BELOW the equator line — which also separates it from the equator's own label at
    // the左隅 (1-d 三重衝突). The TEXT is U05-normalized so it reads the true longitude
    // across the seam (受け入れ基準 13), and is nudged horizontally when a meridian sits
    // on the canvas edge so no glyph is sliced.
    const text = formatLongitudeLabel(lon);
    const anchor = { lon, lat: 0 };
    const label: LabelPrimitive = {
      kind: 'label',
      at: anchor,
      text,
      fontPx: style.labelFontPx,
      fill: labelColorFor(emphasis, style),
      halo: labelHaloFor(emphasis, style),
      offsetPx: {
        x: clampCenteredOffsetX(
          worldToScreen(anchor, camera, viewport).x,
          0,
          viewport.widthCss,
          estimateGridLabelWidthPx(text, style.labelFontPx) / 2,
          keptLonLabelPitchPx -
            estimateGridLabelWidthPx(text, style.labelFontPx) / 2 -
            widestLabelHalfPx,
        ),
        y: meridianLabelOffsetY,
      },
      align: 'center',
      baseline: 'alphabetic',
      wrap: false,
    };
    out.push(label);
  }

  return out;
}
