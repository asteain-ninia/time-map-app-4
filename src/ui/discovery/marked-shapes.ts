// UI layer（一覧の印 → 地図の対象色）: **印を付けた地物を地図に出すための形を解く**
//（設計書 §D.5 / 反証 1-2）。
//
// **これが直すもの**: 対象色は面（末端）の形しか解いていなかったので、集約地物・点情報・
// 線情報に印を付けても **地図には何も出なかった**。印は「いま何をまとめて直そうと
// しているか」を見せるためのものなので、出ないと印を付けた実感が無い。
//
// 解き方は種別ごとに違う（設計書 §D.5 の「集約地物は子の外周で、点・線は自分の描画で」）:
//   - 末端（面） … 自分の形をそのまま。
//   - 集約地物   … **下位領域（末端まで）それぞれの形**を出す。集約地物は自分の形を
//                  持たない（FR-35）ので、和を取り直すのではなく子の外周を並べる
//                  ―― 和は 400 件規模で重く、見た目もほぼ同じである。
//   - 点情報     … その頂点の位置。
//   - 線情報     … 頂点の列（2 点以上）。
//
// 純粋（framework-free）。描画の色や太さは持たない（`buildMarkedHighlight` の仕事）。

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import { buildForest, directChildIds } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import type { TimePoint } from '../../domain/time/time-point';
import type { GeoMultiPolygon } from '../../domain/geometry/index';
import { featuresAt, leafShapeAt, verticesAt } from '../live-lookup';

/** 地図へ押し込むための、印の形の一式。 */
export interface MarkedDrawInputs {
  readonly markedShapes: readonly (GeoMultiPolygon | undefined)[];
  readonly markedPoints: readonly ({ readonly lon: number; readonly lat: number } | undefined)[];
  readonly markedLines: readonly (
    | readonly { readonly lon: number; readonly lat: number }[]
    | undefined
  )[];
}

const EMPTY: MarkedDrawInputs = { markedShapes: [], markedPoints: [], markedLines: [] };

/** 集約地物を **末端まで**辿る（子の外周で出すため）。壊れたデータでも有限で終わる。 */
function leavesUnder(
  features: readonly Feature[],
  featureId: FeatureId,
): readonly FeatureId[] {
  const forest = buildForest(features);
  const out: FeatureId[] = [];
  const visited = new Set<FeatureId>();
  const queue: FeatureId[] = [featureId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const children = directChildIds(forest, id);
    if (children.length === 0) {
      if (id !== featureId) out.push(id);
      continue;
    }
    queue.push(...children);
  }
  return out;
}

/**
 * 印を付けた地物を地図に出すための形を、種別ごとの解き方で解く。
 * 居ない地物は黙って飛ばす（`undefined` は「出すものが無い」＝教訓 5.18）。
 */
export function markedDrawInputs(
  root: DomainProject,
  time: TimePoint,
  markedIds: Iterable<FeatureId>,
): MarkedDrawInputs {
  const ids = [...markedIds];
  if (ids.length === 0) return EMPTY;

  const features = featuresAt(root, time);
  const byId = new Map<FeatureId, Feature>(features.map((f) => [f.id, f]));
  const store = verticesAt(root, time);

  const shapes: (GeoMultiPolygon | undefined)[] = [];
  const points: ({ readonly lon: number; readonly lat: number } | undefined)[] = [];
  const lines: (readonly { readonly lon: number; readonly lat: number }[] | undefined)[] = [];

  for (const id of ids) {
    const feature = byId.get(id);
    if (feature === undefined) continue;
    switch (feature.kind) {
      case FEATURE_KIND.Leaf:
        shapes.push(leafShapeAt(root, time, id));
        break;
      case FEATURE_KIND.Aggregate:
        for (const leafId of leavesUnder(features, id)) {
          shapes.push(leafShapeAt(root, time, leafId));
        }
        break;
      case FEATURE_KIND.Point: {
        const v = store.byId.get(feature.vertexId);
        if (v !== undefined) points.push(v.coordinate);
        break;
      }
      case FEATURE_KIND.Line: {
        const pts = feature.vertexIds
          .map((vid) => store.byId.get(vid)?.coordinate)
          .filter((c): c is { readonly lon: number; readonly lat: number } => c !== undefined);
        if (pts.length >= 2) lines.push(pts);
        break;
      }
    }
  }

  return { markedShapes: shapes, markedPoints: points, markedLines: lines };
}
