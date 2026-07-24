// UI layer (map): the ACTIVE-FEATURE edit-handles + live-drag PREVIEW render input
// (HB3-9 / HB3-4 / FR-87 / FR-88).
//
// WHY THIS FILE EXISTS (the missing render接続 — HB3-9 then HB3-4):
// `domain/editing/handles.computeHandles` resolves a selected feature's vertex /
// edge-midpoint handles in WORLD coordinates, but NOTHING in the render pipeline ever
// called it — the only consumer was its unit test (診断 HB3-9 / 教訓 5.7). This module
// is the ONE place that, given the live `(root, time, displayControl, activeFeature)`,
// resolves the active feature + its vertex store effective at the current time (the
// SAME single resolution the draw + hit-test share, 教訓 5.29) and runs `computeHandles`
// over it, then bridges the result into screen-fixed `HandlePrimitive`s via the render
// layer's `buildEditHandlePrimitives` (FR-17 applied at the render boundary).
//
// HB3-4 (ドラッグ中プレビュー欠落 = 確定後ジャンプ): a live drag NEVER mutates committed
// state during the gesture (教訓 5.22) — the moved geometry only exists in the transient
// {@link DragSession}. Before this, the handle layer (and the committed feature shape)
// kept drawing at the PRESS position for the whole drag, then the feature suddenly
// JUMPED to its new place on release. The fix: when a live session for the active
// feature is supplied, this module applies the session's preview to a TRANSIENT vertex
// store (via the SAME domain `move` helpers the release snapshot uses — single move-math
// source, 教訓 5.30) and draws (a) the handles AND (b) a preview OUTLINE of the moved
// geometry at the preview position, so the vertex / feature follows the cursor every
// frame and release does not jump.
//
// SINGLE TRUTH SOURCE (教訓 5.29): the feature object + vertex store come from
// `resolveDisplayFor` — the EXACT same resolution `committed-features` draws and the
// live hit-test grabs against — so a handle is positioned at the SAME world coordinate
// the renderer fills the feature's vertex at, and "drawn here ⇒ grab here" cannot drift.
//
// PER-FRAME (HB3-9 / 教訓 5.5): the composition root calls this on every composite while
// in 編集 mode with an active feature; the camera-independent handle world coords are
// memoised by resolveDisplayFor identity, and the screen-fixed projection happens in the
// renderer each frame, so the handles stay constant-size under zoom (FR-17).
//
// PURITY: builds a fresh array; inputs are never mutated.

import { computeHandles, EMPTY_HANDLES, type EditHandles } from '../../domain/editing/handles';
import {
  EDIT_TOOL,
  dragDelta,
  type DragSession,
} from '../../domain/editing/drag-session';
import { addVertexToLeafRing, addVertexToLine } from '../../domain/editing/edit-ops';
import { moveFeatureVertices, moveVertexTo } from '../../domain/editing/move';
import {
  FEATURE_KIND,
  type Feature,
} from '../../domain/feature';
import { createCoordinate } from '../../domain/coordinate';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import { unwrapRingClosed } from '../../domain/geo/seam';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { RING_KIND } from '../../domain/ring';
import type { TimePoint } from '../../domain/time/time-point';
import { createVertex, getVertex, setVertex, type VertexStore } from '../../domain/vertex';

import type { DisplayControlInput } from '../../render/display-pipeline';
import {
  buildEditHandlePrimitives,
  isRingedVertex,
  type EditHandleStyle,
  type HandleHighlightInput,
} from '../../render/edit-handles-layer';
import type {
  DrawPrimitive,
  LinePrimitive,
  PointPrimitive,
} from '../../render/map-renderer';

import { DEFAULT_FILTER_STATE, type FilterState } from '../discovery/index';

import { resolveDisplayFor, type DisplayResolution } from './display-resolution-cache';
import { isFeatureVisibleUnderFilter } from './filtered-display';
import { sharedVertexIdsFor } from './shared-vertex-derivation';

/** The screen-fixed visual style of the live-drag PREVIEW outline (HB3-4 / FR-78). */
export interface EditPreviewStyle {
  /** Preview outline stroke color (a bright dashed-look accent over the base shape). */
  readonly stroke: string;
  /** Preview outline stroke width in CSS px (screen-fixed, FR-17). */
  readonly widthPx: number;
  /** Preview point-marker radius in CSS px (for a point feature, FR-17). */
  readonly pointRadiusPx: number;
  /** Preview point-marker fill color. */
  readonly pointFill: string;
}

