// U22 selection — visual-feedback CLASSIFICATION (FR-82, 教訓 5.29).
//
// Drawing is U19's job; THIS unit decides, with one resolution判定, which
// element falls into which selection category so draw / hit-test / selection all
// read the same classification and never drift (教訓 5.29). The four categories
// are distinct values (受け入れ基準 6) and can all hold simultaneously:
//
//   - ActiveFeature  : the active feature → thick cyan outline + cyan fill.
//   - ContextFeature : the (non-active) single-owner context feature → dashed
//                      outline (the auxiliary highlight when there is no active
//                      feature, FR-82).
//   - SelectedVertex : a vertex in the selection set (not currently dragging).
//   - DraggingVertex : a selected vertex currently being moved (a further-
//                      distinguished style, FR-82).
//
// A vertex that is both selected AND dragging classifies as DraggingVertex
// (the more specific category wins). The classification is a derived value; U19
// maps each category to its concrete style. The unit does NOT decide colors —
// only categories — and never paints holes or special-cases enclaves (FR-21):
// it classifies feature/vertex IDENTITIES, leaving ring/hole geometry to U19.
//
// NOTE (FR-110 cap wiring): this classifier is currently NOT connected to the
// renderer (no production consumer feeds its FR-79 markers into a draw path yet;
// it is retained for future wiring). The LIVE FR-110 vertexMarkerCap gate is
// applied on the handle path — `ui/map/active-feature-handles.ts`
// (buildActiveFeatureHandlePrimitives) — which is the path that actually draws the
// active feature's per-vertex handles today. The `cap` field on {@link MarkerInput}
// below intentionally mirrors that gate so the two stay consistent when this
// classifier is eventually wired (not double-applied — only one path draws).
//
// NOTE (FR-80/82 selected/dragging wiring): the SelectedVertex / DraggingVertex
// distinction IS live on screen, but it is applied on that same handle path — the
// store hands `selection.vertexIds` + `selection.vertexOwner` (FR-81: the ring is
// applied only to the OWNER's handles, since a vertex id is a global key and a
// 共有頂点 is cited by several features) to `buildActiveFeatureHandlePrimitives`,
// which maps them to an outer highlight RING via `render/edit-handles-layer`. Until
// this classifier is wired, that path is the ONE place the vertex highlight is
// decided (never both — 二重実装禁止), and it deliberately reuses the SAME precedence
// declared here (Dragging > Selected > none) so the two can never disagree when they
// do converge. The cap exemption below holds there too: the handle path keeps the
// ringed vertices when the FR-79-style full handle set is capped away.
//
// DRAGGING (FR-82): the live consumer derives「いま動いている頂点」from the in-flight
// DragSession (one vertex per gesture today), NOT from `transient.phase ===
// VertexDrag` — that transient is armed on the mere PRESS and covers the whole
// selection set, so using it would paint stationary vertices as "moving". When the
// FR-80 multi-vertex simultaneous move gets a live path, its gesture truth is what
// should feed the dragging set (and this classifier's rule below converges with it).

import type { FeatureId, VertexId } from '../ids';

import { CONTEXT_KIND, type VertexContext } from './context';
import { POINTER_PHASE, type SelectionState } from './state';

export const FEATURE_HIGHLIGHT = {
  /** Thick cyan outline + cyan fill (FR-82). */
  Active: 'active',
  /** Dashed outline; auxiliary highlight when no active feature (FR-82). */
  Context: 'context',
} as const;

export type FeatureHighlight =
  (typeof FEATURE_HIGHLIGHT)[keyof typeof FEATURE_HIGHLIGHT];

export const VERTEX_HIGHLIGHT = {
  /** Dedicated style for a selected vertex (FR-82). */
  Selected: 'selected',
  /** Further-distinguished style for a vertex being dragged (FR-82). */
  Dragging: 'dragging',
  /**
   * A half-transparent marker for an active feature's vertex that is NOT in the
   * selection set (FR-79: the active feature shows ALL its vertices as
   * half-transparent markers). U19 renders this distinctly from Selected.
   */
  Marker: 'marker',
} as const;

export type VertexHighlight =
  (typeof VERTEX_HIGHLIGHT)[keyof typeof VERTEX_HIGHLIGHT];

