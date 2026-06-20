// U26 — knife-tool render-batch builder (FR-90 / FR-92 / FR-17, 教訓 5.2 / 5.18 /
// 5.25 / 5.29).
//
// Render layer: turns the pure knife session state (domain) into a declarative
// list of `DrawPrimitive`s for the MapRenderer (U17). It owns NO Canvas API and
// NO ±360° / world↔screen math beyond the ONE screen-fixed radius conversion the
// 固定円 needs (FR-17): it describes WHAT to draw in WORLD coordinates with
// SCREEN-fixed sizes; U17 transforms positions and wrap-replicates across the seam
// (FR-07) and keeps marker / line / stroke sizes constant under zoom.
//
// What it draws, back-to-front (spec §実装方針 3):
//   1. the map-wide 薄オーバーレイ — a translucent fill over the whole world while
//      the tool is active (FR-90). Drawn as a polygon spanning the world extent so
//      U17 fills it like any region; its translucency dims the base map / features.
//   2. the対象面強調 — the selected target leaf's resolved shape, drawn with an
//      emphasis fill + a thick screen-fixed outline ON TOP of the overlay (FR-90).
//      穴は透過 / 飛び地は独立領域 fall out of the even-odd `shape` primitive (FR-21).
//   3. the分断線プレビュー — the placed cut-line points + connecting polyline in a
//      style distinct from confirmed features (FR-78 仮表示); a CLOSED line also
//      draws its closing edge back to the first point.
//   4. the固定円 — a screen-fixed-size circle centred on the FIRST cut point
//      (FR-92 / FR-17). Its WORLD radius is `radiusPx / zoom` so its ON-SCREEN
//      radius is constant regardless of zoom (ズーム非依存). It is the「閉じてよい」
//      視覚ガイド + ヒット領域, NOT the closed shape itself (FR-92 円形に限定しない).
//   5. the cut-point markers on top.
//
// 教訓 5.18: a null / inactive state yields a real, valid EMPTY frame (`[]`), never
// skipped by a falsy short-circuit. 教訓 5.2: when the session is reset the next
// build naturally produces `[]`, so the overlay / preview / circle disappear on
// every exit path with no extra clearing code.

import type { WorldCoordinate } from '../domain/coordinate';
import type { GeoMultiPolygon } from '../domain/geometry/types';
import {
  KNIFE_LINE_KIND,
  KNIFE_PHASE,
  isFixedCircleVisible,
  isOverlayVisible,
  type KnifeState,
} from '../domain/knife/index';

import type { DrawPrimitive, PolygonShapePrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Style (the single place knife colours / sizes live; FR-17 screen-fixed) --

export interface KnifeStyle {
  /** Map-wide overlay fill (translucent; FR-90 薄オーバーレイ). */
  readonly overlayFill: string;
  /** Selected target emphasis fill (over the overlay; FR-90). */
  readonly targetFill: string;
  /** Selected target emphasis outline (screen-fixed width). */
  readonly targetStroke: string;
  readonly targetStrokeWidthPx: number;
  /** Cut-line provisional stroke (distinct from confirmed features; FR-78). */
  readonly cutStroke: string;
  readonly cutWidthPx: number;
  /** Closing-edge stroke for a CLOSED cut line (translucent). */
  readonly closingStroke: string;
  readonly closingWidthPx: number;
  /** Cut-point marker fill + screen-fixed radius. */
  readonly markerFill: string;
  readonly markerRadiusPx: number;
  /** Fixed-circle outline (FR-92 / FR-17). */
  readonly circleStroke: string;
  readonly circleWidthPx: number;
  /** Fixed-circle ON-SCREEN radius in CSS px (constant under zoom; FR-17). */
  readonly circleRadiusPx: number;
}

/** Default knife visual style (overridable; e.g. project theme). */
export const DEFAULT_KNIFE_STYLE: KnifeStyle = {
  // alpha < 1 ⇒ the whole-map overlay is translucent (spec §実装方針3 薄オーバーレイ).
  overlayFill: 'rgba(20, 24, 33, 0.35)',
  targetFill: 'rgba(255, 193, 7, 0.30)',
  targetStroke: '#ffc107',
  targetStrokeWidthPx: 2.5,
  cutStroke: '#d50000',
  cutWidthPx: 2,
  closingStroke: 'rgba(213, 0, 0, 0.45)',
  closingWidthPx: 1.5,
  markerFill: '#d50000',
  markerRadiusPx: 5,
  circleStroke: 'rgba(213, 0, 0, 0.7)',
  circleWidthPx: 1.5,
  circleRadiusPx: 28,
};

/** The world extent the map-wide overlay covers (whole world; U17 seam-replicates). */
const WORLD_OVERLAY_RING: readonly WorldPoint[] = [
  { lon: -180, lat: -90 },
  { lon: 180, lat: -90 },
  { lon: 180, lat: 90 },
  { lon: -180, lat: 90 },
];

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

// --- Per-part builders ------------------------------------------------------

/** The map-wide translucent overlay (FR-90). Shown while selecting / drawing. */
function overlayPrimitive(style: KnifeStyle): DrawPrimitive {
  return {
    kind: 'polygon',
    ring: WORLD_OVERLAY_RING,
    fill: style.overlayFill,
  };
}

/**
 * The target-emphasis primitive: the selected leaf's resolved shape drawn over the
 * overlay with an emphasis fill + thick outline (FR-90). 穴透過 / 飛び地独立 are the
 * even-odd `shape` primitive's job (FR-21). `undefined` target shape ⇒ no emphasis
 * (still selecting; 教訓 5.18 a missing shape is a real "nothing to emphasize" state).
 */
function targetPrimitive(
  shape: GeoMultiPolygon | undefined,
  style: KnifeStyle,
): DrawPrimitive | undefined {
  if (shape === undefined || shape.length === 0) return undefined;
  const pieces: PolygonShapePrimitive['pieces'] = shape.map((poly) =>
    poly.map((ring) => ring.map(toWorldPoint)),
  );
  return {
    kind: 'shape',
    pieces,
    fill: style.targetFill,
    stroke: style.targetStroke,
    strokeWidthPx: style.targetStrokeWidthPx,
  };
}

/** The placed cut-line polyline (≥2 points) in provisional style (FR-78). */
function cutLinePrimitives(
  points: readonly WorldCoordinate[],
  closed: boolean,
  style: KnifeStyle,
): DrawPrimitive[] {
  if (points.length < 2) return [];
  const out: DrawPrimitive[] = [
    {
      kind: 'line',
      points: points.map(toWorldPoint),
      widthPx: style.cutWidthPx,
      stroke: style.cutStroke,
    },
  ];
  // A CLOSED cut draws the closing edge back to the first point (translucent).
  if (closed) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined) {
      out.push({
        kind: 'line',
        points: [toWorldPoint(last), toWorldPoint(first)],
        widthPx: style.closingWidthPx,
        stroke: style.closingStroke,
      });
    }
  }
  return out;
}