/**
 * The default preview outline style (HB3-4): a bright accent stroke that reads over the
 * committed feature's fill, so the user sees the geometry follow the cursor during a
 * drag distinct from the static committed shape underneath.
 */
export const DEFAULT_EDIT_PREVIEW_STYLE: EditPreviewStyle = {
  stroke: '#ff8a00',
  widthPx: 2,
  pointRadiusPx: 5,
  pointFill: '#ff8a00',
};

/**
 * Apply the live {@link DragSession}'s preview to a TRANSIENT copy of `store`, returning
 * the previewed vertex store (the input is never mutated — 教訓 5.17 / 5.22). The move
 * MATH is the domain `move` helpers (the SAME single source the release snapshot uses,
 * 教訓 5.30): a vertex-move shifts the single dragged vertex to its final `preview`; a
 * feature-move shifts every vertex of the feature by the drag delta (FR-88). Returns the
 * store unchanged for a tool / feature that resolves nothing (片落とし禁止 — never a half
 * preview, 教訓 5.18).
 */
export function previewVertexStore(
  feature: Feature,
  store: VertexStore,
  session: DragSession,
): VertexStore {
  if (session.target.tool === EDIT_TOOL.VertexMove) {
    const moved = moveVertexTo(session.target.vertexId, store, session.preview);
    return moved === undefined ? store : setVertex(store, moved);
  }
  if (session.target.tool === EDIT_TOOL.FeatureMove) {
    const delta = dragDelta(session);
    let next = store;
    for (const v of moveFeatureVertices(feature, store, {
      dLon: delta.dLon,
      dLat: delta.dLat,
    })) {
      next = setVertex(next, v);
    }
    return next;
  }
  // EdgeAdd (FR-87): the new vertex is materialised on the edge at confirm time, but the
  // in-flight drag previews it at `session.preview` so a NEW vertex handle follows the
  // cursor between the edge's two endpoints (受け入れ基準1 / HB3-4). We insert the reserved
  // id (session.target.newVertexId) at the preview position into the TRANSIENT store; the
  // committed geometry is untouched (教訓 5.22). The vertex BODY alone is not enough — the
  // id must ALSO be spliced into the feature's id list, which is {@link previewFeature}'s
  // job (see the bug note there).
  return setVertex(store, createVertex(session.target.newVertexId, session.preview));
}

/**
 * The FEATURE RECORD to draw during a live drag: unchanged for a move, and — for an
 * EdgeAdd (FR-87) — the record with the reserved `newVertexId` SPLICED between the pressed
 * edge's endpoints. The input is never mutated (a fresh record, 教訓 5.17).
 *
 * WHY (敵対レビュー MEDIUM, 実バグ): {@link previewVertexStore} put the in-flight EdgeAdd
 * vertex into the transient VertexStore only, but both `computeHandles` and
 * {@link buildEditPreviewPrimitives} walk the FEATURE RECORD's id list — which did not
 * contain it. So during an edge-handle drag the new vertex had NO handle (and therefore no
 * FR-82 ドラッグ中リング) and the preview outline still traced the OLD edge: nothing
 * followed the cursor, exactly the「確定後ジャンプ」HB3-4 set out to remove, and the
 * comment claiming the handle was drawn was false.
 *
 * The structural insert delegates to the domain's SINGLE source for it — `addVertexToLine`
 * / `addVertexToLeafRing`, the very ops the release snapshot uses to rewrite the id list —
 * so the previewed topology is exactly the topology confirm will produce (教訓 5.30 単一の
 * 構造挿入規則, never re-derived here). A stale edge (endpoints no longer adjacent), a leaf
 * without the named ring, or a point (no edge at all) resolves to `undefined` → the record
 * is returned UNCHANGED rather than half-inserted (片落とし禁止, 教訓 5.18).
 */
