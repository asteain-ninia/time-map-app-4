// UI layer (map): the ACTIVE-FEATURE edit-handles render input (HB3-9 / FR-87).
//
// WHY THIS FILE EXISTS (the missing render接続 — HB3-9):
// `domain/editing/handles.computeHandles` resolves a selected feature's vertex /
// edge-midpoint handles in WORLD coordinates, but NOTHING in the render pipeline ever
// called it — the only consumer was its unit test (診断 HB3-9 / 教訓 5.7). This module
// is the ONE place that, given the live `(root, time, displayControl, activeFeature)`,
// resolves the active feature + its vertex store effective at the current time (the
// SAME single resolution the draw + hit-test share, 教訓 5.29) and runs `computeHandles`
// over it, then bridges the result into screen-fixed `HandlePrimitive`s via the render
// layer's `buildEditHandlePrimitives` (FR-17 applied at the render boundary).
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
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';

import type { DisplayControlInput } from '../../render/display-pipeline';
import {
  buildEditHandlePrimitives,
  type EditHandleStyle,
} from '../../render/edit-handles-layer';
import type { DrawPrimitive } from '../../render/map-renderer';

import { resolveDisplayFor } from './display-resolution-cache';

/**
 * Build the edit-handle draw primitives for the ACTIVE feature at the current time
 * (HB3-9 / FR-87). Returns an EMPTY array when there is no active feature, or the
 * active feature does not exist at `time` (it ceased to exist / was deleted) — in both
 * cases nothing is editable, so no handle is drawn (受け入れ基準: 非存在は描画指示に現れ
 * ない, 教訓 5.18 absence-not-crash). The feature + its vertex store come from the SAME
 * `resolveDisplayFor` bundle the renderer / hit-test share, so the handles sit exactly on
 * the drawn vertices (教訓 5.29). The world→screen constant-size projection (FR-17) is the
 * renderer's job; this only supplies the screen-fixed-styled world primitives.
 *
 * Pure over `(root, time, activeFeature, displayControl)` — all immutable U16 store
 * references — so the same inputs yield the same primitives.
 */
export function buildActiveFeatureHandlePrimitives(
  root: DomainProject,
  time: TimePoint,
  activeFeature: FeatureId | null,
  displayControl: DisplayControlInput,
  style?: EditHandleStyle,
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
  // `computeHandles` returns EMPTY_HANDLES for an aggregate (no own shape, FR-35); a
  // leaf / point / line yields its real handles. Either way we bridge through the SAME
  // render builder so an aggregate active feature simply draws no handles.
  const handles = computeHandles(feature, vertices);
  if (handles === EMPTY_HANDLES || (handles.vertices.length === 0 && handles.edges.length === 0)) {
    return [];
  }
  return buildEditHandlePrimitives(handles, style);
}