/**
 * The derived visual classification (FR-82). Feature highlights keyed by ID,
 * vertex highlights keyed by ID. A consumer (U19) iterates these to style each
 * element; absence from a map means "no selection styling" (教訓 5.18: the maps
 * are the truth, not a falsy flag).
 */
export interface VisualClassification {
  readonly features: ReadonlyMap<FeatureId, FeatureHighlight>;
  readonly vertices: ReadonlyMap<VertexId, VertexHighlight>;
}

/**
 * Input the marker supply needs: the set of ALL vertices an active feature owns
 * (FR-79 half-transparent markers). The selection unit does not own feature
 * geometry, so the active feature's full vertex list is supplied by the caller
 * (single source = U24/U03 feature store). When the active feature is `null` or
 * its vertex list is empty, no markers are produced.
 */
export interface MarkerInput {
  /** Every vertex of the active feature (FR-79 全頂点を半透明マーカー). */
  readonly activeFeatureVertexIds: ReadonlySet<VertexId>;
  /**
   * FR-110 表示上限: the active feature's full-vertex markers are a PERFORMANCE
   * guard — when the active feature owns MORE than `cap` vertices, the FR-79
   * markers are suppressed WHOLESALE (a threshold, not a slice: we never show a
   * leading N — either all markers or none). `cap === 0` therefore means "show
   * none". Omitting the field (or `undefined`) leaves markers unlimited (the
   * caller supplies `appSettings.vertexMarkerCap`, single source = U16). The cap
   * gates ONLY these FR-79 markers; selected / dragging vertices are a separate
   * edit/selection path and are always styled regardless of the cap.
   */
  readonly cap?: number;
}

const NO_MARKERS: MarkerInput = {
  activeFeatureVertexIds: new Set<VertexId>(),
};

/**
 * Classify every styled element into one of the four FR-82 categories (plus the
 * FR-79 marker). ONE resolution判定 used by draw / hit-test / selection so they
 * cannot drift (教訓 5.29). The category precedence for a vertex is:
 * Dragging > Selected > Marker — the most specific wins, so a dragged vertex is
 * never shown as a plain marker.
 */
export function classifyVisual(
  state: SelectionState,
  context: VertexContext,
  markers: MarkerInput = NO_MARKERS,
): VisualClassification {
  const features = new Map<FeatureId, FeatureHighlight>();
  const vertices = new Map<VertexId, VertexHighlight>();

  // Feature highlights ------------------------------------------------------
  // Active feature: thick cyan + fill (FR-82). Highest priority.
  if (state.activeFeature !== null) {
    features.set(state.activeFeature, FEATURE_HIGHLIGHT.Active);
  } else if (context.kind === CONTEXT_KIND.Single) {
    // Context feature highlight is auxiliary: only shown when NO active feature
    // (FR-82). It never overrides an active highlight for the same feature.
    features.set(context.ownerFeatureId, FEATURE_HIGHLIGHT.Context);
  }

  // Vertex markers (FR-79): the active feature's full vertex set, half-
  // transparent. Laid down first so selected/dragging override them. FR-110
  // 表示上限 is a WHOLESALE threshold — when the full-vertex count exceeds `cap`
  // (or cap === 0) we produce NO markers at all (perf guard, never a partial
  // slice). An undefined cap means unlimited. Selected/dragging are handled
  // below and are NOT gated by the cap (別経路: edit/selection highlight).
  if (markers.cap === undefined || markers.activeFeatureVertexIds.size <= markers.cap) {
    for (const vid of markers.activeFeatureVertexIds) {
      vertices.set(vid, VERTEX_HIGHLIGHT.Marker);
    }
  }

  // Selected vertices: dedicated style (FR-82). Overrides Marker.
  for (const vid of state.vertexIds) {
    vertices.set(vid, VERTEX_HIGHLIGHT.Selected);
  }

  // Dragging vertices: the whole selection set is dragging during a VertexDrag
  // (the simultaneous move applies to all selected vertices). Overrides Selected.
  if (state.transient.phase === POINTER_PHASE.VertexDrag) {
    for (const vid of state.vertexIds) {
      vertices.set(vid, VERTEX_HIGHLIGHT.Dragging);
    }
  }

  return { features, vertices };
}