export function previewFeature(feature: Feature, session: DragSession): Feature {
  if (session.target.tool !== EDIT_TOOL.EdgeAdd) return feature;
  const { startVertexId, endVertexId, newVertexId, ringId } = session.target;
  const result =
    feature.kind === FEATURE_KIND.Line
      ? addVertexToLine(feature, startVertexId, endVertexId, newVertexId)
      : feature.kind === FEATURE_KIND.Leaf && ringId !== undefined
        ? addVertexToLeafRing(feature, ringId, startVertexId, endVertexId, newVertexId)
        : undefined;
  return result !== undefined && result.kind === 'feature' ? result.feature : feature;
}

/**
 * Build the live-drag PREVIEW outline primitives for `feature` against the previewed
 * `store` (HB3-4): a polyline per drawn ring (territory / hole) for a leaf, a polyline
 * for a line, a point marker for a point. These follow the cursor every frame so the
 * geometry visibly tracks the drag and release does not jump. Pure: a fresh array.
 */
export function buildEditPreviewPrimitives(
  feature: Feature,
  store: VertexStore,
  style: EditPreviewStyle = DEFAULT_EDIT_PREVIEW_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  switch (feature.kind) {
    case FEATURE_KIND.Point: {
      const v = getVertex(store, feature.vertexId);
      if (v === undefined) break;
      out.push({
        kind: 'point',
        at: { lon: v.coordinate.lon, lat: v.coordinate.lat },
        radiusPx: style.pointRadiusPx,
        fill: style.pointFill,
      } satisfies PointPrimitive);
      break;
    }
    case FEATURE_KIND.Line: {
      const points = resolveRing(feature.vertexIds, store);
      if (points.length >= 2) {
        // Seam parity with the COMMITTED line path (committed-features.ts:292 /
        // HB-14 / FR-07): a line whose vertices straddle ±180 is stored as folded
        // representatives (e.g. 179 next to -179). The render layer's LinePrimitive
        // contract requires CONTINUOUS-scalar longitudes, so a raw folded pair would
        // trace the seam THE LONG WAY (a ~358° world-crossing span) — the committed
        // draw does not. We delegate to U04's single ±360° unwrap source
        // (`unwrapLonSequence`, never re-derived — 技術方針 R3 単一真実源), the EXACT
        // helper committed-features uses, so the preview outline matches the confirmed
        // geometry vertex-for-vertex. Latitude is never wrapped.
        out.push(linePreview(unwrapLonPoints(points), style));
      }
      break;
    }
    case FEATURE_KIND.Leaf: {
      for (const ring of feature.shape.rings) {
        if (ring.kind !== RING_KIND.Territory && ring.kind !== RING_KIND.Hole) continue;
        const points = resolveRing(ring.vertexIds, store);
        if (points.length < 2) continue;
        // Seam parity with the COMMITTED area path (resolve-display-shapes.unwrapShape
        // → alignMultiPolygon → unwrapRingClosed): a seam-crossing ring stored as
        // folded representatives must be made continuous across EVERY edge — the
        // implicit closing edge (last → first) included — or the preview outline spans
        // ~358° per crossing edge while the confirmed fill does not. We funnel each
        // ring through U05's CLOSED-ring unwrap (`unwrapRingClosed`, the single source
        // the area path uses — never re-derived), THEN close it (append the unwrapped
        // first vertex) so the polygon outline reads the short way round.
        const unwrapped = unwrapRingClosedPoints(points);
        const closed = [...unwrapped, unwrapped[0]!];
        out.push(linePreview(closed, style));
      }
      break;
    }
    default:
      // Aggregate: no own shape (FR-35) — nothing to preview.
      break;
  }
  return out;
}

function resolveRing(
  vertexIds: readonly VertexId[],
  store: VertexStore,
): { lon: number; lat: number }[] {
  const out: { lon: number; lat: number }[] = [];
  for (const id of vertexIds) {
    const v = getVertex(store, id);
    if (v === undefined) continue;
    out.push({ lon: v.coordinate.lon, lat: v.coordinate.lat });
  }
  return out;
}

/**
 * Longitude-unwrap an OPEN sequence of preview points into a continuous run,
 * delegating to U04's single ±360° turn-counting source (`unwrapLonSequence`) — the
 * SAME helper the committed line path uses (committed-features.ts:292). Latitude is
 * copied verbatim (never wrapped). Pure: a fresh array.
 */
function unwrapLonPoints(
  points: readonly { lon: number; lat: number }[],
): { lon: number; lat: number }[] {
  const lons = unwrapLonSequence(points.map((p) => p.lon));
  return points.map((p, i) => ({ lon: lons[i]!, lat: p.lat }));
}

