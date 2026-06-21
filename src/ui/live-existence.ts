// UI layer — the LIVE time-existence resolver over the committed DomainProject.
//
// WHY THIS FILE EXISTS (教訓 5.5 / 5.6 / 5.29 — 単一の真実源):
// The session store (U16) re-validates time-dependent selection on EVERY
// time-change through an injected {@link ExistenceResolver} (existence.ts). The
// store re-implements NO time logic — it calls the injected predicates opaquely.
// The composition root must therefore supply predicates bound to the LIVE domain
// root so a time change actually deselects a feature / vertex that ceased to
// exist at the new time (FR-64 / FR-66 / FR-70). Before this, App.tsx created the
// store with NO `existence` option, so it fell back to ALWAYS_PRESENT_RESOLVER
// and the documented re-validation funnel was a silent no-op in the shipped app:
// selecting a feature effective only in [t0, t1] then moving the timeline past t1
// left it the active selection (property panel / delete / edit-move all acted on
// a feature `resolveAt` no longer returned) even though the map had dropped it.
//
// The resolution rule is the SAME live-lookup the renderer / hit-test / knife use
// (featuresAt / verticesAt), so "exists for re-validation" == "drawn / hittable"
// — no second truth source that could drift. The resolver reads the root through
// an injected `getRoot` thunk (NOT a captured snapshot, 教訓 5.6): the store is
// created before its own state exists, so the root is read live at call time, the
// same getRoot-ref pattern recordCommit uses.

import type { DomainProject } from '../domain/persistence/index';
import type { FeatureId, VertexId } from '../domain/ids';
import type { TimePoint } from '../domain/time/time-point';
import { hasVertex } from '../domain/vertex';

import type { ExistenceResolver } from './state/existence';
import { featuresAt, verticesAt } from './live-lookup';

/**
 * Build an {@link ExistenceResolver} bound to the live domain root. The `getRoot`
 * thunk is read on every predicate call so the resolver always sees the CURRENT
 * committed root (a load / new / edit swaps it wholesale), never a stale capture.
 *
 * - `featureExistsAt(id, t)` — the feature is effective at `t` iff it appears in
 *   the union of every present anchor's snapshot at `t` (featuresAt). This is the
 *   exact set the renderer draws and the hit-test picks from (単一真実源).
 * - `vertexExistsAt(_owner, vid, t)` — the vertex body is effective at `t` iff it
 *   appears in the union of every present anchor's vertex store at `t` (verticesAt).
 *   The owner's own existence is already enforced by U22's revalidateForTime,
 *   which gates the vertex pass on `featureExistsAt(owner, t)` first; this predicate
 *   only answers the vertex-body time-existence question.
 */
export function createLiveExistenceResolver(
  getRoot: () => DomainProject,
): ExistenceResolver {
  return {
    featureExistsAt: (featureId: FeatureId, time: TimePoint): boolean =>
      featuresAt(getRoot(), time).some((f) => f.id === featureId),
    vertexExistsAt: (
      _ownerFeatureId: FeatureId,
      vertexId: VertexId,
      time: TimePoint,
    ): boolean => hasVertex(verticesAt(getRoot(), time), vertexId),
  };
}
