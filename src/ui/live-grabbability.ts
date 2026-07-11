// UI layer — the LIVE display-owner resolver over the committed DomainProject.
//
// WHY THIS FILE EXISTS (選択 heal の対称性完成, 教訓 5.5 / 5.6 / 5.29 — 単一の真実源):
// The session store (U16) re-validates the vertex selection through U22's
// revalidateForDisplay whenever ANY display-resolution input changes — a
// displayControl setter (depth / focus), a time change (setCurrentTime / timeline
// re-derive) or a domain swap (applyCommandResult / applyUndoRedoResult) — via an
// injected {@link DisplayGrabbabilityResolver} (state/grabbability.ts), the
// DISPLAY-axis sibling of createLiveExistenceResolver (the TIME axis). The store
// re-implements NO display-verdict / owner-claiming logic; it calls the injected
// port opaquely. The composition root must supply a resolver bound to the LIVE
// domain root so a change that stops drawing the vertex-selection owner actually
// re-resolves the selection (otherwise the property panel shows「選択頂点の所有地物
// を特定できません」for vertices the map no longer draws grabbable handles for).
//
// The resolution rule is the SAME resolveDisplayFor bundle the renderer draws and
// the live hit-test grabs (`owners` = the grabbable vertex → owning-feature map), so
//「掴める（再検証上）」==「描画/ヒット対象」— no second truth source that could
// drift. The resolver reads the root through an injected `getRoot` thunk (NOT a
// captured snapshot, 教訓 5.6): the store is created before its own state exists, so
// the root is read live at call time — the same getRoot-ref pattern
// createLiveExistenceResolver uses. Reading live is ALSO what lets the store run the
// heal AFTER a domain commit (applyCommandResult / applyUndoRedoResult) against the
// just-committed root, mirroring the 第10波 #5 ordering.

import type { DomainProject } from '../domain/persistence/index';
import type { FeatureId, VertexId } from '../domain/ids';
import type { TimePoint } from '../domain/time/time-point';

import { resolveDisplayFor } from './map/display-resolution-cache';
import type { DisplayControl } from './state/session';
import type { DisplayGrabbabilityResolver } from './state/grabbability';

/**
 * Build a {@link DisplayGrabbabilityResolver} bound to the live domain root. The
 * `getRoot` thunk is read on every owner query so the resolver always sees the
 * CURRENT committed root (a load / new / edit / undo swaps it wholesale), never a
 * stale capture.
 *
 * `displayOwnersAt(t, control)` returns a LAZY {@link VertexOwnerLookup} over
 * resolveDisplayFor's `owners` map for `(root, t, control)` — the EXACT vertex →
 * owning-feature map the live hit-test grabs from and the property panel's context
 * classification reads (単一真実源). LAZY: the display resolution runs only when
 * `ownerOf` is actually called (revalidateForDisplay never consults it for an
 * empty / active-owned selection), and repeated calls on one generation are memo
 * HITS — the store passes the control/time it is about to (or just did) commit, so
 * this resolves against the SAME memoized bundle the next redraw will use.
 */
export function createLiveGrabbabilityResolver(
  getRoot: () => DomainProject,
): DisplayGrabbabilityResolver {
  return {
    displayOwnersAt: (time: TimePoint, control: DisplayControl) => ({
      ownerOf: (vertexId: VertexId): FeatureId | null =>
        resolveDisplayFor(getRoot(), time, control).owners.get(vertexId) ?? null,
    }),
  };
}