/**
 * Longitude-unwrap a CLOSED ring of preview points so it is continuous across the
 * implicit closing edge as well, delegating to U05's `unwrapRingClosed` — the SAME
 * helper the committed area path funnels through (resolve-display-shapes.unwrapShape
 * → alignMultiPolygon → unwrapRingClosed). Latitude is copied verbatim. Pure.
 */
function unwrapRingClosedPoints(
  points: readonly { lon: number; lat: number }[],
): { lon: number; lat: number }[] {
  const unwrapped = unwrapRingClosed(points.map((p) => createCoordinate(p.lon, p.lat)));
  return unwrapped.map((c) => ({ lon: c.lon, lat: c.lat }));
}

function linePreview(
  points: readonly { lon: number; lat: number }[],
  style: EditPreviewStyle,
): LinePrimitive {
  return {
    kind: 'line',
    points: points.map((p) => ({ lon: p.lon, lat: p.lat })),
    widthPx: style.widthPx,
    stroke: style.stroke,
  };
}

/**
 * The FR-80 / FR-82 selection input for the handle layer: which vertices of the active
 * feature are SELECTED, and (for a multi-vertex simultaneous move, FR-80) which are being
 * dragged. Both optional — omitting them draws the plain handles exactly as before.
 *
 * The caller supplies the U22 selection truth (`selection.vertexIds`, and the same set
 * again while `transient.phase === VertexDrag`); the single-vertex live-drag case is
 * derived HERE from the {@link DragSession} this module already owns, so the ring can
 * never disagree with the preview position it is drawn at (単一真実源).
 */
export interface HandleSelectionInput {
  /** Vertices in the U22 selection set (FR-80). */
  readonly selectedVertexIds?: ReadonlySet<VertexId>;
  /** Vertices moved by an in-flight multi-vertex drag (FR-80 同時移動 / FR-82). */
  readonly draggingVertexIds?: ReadonlySet<VertexId>;
  /**
   * FR-81 一owner: the feature the selection set belongs to (`selection.vertexOwner`).
   *
   * WHY IT IS REQUIRED FOR CORRECTNESS (敵対レビュー LOW, 実バグ): a vertex id is a key in
   * the GLOBAL VertexStore and FR-30 共有頂点 means several features cite the SAME id. The
   * store does not always drop the vertex selection when the active feature changes
   * (setActiveFeature keeps it when the new active feature IS the owner; other paths can
   * leave owner ≠ active), so selecting 地物 B's shared vertex and then activating the
   * neighbouring 地物 A used to paint a cyan ring on A's copy of that vertex — a selection
   * A does not have. The ring is applied ONLY to the owner's handles.
   *
   * Omitted / `null` = "no owner named" → the sets apply as given (the pure-render callers
   * and unit tests that pass ids for the one feature they drew stay unchanged).
   */
  readonly ownerFeatureId?: FeatureId | null;
}

const NO_HANDLE_SELECTION: HandleSelectionInput = {};
const NO_HIGHLIGHT: HandleHighlightInput = {};

/**
 * Resolve the FR-82 highlight input for ONE feature's handles: the caller's selection set
 * (only when it belongs to THIS feature — FR-81 一owner, see
 * {@link HandleSelectionInput.ownerFeatureId}), plus the vertex the LIVE session is
 * dragging right now.
 *
 * The session-derived part matters because the single-vertex edit drags (`VertexMove`,
 * and the `EdgeAdd` vertex being born under the cursor) do NOT go through the U22
 * selection set — the moved vertex only exists in the transient {@link DragSession}
 * (教訓 5.22). We read it from the session's OWN `draggedVertexId` — the single source
 * `beginDrag` already fixes for exactly this "which vertex is this gesture moving?"
 * question (snap / 共有化候補 use the same field) — rather than re-deriving it per tool
 * (二重実装禁止, 教訓 5.29). A `FeatureMove` drags no individual vertex (the whole shape
 * moves and already shows a preview outline), so it leaves the field undefined and
 * contributes nothing. Returns a fresh set only when there is something to add.
 */
