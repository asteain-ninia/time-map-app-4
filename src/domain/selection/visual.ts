// U22 selection — visual-feedback CLASSIFICATION (FR-82, 教訓 5.29).
//
// Drawing is U19's job; THIS unit decides, with one resolution判定, which
// element falls into which selection category so draw / hit-test / selection all
// read the same classification and never drift (教訓 5.29). The four categories
// are distinct values (受け入れ基準 6) and can all hold simultaneously:
//
//   - ActiveFeature  : the active feature → thick cyan outline + cyan fill.
//   - ContextFeature : the (non-active) single-owner context feature → dashed
//                      outline (FR-82). It is INDEPENDENT of the active feature:
//                      it stands whenever the vertex-selection owner is not the
//                      active feature — including while another feature IS active
//                      (see {@link classifyFeatures} for the rule and why the older
//                      「アクティブ地物が無いときだけ」reading was wrong).
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
// WIRED (FR-82 点線アウトライン): the FEATURE half of this classification IS now a live
// render input. `classifyFeatureHighlights` (below) is the entry point the handle/outline
// layer (`ui/map/active-feature-handles`) calls every frame to ask WHICH feature gets the
// dashed 頂点選択コンテキスト outline; the answer comes from `classifyVisual` itself, so
// the drawn outline and the classification cannot drift (教訓 5.29). The VERTEX half
// (Marker/Selected/Dragging) is still applied on the handle path — see the two notes below.
//
// NOTE (FR-110 cap wiring): the FR-79 MARKER half of this classifier still has no
// production consumer (no draw path feeds `MarkerInput` yet; retained for future
// wiring). The LIVE FR-110 vertexMarkerCap gate is
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

import { CONTEXT_KIND, EMPTY_CONTEXT, type VertexContext } from './context';
import { POINTER_PHASE, type SelectionState } from './state';

export const FEATURE_HIGHLIGHT = {
  /** Thick cyan outline + cyan fill (FR-82). */
  Active: 'active',
  /**
   * Dashed outline for the 頂点選択コンテキスト地物 (FR-82) — the feature that OWNS the
   * vertex selection while not being the active feature. NOT conditional on the absence
   * of an active feature (see {@link classifyFeatures}).
   */
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
  const features = classifyFeatures(state.activeFeature, context);
  const vertices = new Map<VertexId, VertexHighlight>();

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

/**
 * The FEATURE half of the classification — the ONE place the FR-82 feature rule lives.
 * Both {@link classifyVisual} and {@link classifyFeatureHighlights} funnel through it, so
 * the draw path and the full classification can never disagree (教訓 5.29 二重実装禁止).
 *
 * Active feature → thick cyan outline + fill; 頂点選択コンテキスト地物 → dashed outline.
 * The two states are SEPARATE in FR-82 (it lists them side by side, not as alternatives)
 * and genuinely co-occur: U22's HIT_KIND.Vertex branch does not promote the owner to
 * activeFeature, so「A がアクティブ・B の頂点を掴んでいる」is a reachable state and the
 * handle layer already draws B's handles there. The ONE composition rule is that ACTIVE
 * WINS for the SAME feature (選択スタイル優先, never overlaid): a feature that is both
 * active and the vertex-selection owner reads as Active only, so a dashed outline always
 * means exactly「アクティブ地物ではない、頂点選択の所有地物」.
 *
 * DO NOT restore the older「Context はアクティブ地物が無いときだけ」rule (敵対レビュー LOW
 * が記録した仕様変更). 要件定義書 FR-82 enumerates 「アクティブ地物は太いシアン…、頂点選択
 * コンテキスト地物は点線アウトライン、選択済み頂点とドラッグ中頂点を別スタイルで区別」as
 * PARALLEL states and never makes the dashed outline conditional on there being no active
 * feature; the narrower rule was an implementation-local reading that made the reachable
 * 「A がアクティブ・B の頂点を選択」frame (FR-30 共有頂点の常態) draw B as nothing at all.
 * The only composition rule is ACTIVE-wins-per-feature, above.
 */
function classifyFeatures(
  activeFeature: FeatureId | null,
  context: VertexContext,
): Map<FeatureId, FeatureHighlight> {
  const features = new Map<FeatureId, FeatureHighlight>();
  if (activeFeature !== null) {
    features.set(activeFeature, FEATURE_HIGHLIGHT.Active);
  }
  if (context.kind === CONTEXT_KIND.Single && context.ownerFeatureId !== activeFeature) {
    features.set(context.ownerFeatureId, FEATURE_HIGHLIGHT.Context);
  }
  return features;
}

/**
 * The selection triple a DRAW consumer actually holds. The render / handle path keeps the
 * selection as `(activeFeature, vertexOwner, vertexIds)` — the exact three fields the store
 * exposes — not as a `SelectionState` + a resolved {@link VertexContext}. This is the shape
 * {@link classifyFeatureHighlights} accepts.
 */
export interface FeatureHighlightInput {
  /** The active feature (FR-79), or null. */
  readonly activeFeature: FeatureId | null;
  /** `selection.vertexOwner` — the single owner of the vertex set (FR-81), or null. */
  readonly vertexOwner: FeatureId | null;
  /** `selection.vertexIds` — the selected vertices (FR-80). */
  readonly vertexIds: ReadonlySet<VertexId>;
}

/**
 * The FEATURE-level FR-82 highlights for the draw path (アクティブ地物 / 頂点選択コンテキスト
 * 地物). This is the wiring entry point that turned {@link classifyVisual} from a classifier
 * with ZERO render consumers (教訓 5.7 ロジックはあるが UI から呼ばれない) into the single
 * source the outline drawing reads.
 *
 * It does NOT re-decide anything: it lifts the caller's triple into a {@link VertexContext}
 * and returns {@link classifyFeatures} — the SAME function `classifyVisual` uses for its
 * feature half — so the「どの地物が点線か」rule exists exactly once (教訓 5.29 二重実装禁止).
 * `vertexOwner` with a non-empty set IS the FR-81 Single context by construction: the store
 * maintains that invariant (`withVertexSet`: owner non-null iff the set is non-empty) and
 * the owner it holds was itself produced by `analyzeVertexContext`, so no second ownership
 * analysis (and no vertex→owner lookup) is needed or performed here.
 *
 * It deliberately does NOT go through `classifyVisual`'s VERTEX half: this runs on EVERY
 * composed frame, and the vertex maps are O(selection set) work whose result the draw path
 * here would throw away (a rectangle selection can hold thousands of ids, and unlike the
 * handle set that work is not under the FR-110 cap).
 */
export function classifyFeatureHighlights(
  input: FeatureHighlightInput,
): ReadonlyMap<FeatureId, FeatureHighlight> {
  const context: VertexContext =
    input.vertexOwner === null || input.vertexIds.size === 0
      ? EMPTY_CONTEXT
      : {
          kind: CONTEXT_KIND.Single,
          ownerFeatureId: input.vertexOwner,
          vertexIds: input.vertexIds,
        };
  return classifyFeatures(input.activeFeature, context);
}
