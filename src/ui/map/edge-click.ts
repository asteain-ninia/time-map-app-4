// UI 層（地図）: 辺の中点を **クリック** しても頂点が増える（増分 8A の中身 4 / 現状分析 N-06）。
//
// **これまで**: 辺の中点の印（FR-87）は **ドラッグしないと頂点が増えなかった**。押して離すと
// 編集ドラッグの口が「クリックは編集ではない」として捨てていた（`edit-session-adapter` の
// `release(…, wasDrag=false)`）。中点の印は小さく、押せば増えると思うのが自然なので、
// 押して何も起きないのは行き止まりである。
//
// **決めた形**: 中点の印を押して動かさずに離したら、**その辺のちょうど中点**に頂点を 1 つ
// 足す（形は変わらない ―― 直線の真ん中に点が増えるだけ）。確定の経路はドラッグで足すときと
// 同じ 1 本（`confirmRelease` → 取り消しの 1 単位）なので、Ctrl+Z 1 回で戻る。
//
// 中点の座標は **描いている印と同じ** `computeHandles` の `midpoint` から引く（経度 ±180° を
// またぐ辺でも、描いた所と足す所が一致する。`handles.ts` の継ぎ目を考えた中点）。
// 押した点の座標は使わない ―― 掴める距離の中でずれた所に足すと、辺が折れて形が変わる。

import { computeHandles } from '../../domain/editing/handles';
import { EDIT_TOOL, type DragSession } from '../../domain/editing/index';
import type { WorldCoordinate } from '../../domain/coordinate';

import type { DisplayResolution } from './display-resolution-cache';

/**
 * 辺を足す操作（EdgeAdd）の対象の辺の中点。対象が辺を足す操作でない・地物や辺が
 * もう無い（古い）ときは undefined（足さない＝片落とし禁止、教訓 5.18）。
 */
export function edgeAddMidpoint(
  resolution: DisplayResolution,
  session: DragSession,
): WorldCoordinate | undefined {
  const target = session.target;
  if (target.tool !== EDIT_TOOL.EdgeAdd) return undefined;
  const feature =
    resolution.areaFeaturesById.get(target.featureId) ??
    resolution.features.find((f) => f.id === target.featureId);
  if (feature === undefined) return undefined;
  const edge = computeHandles(feature, resolution.vertices).edges.find(
    (e) =>
      e.startVertexId === target.startVertexId &&
      e.endVertexId === target.endVertexId &&
      (target.ringId === undefined || e.ringId === target.ringId),
  );
  return edge?.midpoint;
}