/** A marker per placed cut point (provisional style). */
function markerPrimitives(
  points: readonly WorldCoordinate[],
  style: KnifeStyle,
): DrawPrimitive[] {
  return points.map((p) => ({
    kind: 'point',
    at: toWorldPoint(p),
    radiusPx: style.markerRadiusPx,
    fill: style.markerFill,
  }));
}

/** Number of segments approximating the fixed circle (smooth enough at 28px). */
const CIRCLE_SEGMENTS = 32;

/**
 * The 固定円 centred on the FIRST cut point (FR-92). FR-17 / ズーム非依存: the circle's
 * ON-SCREEN radius is constant, so its WORLD radius is `circleRadiusPx / zoom` —
 * as zoom (CSS px per degree) grows the world radius shrinks, keeping the screen
 * radius fixed. Latitude scaling matches the equirectangular transform (same `zoom`
 * for lon-x and lat-y), so the ring is a screen-space circle. Emitted as a closed
 * polyline so U17 strokes it at a screen-fixed width without filling.
 */
function fixedCirclePrimitive(
  center: WorldCoordinate,
  zoom: number,
  style: KnifeStyle,
): DrawPrimitive | undefined {
  if (!(zoom > 0)) return undefined;
  const worldRadius = style.circleRadiusPx / zoom;
  const ring: WorldPoint[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i += 1) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push({
      lon: center.lon + Math.cos(t) * worldRadius,
      lat: center.lat + Math.sin(t) * worldRadius,
    });
  }
  return {
    kind: 'line',
    points: ring,
    widthPx: style.circleWidthPx,
    stroke: style.circleStroke,
  };
}

// --- Whole-state batch ------------------------------------------------------

/** Inputs the builder needs beyond the session state (host-resolved; render→domain). */
export interface KnifeBatchInput {
  /** The current knife session state (domain truth lives in the UI store). */
  readonly state: KnifeState;
  /**
   * The selected target leaf's resolved geometry (host resolves it via U08 from the
   * domain; render→domain import is allowed). `undefined` while no target is chosen.
   */
  readonly targetShape: GeoMultiPolygon | undefined;
  /** The camera zoom (CSS px per degree) — the ONLY transform input the circle needs. */
  readonly zoom: number;
}

/**
 * Build the full knife provisional batch from the session state, back-to-front:
 * map-wide overlay, target emphasis, cut-line polyline (+ closing edge), the
 * screen-fixed circle, then the cut-point markers on top. An inactive / idle state
 * yields `[]` — a real, valid empty frame (教訓 5.18), so the overlay / circle /
 * preview vanish on every reset path (教訓 5.2) with no clearing code. All sizes are
 * screen-fixed (FR-17); U17 transforms / seam-replicates (FR-07).
 */
export function buildKnifePrimitives(
  input: KnifeBatchInput,
  style: KnifeStyle = DEFAULT_KNIFE_STYLE,
): DrawPrimitive[] {
  const { state, targetShape, zoom } = input;
  if (state.phase === KNIFE_PHASE.Inactive) return [];

  const out: DrawPrimitive[] = [];

  // 1. Map-wide overlay (only while selecting / drawing — FR-90).
  if (isOverlayVisible(state)) {
    out.push(overlayPrimitive(style));
  }

  // 2. Target emphasis (over the overlay).
  const target = targetPrimitive(targetShape, style);
  if (target !== undefined) out.push(target);

  // 3/4/5. Cut-line preview + fixed circle + markers (only while drawing).
  if (state.phase === KNIFE_PHASE.DrawingCut) {
    const points = state.line.points;
    out.push(
      ...cutLinePrimitives(points, state.line.kind === KNIFE_LINE_KIND.Closed, style),
    );
    if (isFixedCircleVisible(state)) {
      const center = points[0];
      if (center !== undefined) {
        const circle = fixedCirclePrimitive(center, zoom, style);
        if (circle !== undefined) out.push(circle);
      }
    }
    out.push(...markerPrimitives(points, style));
  }

  return out;
}
