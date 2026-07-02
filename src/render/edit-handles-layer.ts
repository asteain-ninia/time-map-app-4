// U24 → render: the EDIT HANDLES drawing layer (FR-87 / FR-17, HB3-9).
//
// WHY THIS FILE EXISTS (the missing render接続 — HB3-9):
// `domain/editing/handles.computeHandles` resolves, for a selected feature, one
// VERTEX handle per vertex (move / delete target) and one EDGE handle per edge
// midpoint (add-a-new-vertex target), all in WORLD coordinates (FR-87). That output
// was a DEAD value: its only consumer was the unit test — the render pipeline
// (feature-layer / canvas2d-renderer / map-renderer) had NO consumer at all, so a
// user who selected a feature in 編集 mode saw NO handles and could not see what to
// grab (診断 HB3-9 / 教訓 5.7「ロジックはあるが UI から呼ばれない」). This module is the
// ONE place that turns the domain `EditHandles` (world coords) into declarative
// {@link HandlePrimitive}s for the `MapRenderer`, applying the FR-17 SCREEN-FIXED
// constant size at the render boundary (handles.ts is pure domain and intentionally
// computes NO screen coordinates — that responsibility lives here).
//
// LAYER (技術方針 2.13): render, depends inward on `domain/editing`. There is NO
// Canvas API here — the actual painting (filled disc for a vertex, hollow square for
// an edge) lives in `canvas2d-renderer.drawHandle`; this module only decides WHAT to
// draw (受け入れ基準 6 vitest-checkable without a Canvas).
//
// PER-FRAME EVALUATION (HB3-9 / 教訓 5.5): the composition root calls this on EVERY
// composed frame for the active feature, so the handles re-project against the live
// camera and stay at a constant on-screen size while the feature's fill scales with
// zoom (FR-17). The size is carried as a SCREEN-FIXED CSS-px radius (NOT multiplied
// by `camera.zoom`), exactly like a point marker (教訓 5.30 単一サイズ源).
//
// PURITY: builds and returns a fresh array; the input handle set is never mutated.

import type { EditHandles } from '../domain/editing/handles';
import type { VertexId } from '../domain/ids';

import type { DrawPrimitive, HandlePrimitive } from './map-renderer';

/**
 * The screen-fixed visual size + colors of the edit handles (FR-17 / FR-87). Sizes
 * are CSS px (never zoomed). Kept here as a single style source so a vertex handle, an
 * edge handle and their outline can never invent divergent sizes (教訓 5.30).
 */
export interface EditHandleStyle {
  /** Vertex-handle (filled disc) radius in CSS px (FR-17). */
  readonly vertexRadiusPx: number;
  /** Edge-handle (hollow square) half-size in CSS px (FR-17). */
  readonly edgeRadiusPx: number;
  /** Outline width in CSS px (screen-fixed, FR-17). */
  readonly strokeWidthPx: number;
  /** Vertex-handle fill color. */
  readonly vertexFill: string;
  /**
   * Fill color for a SHARED vertex handle (FR-30): a vertex cited by ≥2 distinct
   * shape references (two features / two rings) so the user can tell — at a glance —
   * which vertices move OTHER features when dragged. A distinct hue from `vertexFill`
   * (normal) and from any selection / drag highlight so the three never collide.
   */
  readonly sharedVertexFill: string;
  /** Edge-handle fill color (distinct so add-vertex reads differently from move). */
  readonly edgeFill: string;
  /** Handle outline color (reads on any base / feature color). */
  readonly stroke: string;
}

/**
 * The default handle style (FR-87): a bright, high-contrast disc for vertices and a
 * lighter square for edge midpoints, both outlined so they stand out over the
 * selected feature's highlight fill. Sizes are slightly larger than a feature point
 * marker so a handle is the obvious grab target (受け入れ基準 1).
 */
export const DEFAULT_EDIT_HANDLE_STYLE: EditHandleStyle = {
  vertexRadiusPx: 5,
  edgeRadiusPx: 3.5,
  strokeWidthPx: 1.5,
  vertexFill: '#ffffff',
  // FR-30: a warm amber that is distinct from the white normal vertex fill, the
  // light-blue edge fill (#bde3ff) and the blue outline (#0a66c2) — and clear of
  // the drag / selection highlight hues so a shared vertex never reads as selected.
  sharedVertexFill: '#ffd54a',
  edgeFill: '#bde3ff',
  stroke: '#0a66c2',
};

/**
 * Build the declarative handle primitives for ONE feature's resolved {@link EditHandles}
 * (HB3-9 / FR-87). Every {@link VertexHandle} becomes a `handle` primitive of
 * `handleKind: 'vertex'` at `position`; every {@link EdgeHandle} becomes one of
 * `handleKind: 'edge'` at `midpoint`. The world coordinates pass through verbatim (the
 * renderer projects them against the live camera each frame, FR-17); the SIZE is the
 * screen-fixed style above, applied here at the render boundary (handles.ts computes no
 * screen coords). Vertices are emitted AFTER edges so a vertex handle draws ON TOP of an
 * adjacent edge handle (the move target wins the overlap, 教訓 5.14 描画順). Pure: a
 * fresh array; the input is never mutated. An empty handle set yields an empty array
 * (受け入れ基準: 非存在は描画指示に現れない, 教訓 5.18).
 *
 * FR-30 共有頂点の視覚区別: `sharedVertexIds` is the set of vertex ids that are SHARED
 * (cited by ≥2 distinct shape references — derived by the caller via the domain
 * `shared-vertex` reverse index). A vertex handle whose `vertexId` is in that set is
 * filled with `style.sharedVertexFill` instead of `style.vertexFill`, so the user can
 * tell — at a glance — which vertices move other features when dragged. The handle KIND
 * stays `'vertex'` (still a move / delete target); only the fill differs. Omitting the
 * set (or an empty set) draws every vertex with the normal fill (no sharing known).
 */
export function buildEditHandlePrimitives(
  handles: EditHandles,
  style: EditHandleStyle = DEFAULT_EDIT_HANDLE_STYLE,
  sharedVertexIds?: ReadonlySet<VertexId>,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  // Edge (add-vertex) handles first, then vertices on top of them.
  for (const edge of handles.edges) {
    out.push({
      kind: 'handle',
      at: { lon: edge.midpoint.lon, lat: edge.midpoint.lat },
      radiusPx: style.edgeRadiusPx,
      fill: style.edgeFill,
      stroke: style.stroke,
      strokeWidthPx: style.strokeWidthPx,
      handleKind: 'edge',
    } satisfies HandlePrimitive);
  }
  for (const vertex of handles.vertices) {
    // FR-30: a shared vertex gets the distinct sharedVertexFill; others the normal fill.
    const shared = sharedVertexIds !== undefined && sharedVertexIds.has(vertex.vertexId);
    out.push({
      kind: 'handle',
      at: { lon: vertex.position.lon, lat: vertex.position.lat },
      radiusPx: style.vertexRadiusPx,
      fill: shared ? style.sharedVertexFill : style.vertexFill,
      stroke: style.stroke,
      strokeWidthPx: style.strokeWidthPx,
      handleKind: 'vertex',
    } satisfies HandlePrimitive);
  }
  return out;
}
