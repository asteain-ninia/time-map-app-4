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

import { computeHandles, EMPTY_HANDLES } from '../../domain/editing/handles';
import {
  EDIT_TOOL,
  dragDelta,
  type DragSession,
} from '../../domain/editing/drag-session';
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
import {
  buildReverseIndex,
  createSharedVertexState,
  type ContainerEntry,
} from '../../domain/shared-vertex';
import type { TimePoint } from '../../domain/time/time-point';
import { createVertex, getVertex, setVertex, type VertexStore } from '../../domain/vertex';

import type { DisplayControlInput } from '../../render/display-pipeline';
import {
  buildEditHandlePrimitives,
  type EditHandleStyle,
} from '../../render/edit-handles-layer';
import type {
  DrawPrimitive,
  LinePrimitive,
  PointPrimitive,
} from '../../render/map-renderer';

import { resolveDisplayFor, type DisplayResolution } from './display-resolution-cache';

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
  // feature record is unchanged during the drag (the confirm snapshot rewrites the id list
  // via addVertexToLine / addVertexToLeafRing — the SAME single source for the structural
  // insert, 教訓 5.30). computeHandles over the previewed store then draws the new vertex
  // handle at the preview; the committed geometry is untouched (教訓 5.22).
  return setVertex(store, createVertex(session.target.newVertexId, session.preview));
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

// ---------------------------------------------------------------------------
// FR-30 shared-vertex derivation (共有頂点の視覚区別).
// ---------------------------------------------------------------------------
//
// A vertex is SHARED when ≥2 distinct shape references cite it (two features, or
// two rings of one leaf). Sharing is DERIVED, never stored (単一真実源 / domain
// shared-vertex §4.1), so we build the domain `SharedVertexState` from the SAME
// resolved feature set + vertex store the handles are drawn against and read the
// shared ids off its reverse index. This is faithful to the one derivation every
// shared-vertex consumer uses (buildReverseIndex), so the visual can never drift
// from linked-move behaviour.
//
// The set covers ALL features effective this frame (not just the active one): a
// vertex the active feature shares with a NEIGHBOUR is shared even though the
// neighbour's other citation lives in a different feature. Points reference a
// single vertex but have no ShapeContainer in the domain model (only rings / line
// paths are containers), so a point's vertex is only ever "shared" when a ring /
// line also cites it — which is exactly the domain's own notion of sharing.

/**
 * Every ring + line-path container of `features` as domain `ContainerEntry`s (the
 * input to a `SharedVertexState`). Leaf rings (territory / hole / enclave) and line
 * paths are the only ShapeContainers; points / aggregates contribute none.
 */
function containersOf(features: readonly Feature[]): ContainerEntry[] {
  const entries: ContainerEntry[] = [];
  for (const f of features) {
    if (f.kind === FEATURE_KIND.Line) {
      entries.push({ container: { kind: 'line', featureId: f.id }, vertexIds: f.vertexIds });
    } else if (f.kind === FEATURE_KIND.Leaf) {
      for (const ring of f.shape.rings) {
        entries.push({
          container: { kind: 'ring', featureId: f.id, ringId: ring.id },
          vertexIds: ring.vertexIds,
        });
      }
    }
  }
  return entries;
}

// Per-frame memo (bughunt perf pattern, see display-resolution-cache): the shared
// id set is a pure function of the resolved bundle identity — features + containers
// do not change during a drag (only vertex BODIES move), so it is derived ONCE per
// `resolveDisplayFor` generation and reused across frames of the same generation.
// Keyed on the bundle's IDENTITY (a WeakMap, so an evicted generation is collected).
const sharedIdCache = new WeakMap<DisplayResolution, ReadonlySet<VertexId>>();

/**
 * The set of SHARED vertex ids across all features of `resolution` (FR-30), memoized
 * by the bundle's identity. Built from the domain `SharedVertexState` reverse index
 * (the single sharing derivation), so a vertex is "shared" iff ≥2 distinct shape
 * references cite it.
 */