function highlightFor(
  selection: HandleSelectionInput,
  live: DragSession | null,
  featureId: FeatureId,
): HandleHighlightInput {
  const owned =
    selection.ownerFeatureId == null || selection.ownerFeatureId === featureId;
  const base: HandleHighlightInput = owned
    ? {
        ...(selection.selectedVertexIds === undefined
          ? {}
          : { selectedVertexIds: selection.selectedVertexIds }),
        ...(selection.draggingVertexIds === undefined
          ? {}
          : { draggingVertexIds: selection.draggingVertexIds }),
      }
    : NO_HIGHLIGHT;
  const liveVertex = live?.draggedVertexId;
  if (liveVertex === undefined) return base;
  const dragging = new Set<VertexId>(base.draggingVertexIds ?? []);
  dragging.add(liveVertex);
  return { ...base, draggingVertexIds: dragging };
}

// FR-30 shared-vertex derivation (共有頂点の視覚区別) is the SAME single-source set the
// FR-96 右クリック「共有解除」出し分け and the FR-33 共有解除本体 use, extracted to
// `shared-vertex-derivation.sharedVertexIdsFor` so the visual marker can never drift from
// the menu offering or the unshare target (教訓 5.29 二重実装禁止). See that module.

/**
 * Build the edit-handle (+ live-drag preview) draw primitives for the ACTIVE feature at
 * the current time (HB3-9 / HB3-4 / FR-87 / FR-88). Returns an EMPTY array when there is
 * no active feature, or the active feature does not exist at `time` (it ceased to exist /
 * was deleted) — in both cases nothing is editable, so no handle is drawn (受け入れ基準:
 * 非存在は描画指示に現れない, 教訓 5.18 absence-not-crash).
 *
 * When `session` is a LIVE drag of the active feature (HB3-4), the handles AND a preview
 * outline are computed against the previewed vertex positions, so the vertex / feature
 * follows the cursor every frame and release does not jump. The move math is the SAME
 * domain `move` helpers the release snapshot uses (単一の move 規則, 教訓 5.30). When
 * `session` is absent / for a different feature, the committed positions are drawn (the
 * static handle layer, HB3-9).
 *
 * The feature + its vertex store come from the SAME `resolveDisplayFor` bundle the
 * renderer / hit-test share, so the handles sit exactly on the drawn vertices (教訓
 * 5.29). The world→screen constant-size projection (FR-17) is the renderer's job.
 *
 * FR-110 表示上限 (vertexMarkerCap): the per-vertex edit handles are a PERFORMANCE
 * cost that scales with vertex count, so when a feature owns MORE than `cap`
 * vertices (or `cap === 0`) the handle path — vertex handles, edge handles AND
 * the live-drag preview outline — is suppressed WHOLESALE (a threshold, not a leading-N
 * slice), EXCEPT the SELECTED / DRAGGING vertices, which the cap contract explicitly
 * exempts (別経路 — see `domain/selection/visual.ts`) and which are bounded by the
 * selection size. This is the LIVE consumer of the setting (the `visual.classifyVisual`
 * cap is a separate, currently-未結線 FR-79 marker path — see that file's note).
 * `cap === undefined` leaves handles unlimited; the caller supplies
 * `appSettings.vertexMarkerCap` (single source = U16). The default cap (2000) leaves
 * normal features unchanged and only guards pathologically large geometry. Feature-level
 * selection / move (feature-move) is a SEPARATE path and is unaffected by this gate.
 *
 * FR-80 / FR-82 選択頂点ハイライト: `selection` names the SELECTED (and multi-drag) vertices
 * so the corresponding handles are drawn with an outer highlight RING. Before this the
 * builder took no selection input at all, so selecting a vertex changed NOTHING on screen
 * (実機検証: 選択前後の接写が画素一致) — the classification existed in
 * `domain/selection/visual` but had no render consumer (教訓 5.7 ロジックはあるが UI から
 * 呼ばれない, the same shape of defect as HB3-9). The ring is a SEPARATE channel from the
 * fill so the FR-30 共有頂点 amber survives underneath (共有∧選択 が両方読める). The
 * single-vertex live-drag ring is derived from `session` here, so it always matches the
 * previewed handle position. `selection.ownerFeatureId` (FR-81) keeps the ring on the
 * OWNER's handles only, so a shared vertex selected on a neighbour never rings here.
 *
 * FR-82 頂点選択コンテキスト地物: when the selection's owner is NOT the active feature (the
 * U22 vertex branch does not promote it — and with no active feature at all this used to
 * draw nothing whatsoever), the owner's VERTEX handles are drawn too, with the ring on the
 * selected ones. Its edge handles are NOT drawn: FR-87 makes an edge midpoint grabbable
 * only for the active feature, so drawing one would break 描画==ヒット.
 *
 * Pure over `(root, time, activeFeature, displayControl, session, style, previewStyle,
 * cap, filter, selection)`.
 */
