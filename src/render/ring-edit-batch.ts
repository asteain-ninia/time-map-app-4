// U25 — ring-edit (hole / enclave add) render-batch builder (FR-22 仮表示 /
// クロージング線半透明 / FR-17 一定サイズ, 教訓 5.18 / 5.25 / 5.29).
//
// Render layer: turns the pure ring-add draft (domain {@link RingAddDraft}) into a
// declarative list of `DrawPrimitive`s for the MapRenderer (U17). It owns NO Canvas
// API and NO ±360° / world↔screen math — it only describes WHAT to draw in WORLD
// coordinates with SCREEN-fixed sizes (FR-17); U17 transforms positions,
// wrap-replicates across the seam (FR-07) and keeps marker / line sizes constant.
//
// Mirrors {@link buildAddPrimitives} (add-batch.ts) exactly — placed edges, the
// translucent closing line (drawn only once ≥3 vertices via {@link canConfirm}),
// the cursor-follow preview edge/marker, then the placed-vertex markers on top —
// but drives on a {@link RingAddDraft} instead of an AddSession, and switches the
// accent COLOUR by the auto-classified {@link RingAddMode} (hole vs enclave) so the
// two 対概念 modes read differently on the map (教訓 2.10). A `null` draft yields
// `[]` — a real, valid empty frame (教訓 5.18) — so the overlay clears itself on
// every reset path with no clearing code.

import type { WorldCoordinate } from '../domain/coordinate';
import {
  RING_ADD_MODE,
  canConfirm,
  type RingAddDraft,
  type RingAddMode,
} from '../domain/ring-edit/index';

import type { DrawPrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Provisional visual style (the single place ring-edit colours / sizes live) --
//
// FR-17: marker radius and stroke widths are SCREEN-fixed px declared once here;
// U17 keeps them constant under zoom. The provisional style is deliberately
// distinct from confirmed features (FR-78 仮スタイル), and the accent colour differs
// per mode so a HOLE (穴) draft reads apart from an ENCLAVE (飛び地) draft. The
// closing line uses a translucent stroke (spec §クロージング線半透明).

export interface RingEditStyle {
  /** Hole-mode accent (edges + placed markers). */
  readonly holeStroke: string;
  /** Enclave-mode accent (edges + placed markers). */
  readonly enclaveStroke: string;
  /** Cursor-follow preview marker fill (the live hover point). */
  readonly previewMarkerFill: string;
  readonly edgeWidthPx: number;
  readonly previewWidthPx: number;
  readonly closingWidthPx: number;
  readonly markerRadiusPx: number;
}

/** Default provisional ring-edit style (overridable; e.g. project theme). */
export const DEFAULT_RING_EDIT_STYLE: RingEditStyle = {
  holeStroke: '#6a1b9a',
  enclaveStroke: '#00838f',
  previewMarkerFill: '#ffb300',
  edgeWidthPx: 2,
  previewWidthPx: 1.5,
  closingWidthPx: 1.5,
  markerRadiusPx: 5,
};

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

/**
 * The accent stroke for the draft's mode. Before the first click the mode is null
 * (undecided) — we fall back to the enclave accent so the first placed vertex still
 * draws (the first click freezes the mode; 教訓 5.18 the undecided state is explicit).
 */
function accentStroke(mode: RingAddMode | null, style: RingEditStyle): string {
  return mode === RING_ADD_MODE.Hole ? style.holeStroke : style.enclaveStroke;
}

/**
 * A translucent copy of an accent stroke for the closing line (spec §クロージング線
 * 半透明). Kept as one derivation so hole / enclave closing lines match their edges.
 */
function translucent(stroke: string): string {
  return `${stroke}66`; // 8-bit hex alpha ≈ 0.4 — visually distinct half-open ring.
}

// --- Per-part builders (mirror add-batch.ts) --------------------------------

/** Markers for every placed vertex (provisional style, mode accent). */
function markerPrimitives(draft: RingAddDraft, style: RingEditStyle): DrawPrimitive[] {
  const fill = accentStroke(draft.mode, style);
  return draft.vertices.map((c) => ({
    kind: 'point',
    at: toWorldPoint(c),
    radiusPx: style.markerRadiusPx,
    fill,
  }));
}

/** The polyline through the placed vertices in order (≥2 vertices). */
function placedEdgePrimitives(draft: RingAddDraft, style: RingEditStyle): DrawPrimitive[] {
  if (draft.vertices.length < 2) return [];
  return [
    {
      kind: 'line',
      points: draft.vertices.map(toWorldPoint),
      widthPx: style.edgeWidthPx,
      stroke: accentStroke(draft.mode, style),
    },
  ];
}

/**
 * The cursor-follow preview edge from the last placed vertex to the current preview
 * point + a preview marker. Drawn only when there is at least one placed vertex AND
 * a preview point (教訓 5.18: "placed, no hover yet" draws no edge).
 */
function previewPrimitives(draft: RingAddDraft, style: RingEditStyle): DrawPrimitive[] {
  if (draft.preview === null) return [];
  const last = draft.vertices[draft.vertices.length - 1];
  const out: DrawPrimitive[] = [];
  if (last !== undefined) {
    out.push({
      kind: 'line',
      points: [toWorldPoint(last), toWorldPoint(draft.preview)],
      widthPx: style.previewWidthPx,
      stroke: accentStroke(draft.mode, style),
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
 * §クロージング線半透明). Drawn only once the ring is closable (≥3 vertices via
 * {@link canConfirm}) so the closing edge is a real edge, not a degenerate loop on
 * 1–2 points (教訓 5.18).
 */
function closingPrimitives(draft: RingAddDraft, style: RingEditStyle): DrawPrimitive[] {
  if (!canConfirm(draft)) return [];
  const first = draft.vertices[0];
  const last = draft.vertices[draft.vertices.length - 1];
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'line',
      points: [toWorldPoint(last), toWorldPoint(first)],
      widthPx: style.closingWidthPx,
      stroke: translucent(accentStroke(draft.mode, style)),
    },
  ];
}

// --- Whole-draft batch ------------------------------------------------------

/**
 * Build the full provisional ring-edit primitive list from the draft, back-to-front:
 * placed edges, then the translucent closing line, then the cursor preview
 * edge/marker, then the placed-vertex markers on top. A `null` draft (no ring-add in
 * progress) yields `[]` — a real, valid empty frame (教訓 5.18), never skipped by a
 * falsy short-circuit. All sizes are screen-fixed (FR-17); U17 transforms /
 * seam-replicates (FR-07).
 */
export function buildRingEditPrimitives(
  draft: RingAddDraft | null,
  style: RingEditStyle = DEFAULT_RING_EDIT_STYLE,
): DrawPrimitive[] {
  if (draft === null) return [];
  return [
    ...placedEdgePrimitives(draft, style),
    ...closingPrimitives(draft, style),
    ...previewPrimitives(draft, style),
    ...markerPrimitives(draft, style),
  ];
}
