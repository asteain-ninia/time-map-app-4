// UI layer — the LIVE display-grabbability resolver over the committed DomainProject.
//
// WHY THIS FILE EXISTS (選択 heal の対称性完成, 教訓 5.5 / 5.6 / 5.29 — 単一の真実源):
// The session store (U16) re-validates the vertex selection on EVERY display-control
// change (setGlobalDepth / setFocus* / setDisplayFocus / clearDisplayFocus → U22
// revalidateForDisplay) through an injected {@link DisplayGrabbabilityResolver}
// (state/grabbability.ts) — the DISPLAY-axis sibling of createLiveExistenceResolver
// (the TIME axis). The store re-implements NO display-verdict logic; it calls the
// injected predicate opaquely. The composition root must supply a predicate bound to
// the LIVE domain root so a depth/focus change that rolls the vertex-selection owner
// up into an aggregate (or omits it) actually prunes the now-un-grabbable selection
// (otherwise the property panel shows「選択頂点の所有地物を特定できません」for a
// selection the map no longer draws grabbable handles for).
//
// The resolution rule is the SAME resolveDisplayFor bundle the renderer draws and the
// live hit-test grabs (`grabbable` = features exposing their own grabbable vertices
// this frame), so「掴める（再検証上）」==「描画/ヒット対象」— no second truth source
// that could drift. The resolver reads the root through an injected `getRoot` thunk
// (NOT a captured snapshot, 教訓 5.6): the store is created before its own state
// exists, so the root is read live at call time — the same getRoot-ref pattern
// createLiveExistenceResolver uses.

import type { DomainProject } from '../domain/persistence/index';
import type { FeatureId } from '../domain/ids';
import type { TimePoint } from '../domain/time/time-point';

import { resolveDisplayFor } from './map/display-resolution-cache';
import type { DisplayControl } from './state/session';
import type { DisplayGrabbabilityResolver } from './state/grabbability';

/**
 * Build a {@link DisplayGrabbabilityResolver} bound to the live domain root. The
 * `getRoot` thunk is read on every call so the resolver always sees the CURRENT
 * committed root (a load / new / edit swaps it wholesale), never a stale capture.
 *
 * `ownerExposesVerticesAt(id, t, control)` is true iff feature `id` is in
 * resolveDisplayFor's `grabbable` set for `(root, t, control)` — i.e. it is drawn
 * with its own real shape (a leaf at/above the depth threshold, or a point / line),
 * not rolled up into an aggregate (its area derived) nor omitted. This is the EXACT
 * set the live hit-test grabs vertices from (単一真実源). The store passes the NEW
 * display control it is about to commit, so this resolves against the SAME memoized
 * bundle the next redraw will use (a cache hit, not a second pipeline run).
 */
export function createLiveGrabbabilityResolver(
  getRoot: () => DomainProject,
): DisplayGrabbabilityResolver {
  return {
    ownerExposesVerticesAt: (
      featureId: FeatureId,
      time: TimePoint,
      control: DisplayControl,
    ): boolean => resolveDisplayFor(getRoot(), time, control).grabbable.has(featureId),
  };
}