export function buildActiveFeatureHandlePrimitives(
  root: DomainProject,
  time: TimePoint,
  activeFeature: FeatureId | null,
  displayControl: DisplayControlInput,
  session?: DragSession | null,
  style?: EditHandleStyle,
  previewStyle?: EditPreviewStyle,
  cap?: number,
  filter: FilterState = DEFAULT_FILTER_STATE,
  selection: HandleSelectionInput = NO_HANDLE_SELECTION,
): DrawPrimitive[] {
  // FR-82 頂点選択コンテキスト地物 — the SECOND feature this layer may have to draw.
  //
  // WHY (敵対レビュー HIGH, 実バグ): U22's HIT_KIND.Vertex branch deliberately does NOT
  // promote the vertex's owner to activeFeature (FR-82 names「頂点選択コンテキスト地物」as a
  // state of its own, distinct from アクティブ地物), and the live hit-test hands back a
  // Vertex hit for EVERY drawn feature's vertices — not just the active one. So the very
  // first click of a session, straight onto a vertex, produced `activeFeature === null,
  // vertexOwner = A` … and this builder returned [] on the spot: the user's selection was
  // real, the store said so, and the screen showed absolutely nothing.
  //
  // We therefore also draw the OWNER of the vertex selection when it is not the active
  // feature — its VERTEX handles only. Edge handles are deliberately excluded: FR-87 makes
  // an edge midpoint grabbable ONLY for the active feature, so drawing one here would put
  // a handle on screen that cannot be grabbed (描画==ヒット を壊す). Vertex handles have no
  // such asymmetry — every drawn feature's vertices are grabbable — so they stay honest.
  const owner = selection.ownerFeatureId ?? null;
  const contextOwner =
    owner !== null && owner !== activeFeature && (selection.selectedVertexIds?.size ?? 0) > 0
      ? owner
      : null;
  if (activeFeature === null && contextOwner === null) return [];

  const resolution = resolveDisplayFor(root, time, displayControl);
  const out: DrawPrimitive[] = [];
  if (activeFeature !== null) {
    out.push(
      ...featureHandlePrimitives(resolution, filter, activeFeature, {
        session,
        style,
        previewStyle,
        cap,
        selection,
        includeEdges: true,
      }),
    );
  }
  if (contextOwner !== null) {
    out.push(
      ...featureHandlePrimitives(resolution, filter, contextOwner, {
        // A live edit drag is owned by the ACTIVE feature's path; the context owner draws
        // its committed positions only (no preview outline, no drag ring from a session).
        session: null,
        style,
        previewStyle,
        cap,
        selection,
        includeEdges: false,
      }),
    );
  }
  return out;
}

/** Per-feature options for {@link featureHandlePrimitives}. */
interface FeatureHandleOptions {
  readonly session: DragSession | null | undefined;
  readonly style: EditHandleStyle | undefined;
  readonly previewStyle: EditPreviewStyle | undefined;
  readonly cap: number | undefined;
  readonly selection: HandleSelectionInput;
  /** FR-87 edge (add-vertex) handles — active feature only (see the call sites). */
  readonly includeEdges: boolean;
}

/**
 * Build the handle (+ live-drag preview) primitives for ONE feature of the resolved
 * display bundle. Returns [] when the feature is filter-hidden, not effective at the
 * resolved time, or has nothing to draw (教訓 5.18 absence-not-crash).
 */
