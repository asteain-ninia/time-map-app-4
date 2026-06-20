// U23 — add-session render-batch builder (FR-78 仮表示 / クロージング線半透明 /
// FR-17 一定サイズ, 教訓 5.18 / 5.25 / 5.29).
//
// Render layer: turns the pure add-session state (domain) into a declarative
// list of `DrawPrimitive`s for the MapRenderer (U17). It owns NO Canvas API and
// NO ±360° / world↔screen math — it only describes WHAT to draw in WORLD
// coordinates with SCREEN-fixed sizes (FR-17); U17 transforms positions,
// wrap-replicates across the seam (FR-07) and keeps marker / line sizes constant.
//
// The provisional add visuals are drawn in a style VISUALLY DISTINCT from
// confirmed features (spec §仮スタイル, FR-78): a dashed/accent stroke and accent
// markers declared once here. For a FACE add, the CLOSING line (last vertex back
// to the start) is drawn TRANSLUCENT (spec §クロージング線半透明) and only once a
// ring is closable (≥3 vertices) — 教訓 5.18 (drawn only when the closing edge is
// a real edge, not a degenerate self-loop). The render layer subscribes to the
// session state directly so the 60FPS draw path never rides a React re-render
// (技術方針 2.3 / 2.5).
//
// 教訓 5.25: the provisional preview edge (cursor-follow) is drawn for line / face
// only — a point has no edge — and a face's closing line is NOT widened to lines
// / points (a line has no closing edge by definition).

import {
  ADD_TOOL_KIND,
  canConfirm,
  type AddSession,
  type PlacedVertex,
} from '../domain/add/index';
import type { WorldCoordinate } from '../domain/coordinate';

import type { DrawPrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Provisional visual style (the single place add colours / sizes live) ----
//
// FR-17: marker radius and stroke widths are SCREEN-fixed px declared once here;
// U17 keeps them constant under zoom. The provisional style is deliberately
// distinct from confirmed features (FR-78 仮スタイル). The closing line uses a
// translucent stroke (spec §クロージング線半透明).

export interface AddStyle {
  /** Provisional edge stroke (placed edges + cursor preview), distinct accent. */
  readonly edgeStroke: string;
  /** Provisional vertex marker fill. */
  readonly markerFill: string;
  /** Cursor-follow preview marker fill (the live hover point). */
  readonly previewMarkerFill: string;
  /** Translucent closing-line stroke for a face (spec §クロージング線半透明). */
  readonly closingStroke: string;
  readonly edgeWidthPx: number;
  readonly previewWidthPx: number;
  readonly closingWidthPx: number;
  readonly markerRadiusPx: number;
}

/** Default provisional add style (overridable; e.g. project theme). */
export const DEFAULT_ADD_STYLE: AddStyle = {
  edgeStroke: '#e65100',
  markerFill: '#e65100',
  previewMarkerFill: '#ff9800',
  // rgba alpha < 1 ⇒ the closing line is半透明 (spec §FR-78).
  closingStroke: 'rgba(230, 81, 0, 0.4)',
  edgeWidthPx: 2,
  previewWidthPx: 1.5,
  closingWidthPx: 1.5,
  markerRadiusPx: 5,
};

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

function placedToWorldPoints(vertices: readonly PlacedVertex[]): WorldPoint[] {
  return vertices.map((v) => toWorldPoint(v.coordinate));
}

// --- Per-part builders ------------------------------------------------------

/** Markers for every placed vertex (provisional style). */
function markerPrimitives(
  vertices: readonly PlacedVertex[],
  style: AddStyle,
): DrawPrimitive[] {
  return vertices.map((v) => ({
    kind: 'point',
    at: toWorldPoint(v.coordinate),
    radiusPx: style.markerRadiusPx,
    fill: style.markerFill,
  }));
}

/** The polyline through the placed vertices in order (≥2 vertices). */
function placedEdgePrimitives(
  vertices: readonly PlacedVertex[],
  style: AddStyle,
): DrawPrimitive[] {
  if (vertices.length < 2) return [];
  return [
    {
      kind: 'line',
      points: placedToWorldPoints(vertices),
      widthPx: style.edgeWidthPx,
      stroke: style.edgeStroke,
    },
  ];
}

/**
 * The cursor-follow preview edge from the last placed vertex to the current
 * preview point + a preview marker (line / face only; 教訓 5.25 point has no
 * edge). Drawn only when there is at least one placed vertex AND a preview point
 * (教訓 5.18: "placed, no hover yet" is a valid intermediate that draws no edge).
 */
function previewPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  if (session.tool === ADD_TOOL_KIND.Point) return [];
  if (session.preview === null) return [];
  const last = session.vertices[session.vertices.length - 1];
  const out: DrawPrimitive[] = [];
  if (last !== undefined) {
    out.push({
      kind: 'line',
      points: [toWorldPoint(last.coordinate), toWorldPoint(session.preview)],
      widthPx: style.previewWidthPx,
      stroke: style.edgeStroke,
    });
  }
  out.push({
    kind: 'point',
    at: toWorldPoint(session.preview),
    radiusPx: style.markerRadiusPx,
    fill: style.previewMarkerFill,
  });
  return out;
}

/**
 * The TRANSLUCENT closing line from the last placed vertex back to the first
 * (face only; spec §クロージング線半透明). Drawn only once the ring is closable
 * (≥3 vertices via {@link canConfirm}) so the closing edge is a real edge, not a
 * degenerate loop on 1–2 points (教訓 5.18).
 */
function closingPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  if (session.tool !== ADD_TOOL_KIND.Face) return [];
  if (!canConfirm(session)) return [];
  const first = session.vertices[0];
  const last = session.vertices[session.vertices.length - 1];
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'line',
      points: [toWorldPoint(last.coordinate), toWorldPoint(first.coordinate)],
      widthPx: style.closingWidthPx,
      stroke: style.closingStroke,
    },
  ];
}

// --- Whole-session batch ----------------------------------------------------

/**
 * Build the full provisional add primitive list from the session, back-to-front:
 * placed edges, then the translucent closing line (face), then the cursor preview
 * edge/marker, then the placed-vertex markers on top. A `null` session (no add in
 * progress) yields `[]` — a real, valid empty frame (教訓 5.18), never skipped by
 * a falsy short-circuit. All sizes are screen-fixed (FR-17); U17 transforms /
 * seam-replicates (FR-07).
 */
export function buildAddPrimitives(
  session: AddSession | null,
  style: AddStyle = DEFAULT_ADD_STYLE,
): DrawPrimitive[] {
  if (session === null) return [];
  return [
    ...placedEdgePrimitives(session.vertices, style),
    ...closingPrimitives(session, style),
    ...previewPrimitives(session, style),
    ...markerPrimitives(session.vertices, style),
  ];
}
