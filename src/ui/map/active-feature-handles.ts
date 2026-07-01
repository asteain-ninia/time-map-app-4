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
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { RING_KIND } from '../../domain/ring';
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

import { resolveDisplayFor } from './display-resolution-cache';

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
        out.push(linePreview(points, style));
      }
      break;
    }
    case FEATURE_KIND.Leaf: {
      for (const ring of feature.shape.rings) {
        if (ring.kind !== RING_KIND.Territory && ring.kind !== RING_KIND.Hole) continue;
        const points = resolveRing(ring.vertexIds, store);
        if (points.length < 2) continue;
        // Close the ring so the preview reads as a polygon outline (last → first).
        const closed = [...points, points[0]!];
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
 * Pure over `(root, time, activeFeature, displayControl, session)`.
 */
export function buildActiveFeatureHandlePrimitives(
  root: DomainProject,
  time: TimePoint,
  activeFeature: FeatureId | null,
  displayControl: DisplayControlInput,
  session?: DragSession | null,
  style?: EditHandleStyle,
  previewStyle?: EditPreviewStyle,
): DrawPrimitive[] {
  if (activeFeature === null) return [];
  const { features, areaFeaturesById, vertices } = resolveDisplayFor(
    root,
    time,
    displayControl,
  );
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
    out.push(...buildEditHandlePrimitives(handles, style));
  }
  return out;
}