function featureHandlePrimitives(
  resolution: DisplayResolution,
  filter: FilterState,
  featureId: FeatureId,
  options: FeatureHandleOptions,
): DrawPrimitive[] {
  // FR-113 (Codex F2, defense in depth): a feature the display filter HIDES draws no
  // handles — even if the selection-heal has not yet run, 描画==ヒットで hidden 地物には
  // ハンドルが出ない (不変条件). Inert filter ⇒ always visible ⇒ unchanged (zero overhead).
  if (!isFeatureVisibleUnderFilter(resolution, filter, featureId)) return [];
  const { features, areaFeaturesById, vertices } = resolution;
  // The feature among those effective at `time`. Points / lines are in `features`;
  // leaves / aggregates are additionally indexed in `areaFeaturesById` (the by-id lookup
  // the draw path already built — reuse it, no second O(n) scan).
  const committed =
    areaFeaturesById.get(featureId) ?? features.find((f) => f.id === featureId);
  if (committed === undefined) return [];

  // HB3-4: a live drag of THIS feature previews its moved geometry. The session is only
  // applied when it targets this feature, so a stale session for another feature can never
  // bleed in (教訓 5.6). The preview store + record feed BOTH the handles (so grab targets
  // follow) and the outline (so the shape follows).
  const { session } = options;
  const live = session != null && session.target.featureId === featureId ? session : null;
  const previewStore =
    live === null ? vertices : previewVertexStore(committed, vertices, live);
  // FR-87: an EdgeAdd drag also changes the RECORD (the reserved new id is spliced into
  // the id list) — without it neither the handle nor the outline can show the new vertex.
  const feature = live === null ? committed : previewFeature(committed, live);

  // `computeHandles` returns EMPTY_HANDLES for an aggregate (no own shape, FR-35); a
  // leaf / point / line yields its real handles. Either way we bridge through the SAME
  // render builder so an aggregate feature simply draws no handles.
  const all = computeHandles(feature, previewStore);
  const highlight = highlightFor(options.selection, live, featureId);
  const handles: EditHandles = options.includeEdges
    ? all
    : { vertices: all.vertices, edges: [] };

  // FR-110 表示上限 (vertexMarkerCap) — the perf gate. When the feature owns MORE vertices
  // than `cap` (count = one vertex handle per vertex), the FR-79 style「全頂点ぶんのハンドル」
  // are suppressed WHOLESALE together with the edge handles and the live-drag preview
  // outline (a threshold, never a leading-N slice). `cap === 0` therefore suppresses them
  // all; `cap === undefined` leaves it unlimited.
  //
  // EXEMPTION (敵対レビュー MEDIUM, 実バグ): the SELECTED / DRAGGING vertices survive. The
  // cap's contract — declared once in `domain/selection/visual.ts` — is that it gates ONLY
  // the FR-79 全頂点マーカー and that「選択済み頂点とドラッグ中頂点は別経路なので cap に
  // 関係なく常にスタイルされる」. Dropping them here contradicted that and made a huge
  // feature's edit invisible: you could still grab and drag a vertex (the hit-test is not
  // capped) with zero feedback. The survivors are bounded by the selection size, so the
  // perf guard the cap exists for is intact.
  if (options.cap !== undefined && all.vertices.length > options.cap) {
    const ringed = handles.vertices.filter((v) => isRingedVertex(v.vertexId, highlight));
    if (ringed.length === 0) return [];
    return buildEditHandlePrimitives(
      { vertices: ringed, edges: [] },
      options.style,
      sharedVertexIdsFor(resolution),
      highlight,
    );
  }

  const hasHandles =
    handles !== EMPTY_HANDLES &&
    (handles.vertices.length > 0 || handles.edges.length > 0);
  if (!hasHandles && live === null) return [];

  const out: DrawPrimitive[] = [];
  // The preview outline draws UNDER the handles so the grab targets stay on top (教訓
  // 5.14 描画順). Only present during a live drag.
  if (live !== null) {
    out.push(...buildEditPreviewPrimitives(feature, previewStore, options.previewStyle));
  }
  if (hasHandles) {
    // FR-30: pass the SHARED vertex id set so a vertex cited by ≥2 shape references
    // (this feature + a neighbour, or two rings of this leaf) draws in the distinct
    // sharedVertexFill. Derived from the SAME resolved bundle (memoized by identity),
    // so the visual matches the linked-move behaviour exactly (単一真実源).
    // FR-80/82: …and the selection / live-drag highlight as an ORTHOGONAL ring channel,
    // so a vertex that is shared AND selected reads as both.
    out.push(
      ...buildEditHandlePrimitives(
        handles,
        options.style,
        sharedVertexIdsFor(resolution),
        highlight,
      ),
    );
  }
  return out;
}
