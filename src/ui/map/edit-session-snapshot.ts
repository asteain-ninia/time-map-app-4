// U40↔U24 wiring — the pure after-state snapshot builder for a live edit-session
// release (受け入れ基準9 / 教訓5.7 完了トリガー / 5.29 単一真実源).
//
// WHY THIS FILE EXISTS: {@link createEditSessionPort} needs a `buildSnapshot` that
// turns the live {@link DragSession} (the final preview position of a vertex / a
// whole-feature平行移動) into the complete-state {@link FeatureSnapshot} U24's
// `confirmRelease` hands to U13. The composition root holds the domain root + time,
// but the construction RULE — which vertex bodies moved, against the SAME committed
// feature record / vertex store the renderer drew — must be one testable place, not
// inlined in App.tsx (教訓5.7 合成ルートの結線漏れ / 5.34 契約越し). This module is
// that rule. It is pure: caller passes the root + time; no React, no store.
//
// The moved geometry is the VERTEX BODIES only — a vertex/feature move never changes
// the feature record's vertex ids / ring ids / shape structure, so the snapshot's
// `feature` is the committed feature UNCHANGED and `vertices` carries the new
// coordinates the U13 ports merge (FR-88 / FR-59 一体編集). The domain `move` helpers
// (moveVertexTo / moveFeatureVertices) are the SINGLE source of the move math — this
// module never re-derives a coordinate shift (教訓5.30).

import { EDIT_TOOL, type DragSession } from '../../domain/editing/drag-session';
import { dragDelta } from '../../domain/editing/drag-session';
import {
  moveFeatureVertices,
  moveVertexTo,
} from '../../domain/editing/move';
import {
  buildSnapshot,
  decideSharePairAtRelease,
  type FeatureSnapshot,
} from '../../domain/editing/edit-flow';
import type { Feature } from '../../domain/feature';
import { FEATURE_KIND } from '../../domain/feature';
import type { RingId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { featureByIdAt, verticesAt } from '../live-lookup';

/** The live domain context the snapshot is built against (read fresh per release). */
export interface EditSnapshotContext {
  /** The current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainProject;
  /** The editing-base / current timeline time recorded as the anchor (FR-57). */
  readonly getTime: () => TimePoint;
}

/**
 * Build the complete after-state {@link FeatureSnapshot} for a confirming edit
 * release. The session's `target` decides which vertices moved:
 *   - VertexMove → the single dragged vertex to its final `preview` (FR-88).
 *   - FeatureMove → every vertex of the feature by the drag delta (FR-88 平行移動).
 * The feature record itself is unchanged (ids / structure are stable); only the
 * vertex bodies carry new coordinates. When the feature / vertices cannot be
 * resolved at the time (stale data) an EMPTY snapshot is returned, which
 * `confirmRelease` treats as a no-op (片落とし禁止 — never a half edit, 教訓5.18).
 */
export function buildEditSnapshot(
  ctx: EditSnapshotContext,
  session: DragSession,
): FeatureSnapshot {
  const root = ctx.getRoot();
  const time = ctx.getTime();
  const featureId = session.target.featureId;
  const feature = featureByIdAt(root, time, featureId);
  if (feature === undefined) return buildSnapshot({ vertices: [] });
  const store = verticesAt(root, time);

  if (session.target.tool === EDIT_TOOL.VertexMove) {
    const moved = moveVertexTo(session.target.vertexId, store, session.preview);
    if (moved === undefined) return buildSnapshot({ vertices: [] });
    // 受け入れ基準12 / FR-31: forward a snap that survived to release as the decided
    // share pair so the apply op collapses the dragged vertex onto its target (the
    // SINGLE U24→U11 hand-off; decideSharePairAtRelease drops a lapsed candidate).
    const sharePair = decideSharePairAtRelease(session);
    return buildSnapshot({ feature, vertices: [moved], sharePair });
  }

  if (session.target.tool === EDIT_TOOL.FeatureMove) {
    const delta = dragDelta(session);
    const moved = moveFeatureVertices(feature, store, { dLon: delta.dLon, dLat: delta.dLat });
    return buildSnapshot({ feature, vertices: moved });
  }

  // EdgeAdd is UI-unreachable by the U22 hit contract (see edit-session-adapter
  // header scope note); no snapshot is built for it here.
  return buildSnapshot({ vertices: [] });
}

/**
 * The ring a leaf vertex belongs to (for the U24 {@link DragSession} target /
 * slide containment). Resolves the feature at `time` and returns the FIRST ring
 * that cites `vertexId`, or undefined for a point / line vertex or an unresolved
 * feature. Shared so the dispatcher's `ringIdForVertex` dep and any slide query
 * agree on the ring (単一真実源). Pure.
 */
export function ringIdForLeafVertex(
  ctx: EditSnapshotContext,
  featureId: Feature['id'],
  vertexId: VertexId,
): RingId | undefined {
  const feature = featureByIdAt(ctx.getRoot(), ctx.getTime(), featureId);
  if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) return undefined;
  for (const ring of feature.shape.rings) {
    if (ring.vertexIds.includes(vertexId)) return ring.id;
  }
  return undefined;
}