function sharedVertexIdsFor(resolution: DisplayResolution): ReadonlySet<VertexId> {
  const cached = sharedIdCache.get(resolution);
  if (cached !== undefined) return cached;
  const state = createSharedVertexState(resolution.vertices, containersOf(resolution.features));
  const index = buildReverseIndex(state);
  const shared = new Set<VertexId>();
  for (const [vid, refs] of index) {
    if (refs.length >= 2) shared.add(vid);
  }
  sharedIdCache.set(resolution, shared);
  return shared;
}

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
 * cost that scales with vertex count, so when the active feature owns MORE than `cap`
 * vertices (or `cap === 0`) the WHOLE handle path — vertex handles, edge handles AND
 * the live-drag preview outline — is suppressed WHOLESALE (a threshold, not a leading-N
 * slice: either all handles or none). This is the LIVE consumer of the setting (the
 * `visual.classifyVisual` cap is a separate, currently-未結線 FR-79 marker path — see
 * that file's note). `cap === undefined` leaves handles unlimited; the caller supplies
 * `appSettings.vertexMarkerCap` (single source = U16). The default cap (2000) leaves
 * normal features unchanged and only guards pathologically large geometry. Feature-level
 * selection / move (feature-move) is a SEPARATE path and is unaffected by this gate.
 *
 * Pure over `(root, time, activeFeature, displayControl, session, style, previewStyle,
 * cap)`.
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
): DrawPrimitive[] {
  if (activeFeature === null) return [];
  const resolution = resolveDisplayFor(root, time, displayControl);
  const { features, areaFeaturesById, vertices } = resolution;
  // The active feature among the features effective at `time`. Points / lines are in
  // `features`; leaves / aggregates are additionally indexed in `areaFeaturesById`
  // (the by-id lookup the draw path already built — reuse it, no second O(n) scan).
  const feature =
    areaFeaturesById.get(activeFeature) ??
    features.find((f) => f.id === activeFeature);
  if (feature === undefined) return [];

  // HB3-4: a live drag of THIS active feature previews its moved geometry. The session
  // is only applied when it targets the active feature, so a stale session for another
  // feature can never bleed in (教訓 5.6). The preview store feeds BOTH the handles (so
  // grab targets follow) and the outline (so the shape follows).
  const live =
    session != null && session.target.featureId === activeFeature ? session : null;
  const previewStore = live === null ? vertices : previewVertexStore(feature, vertices, live);

  // `computeHandles` returns EMPTY_HANDLES for an aggregate (no own shape, FR-35); a
  // leaf / point / line yields its real handles. Either way we bridge through the SAME
  // render builder so an aggregate active feature simply draws no handles.
  const handles = computeHandles(feature, previewStore);

  // FR-110 表示上限 (vertexMarkerCap) — WHOLESALE perf gate. When the active feature owns
  // MORE vertices than `cap` (count = one vertex handle per vertex), suppress the ENTIRE
  // handle path — vertex handles, edge handles AND the live-drag preview outline — and
  // draw nothing (a threshold, never a leading-N slice). `cap === 0` therefore suppresses
  // all. `cap === undefined` leaves it unlimited. This is the LIVE consumer of the
  // setting; feature-level selection / move is a separate path and is not gated here.
  if (cap !== undefined && handles.vertices.length > cap) return [];

  const hasHandles =
    handles !== EMPTY_HANDLES &&
    (handles.vertices.length > 0 || handles.edges.length > 0);
  if (!hasHandles && live === null) return [];

  const out: DrawPrimitive[] = [];
  // The preview outline draws UNDER the handles so the grab targets stay on top (教訓
  // 5.14 描画順). Only present during a live drag.
  if (live !== null) {
    out.push(...buildEditPreviewPrimitives(feature, previewStore, previewStyle));
  }
  if (hasHandles) {
    // FR-30: pass the SHARED vertex id set so a vertex cited by ≥2 shape references
    // (this feature + a neighbour, or two rings of this leaf) draws in the distinct
    // sharedVertexFill. Derived from the SAME resolved bundle (memoized by identity),
    // so the visual matches the linked-move behaviour exactly (単一真実源).
    out.push(...buildEditHandlePrimitives(handles, style, sharedVertexIdsFor(resolution)));
  }
  return out;
}
