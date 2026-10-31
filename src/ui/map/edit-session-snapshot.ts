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
  moveDraggedVertexSet,
  moveFeatureVertices,
} from '../../domain/editing/move';
import { addVertexToLeafRing, addVertexToLine } from '../../domain/editing/edit-ops';
import { createVertex, withVertexCoordinate, type Vertex } from '../../domain/vertex';
import {
  buildSnapshot,
  decideSharePairAtRelease,
  type FeatureSnapshot,
  type MovingRing,
} from '../../domain/editing/edit-flow';
import { movingVertexIds } from '../../domain/editing/drag-session';
import { storedCoordinate, unwrapRing, unwrapRingClosed } from '../../domain/geo/seam';
import { getVertex } from '../../domain/vertex';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { Feature } from '../../domain/feature';
import { FEATURE_KIND } from '../../domain/feature';
import type { RingId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { featureByIdAt, verticesAt } from '../live-lookup';

/**
 * 保存する頂点の体の経度を [-180, 180) へ畳む（B80・B113）。頂点のドラッグ・面の移動・辺への追加は
 * 全部ここを通す。
 *
 * ドラッグの座標は連続の経度で、継ぎ目を越えれば 181° や 184° になり、±360° の複製の上なら 538° にも
 * なる。**確定の関門は押した所の巻きで移動量を見る**ので、`session.preview` と `buildMovingRings` は
 * 畳まない（畳むと「半周以上」の誤判定が戻る）。畳むのは保存する体だけである。輪は隣り合う頂点を最短の
 * 向きでつなぐので、畳んでも形は変わらない。
 *
 * 畳み方は {@link storedCoordinate} の 1 本。
 */
function storedBody(vertex: Vertex): Vertex {
  const stored = storedCoordinate(vertex.coordinate);
  return stored === vertex.coordinate ? vertex : withVertexCoordinate(vertex, stored);
}

/** 確定する提案の材料を組み立てる。頂点の体はここで保存の形に畳む（{@link storedBody}）。 */
function storedSnapshot(input: Parameters<typeof buildSnapshot>[0]): FeatureSnapshot {
  return buildSnapshot({ ...input, vertices: input.vertices.map(storedBody) });
}

/** The live domain context the snapshot is built against (read fresh per release). */
export interface EditSnapshotContext {
  /** The current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainProject;
  /** The editing-base / current timeline time recorded as the anchor (FR-57). */
  readonly getTime: () => TimePoint;
}

/**
 * Build the complete after-state {@link FeatureSnapshot} for a confirming edit
 * release. The session's `target` decides which vertices moved / were added:
 *   - VertexMove → the single dragged vertex to its final `preview` (FR-88).
 *   - FeatureMove → every vertex of the feature by the drag delta (FR-88 平行移動).
 *   - EdgeAdd → a NEW vertex inserted on the pressed edge at the final `preview`
 *     (FR-87), with the feature's id list rewritten by the domain add ops.
 * For a move the feature record is unchanged (ids / structure are stable) and only
 * the vertex bodies carry new coordinates; for an edge-add the feature record's id
 * list gains the new vertex. When the feature / vertices / edge cannot be resolved
 * at the time (stale data) an EMPTY snapshot is returned, which `confirmRelease`
 * treats as a no-op (片落とし禁止 — never a half edit, 教訓5.18).
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
    // FR-80: the primary lands on its final (slid / snapped) preview and every companion
    // rides the SAME vector — ONE snapshot, therefore ONE consistency process and ONE
    // undo unit (FR-80「単一の編集操作として扱う」). The vector math is the domain's
    // single source (`moveDraggedVertexSet`), shared verbatim with the live preview store
    // in active-feature-handles, so what the user saw mid-drag is what commits (教訓 5.29).
    const moved = moveDraggedVertexSet(
      session.target.vertexId,
      session.companionVertexIds,
      store,
      session.preview,
    );
    if (moved === undefined) return buildSnapshot({ vertices: [] });
    // 受け入れ基準12 / FR-31: forward a snap that survived to release as the decided
    // share pair so the apply op collapses the dragged vertex onto its target (the
    // SINGLE U24→U11 hand-off; decideSharePairAtRelease drops a lapsed candidate).
    // The share pair names the PRIMARY only — companions never snap (see the adapter's
    // applyMove), so a multi-vertex drag can share at most the grabbed vertex.
    const sharePair = decideSharePairAtRelease(session);
    return storedSnapshot({ feature, vertices: moved, sharePair });
  }

  if (session.target.tool === EDIT_TOOL.FeatureMove) {
    const delta = dragDelta(session);
    const moved = moveFeatureVertices(feature, store, { dLon: delta.dLon, dLat: delta.dLat });
    return storedSnapshot({ feature, vertices: moved });
  }

  if (session.target.tool === EDIT_TOOL.EdgeAdd) {
    // Add a NEW vertex on the pressed edge (FR-87). The structural id-list insert is the
    // domain's SINGLE source (addVertexToLine / addVertexToLeafRing — the same ops the
    // edge-handle add reuses, 教訓 5.30): they rewrite the feature's vertex/ring id list
    // to place `newVertexId` between the edge's two endpoints. We build the new vertex
    // BODY at the drag's final `preview` position, so the confirmed snapshot carries both
    // the rewritten feature record AND the new coordinate the U13 ports merge (FR-59 一体
    // 編集). A stale edge (endpoints no longer adjacent) or a leaf without the named ring
    // yields undefined → an EMPTY snapshot (片落とし禁止 — no half insert, 教訓 5.18); a
    // point has no edge at all.
    const { startVertexId, endVertexId, newVertexId } = session.target;
    const newVertex = createVertex(newVertexId, session.preview);
    let result;
    if (feature.kind === FEATURE_KIND.Line) {
      result = addVertexToLine(feature, startVertexId, endVertexId, newVertexId);
    } else if (feature.kind === FEATURE_KIND.Leaf && session.target.ringId !== undefined) {
      result = addVertexToLeafRing(
        feature,
        session.target.ringId,
        startVertexId,
        endVertexId,
        newVertexId,
      );
    }
    if (result === undefined || result.kind !== 'feature') return buildSnapshot({ vertices: [] });
    // 受け入れ基準12 / FR-31: a snap that survived to release shares the new vertex onto
    // its target (the reserved id is the session's dragged vertex, so decideSharePairAtRelease
    // resolves it exactly like a vertex-move).
    const sharePair = decideSharePairAtRelease(session);
    // 増分 8A の手直し（反証 重 2）: 足した辺を隣と共有していれば、隣の輪にも同じ頂点を
    // 入れる（`applyEditProposal` が行う）。そのための「どの辺に何を足したか」を渡す。
    // クリックで足す（N-06）ときもドラッグで足す（FR-87）ときも同じ 1 本を通る。
    return storedSnapshot({
      feature: result.feature,
      vertices: [newVertex],
      sharePair,
      edgeInsert: { startVertexId, endVertexId, vertexId: newVertexId },
    });
  }

  // No other tool builds a snapshot here (drag-session is exhaustive over EDIT_TOOL).
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

/**
 * 確定の関門（A5）が読む「動かす前のリング」を組み立てる（増分 3 の手直し 2 回目）。
 *
 * **なぜ要るのか**: 移動量だけを見る関門は、1 回の移動が 180 度未満でも
 * **動かした先が隣の頂点から見て 180 度以上**になる形を通してしまう（実測: 160 度の
 * 移動で経度差 211.8 度の辺ができ、そのまま保存された）。結果の辺そのものを
 * `longEdgeStartIndexes`（追加の道具と同じ 1 本）に掛けるには、動かす前の並びが要る。
 *
 * **連続経度で返す**。保存されている代表値のままだと、日付変更線をまたぐ正しい地物
 * （179 度 → −179 度）が 358 度の差に見えて誤爆する。画面に見えている並び＝連続へ
 * 戻した列に対して測るのが、利用者の意図と一致する唯一の測り方である。
 *
 * **地物ごと動かすときは空を返す**。全部の頂点が同じだけ動くので、辺の長さは 1 本も
 * 変わらない（測る意味が無い）。辺を持たない点情報も空である。
 */
export function buildMovingRings(
  ctx: EditSnapshotContext,
  session: DragSession,
): readonly MovingRing[] {
  if (session.target.tool === EDIT_TOOL.FeatureMove) return [];
  const root = ctx.getRoot();
  const time = ctx.getTime();
  const feature = featureByIdAt(root, time, session.target.featureId);
  if (feature === undefined) return [];
  const store = verticesAt(root, time);
  const moving = movingVertexIds(session);

  const out: MovingRing[] = [];
  const push = (ids: readonly VertexId[], closed: boolean): void => {
    const coordinates: WorldCoordinate[] = [];
    const movingIndexes: number[] = [];
    for (const id of ids) {
      const v = getVertex(store, id);
      // 解けない頂点が 1 つでもあるリングは測らない（欠けた並びで測ると嘘になる）。
      if (v === undefined) return;
      coordinates.push(v.coordinate);
      if (moving.has(id)) movingIndexes.push(coordinates.length - 1);
    }
    // 動く頂点が 1 つも無いリングは、このドラッグでは形が変わらない（教訓 5.18: 長さで決める）。
    if (coordinates.length < 2 || movingIndexes.length === 0) return;
    out.push({
      coordinates: closed ? unwrapRingClosed(coordinates) : unwrapRing(coordinates),
      closed,
      movingIndexes,
    });
  };

  if (feature.kind === FEATURE_KIND.Leaf) {
    for (const ring of feature.shape.rings) push(ring.vertexIds, true);
  } else if (feature.kind === FEATURE_KIND.Line) {
    push(feature.vertexIds, false);
  }
  return out;
}
