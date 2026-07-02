// U27 — drill (穴あけによる新地物生成) region render-batch builder (FR-45 仮表示 /
// クロージング線半透明 / FR-17 一定サイズ, 教訓 5.18 / 5.25 / 5.29).
//
// Render layer: turns the provisional drill region (a plain ordered vertex list +
// an optional cursor-follow preview point) into a declarative list of `DrawPrimitive`s
// for the MapRenderer (U17). It owns NO Canvas API and NO ±360° / world↔screen math —
// it only describes WHAT to draw in WORLD coordinates with SCREEN-fixed sizes (FR-17);
// U17 transforms positions, wrap-replicates across the seam (FR-07) and keeps marker /
// line sizes constant.
//
// Mirrors {@link buildRingEditPrimitives} (ring-edit-batch.ts) exactly — placed edges,
// the translucent closing line (drawn only once ≥3 vertices), the cursor-follow preview
// edge/marker, then the placed-vertex markers on top — but drives on a plain region
// array (drill has no auto-classified hole/enclave mode; the carved region is always a
// single territory piece). An EMPTY region yields `[]` — a real, valid empty frame
// (教訓 5.18) — so the overlay self-clears on every reset path with no clearing code.

import type { WorldCoordinate } from '../domain/coordinate';

import type { DrawPrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Provisional visual style (the single place drill colours / sizes live) --
//
// FR-17: marker radius and stroke widths are SCREEN-fixed px declared once here; U17
// keeps them constant under zoom. The provisional style is deliberately distinct from
// confirmed features (FR-78 仮スタイル); the closing line uses a translucent stroke
// (spec §クロージング線半透明).

export interface DrillStyle {
  /** Region accent (edges + placed markers). */
  readonly regionStroke: string;
  /** Cursor-follow preview marker fill (the live hover point). */
  readonly previewMarkerFill: string;
  readonly edgeWidthPx: number;
  readonly previewWidthPx: number;
  readonly closingWidthPx: number;
  readonly markerRadiusPx: number;
}

/** Default provisional drill style (overridable; e.g. project theme). */
export const DEFAULT_DRILL_STYLE: DrillStyle = {
  regionStroke: '#c62828',
  previewMarkerFill: '#ffb300',
  edgeWidthPx: 2,
  previewWidthPx: 1.5,
  closingWidthPx: 1.5,
  markerRadiusPx: 5,
};

/** The provisional drill draft the builder renders (region vertices + hover preview). */
export interface DrillDraft {
  readonly region: readonly WorldCoordinate[];
  readonly preview: WorldCoordinate | null;
}

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

/** A translucent copy of the accent stroke for the closing line (spec §クロージング線半透明). */
function translucent(stroke: string): string {
  return `${stroke}66`; // 8-bit hex alpha ≈ 0.4 — visually distinct half-open ring.
}

/** Markers for every placed region vertex (provisional style). */
function markerPrimitives(draft: DrillDraft, style: DrillStyle): DrawPrimitive[] {
  return draft.region.map((c) => ({
    kind: 'point',
    at: toWorldPoint(c),
    radiusPx: style.markerRadiusPx,
    fill: style.regionStroke,
  }));
}

/** The polyline through the placed region vertices in order (≥2 vertices). */
function placedEdgePrimitives(draft: DrillDraft, style: DrillStyle): DrawPrimitive[] {
  if (draft.region.length < 2) return [];
  return [
    {
      kind: 'line',
      points: draft.region.map(toWorldPoint),
      widthPx: style.edgeWidthPx,
      stroke: style.regionStroke,
    },
  ];
}

/**
 * The cursor-follow preview edge from the last placed vertex to the current preview
 * point + a preview marker. Drawn only when there is at least one placed vertex AND a
 * preview point (教訓 5.18: "placed, no hover yet" draws no edge).
 */
function previewPrimitives(draft: DrillDraft, style: DrillStyle): DrawPrimitive[] {
  if (draft.preview === null) return [];
  const last = draft.region[draft.region.length - 1];
  const out: DrawPrimitive[] = [];
  if (last !== undefined) {
    out.push({
      kind: 'line',
      points: [toWorldPoint(last), toWorldPoint(draft.preview)],
      widthPx: style.previewWidthPx,
      stroke: style.regionStroke,
    });
  }
  out.push({
    kind: 'point',
    at: toWorldPoint(draft.preview),
    radiusPx: style.markerRadiusPx,
    fill: style.previewMarkerFill,
  });
  return out;
}

/**
 * The TRANSLUCENT closing line from the last placed vertex back to the first (spec
 * §クロージング線半透明). Drawn only once the region is closable (≥3 vertices) so the
 * closing edge is a real edge, not a degenerate loop on 1–2 points (教訓 5.18).
 */
function closingPrimitives(draft: DrillDraft, style: DrillStyle): DrawPrimitive[] {
  if (draft.region.length < 3) return [];
  const first = draft.region[0];
  const last = draft.region[draft.region.length - 1];
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'line',
      points: [toWorldPoint(last), toWorldPoint(first)],
      widthPx: style.closingWidthPx,
      stroke: translucent(style.regionStroke),
    },
  ];
}

/**
 * Build the full provisional drill primitive list, back-to-front: placed edges, then
 * the translucent closing line, then the cursor preview edge/marker, then the placed
 * markers on top. An EMPTY region (no drill in progress) yields `[]` — a real, valid
 * empty frame (教訓 5.18), never skipped by a falsy short-circuit. All sizes are
 * screen-fixed (FR-17); U17 transforms / seam-replicates (FR-07).
 */
export function buildDrillPrimitives(
  draft: DrillDraft,
  style: DrillStyle = DEFAULT_DRILL_STYLE,
): DrawPrimitive[] {
  if (draft.region.length === 0) return [];
  return [
    ...placedEdgePrimitives(draft, style),
    ...closingPrimitives(draft, style),
    ...previewPrimitives(draft, style),
    ...markerPrimitives(draft, style),
  ];
}
