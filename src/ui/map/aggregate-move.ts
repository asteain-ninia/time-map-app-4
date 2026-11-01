// ［動かす］で集約地物を引くときの計画を、地図の結線へ渡す 1 か所（所有者の裁定 2026-11-01）。
//
// 分類そのものは中核の `planAggregateMove`。ここはその年に居る地物を渡すのと、計画の覚えだけを持つ。
// 計画は全部の地物の参照を 1 回見る（実データで約 10 万件）。引いている間は毎コマ読むので、同じ地物の
// 並びと同じ集約地物なら計算し直さない。`featuresAt` は (根, 年) が同じなら同じ配列を返すので、
// 配列の同一性を鍵にすれば古い計画を返さない（読み方は `live-lookup.ts` の覚えと同じ）。

import { planAggregateMove, type AggregateMovePlan } from '../../domain/editing/move';
import { FEATURE_KIND } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { createVertexStore, getVertex, type Vertex, type VertexStore } from '../../domain/vertex';
import { featuresAt, verticesAt } from '../live-lookup';

/** 引いている間の計画と、下書きを描くのに要る頂点だけの表（全部の頂点を毎コマ写さない）。 */
export interface LiveAggregateMove {
  readonly plan: AggregateMovePlan;
  readonly vertices: VertexStore;
}

let memo: {
  readonly features: readonly unknown[];
  readonly store: VertexStore;
  readonly featureId: FeatureId;
  readonly value: LiveAggregateMove | undefined;
} | null = null;

/** `featureId` が `time` に居る集約地物なら、その計画を返す。そうでなければ undefined。 */
export function aggregateMoveAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): LiveAggregateMove | undefined {
  const features = featuresAt(root, time);
  const store = verticesAt(root, time);
  if (memo?.features === features && memo.store === store && memo.featureId === featureId) {
    return memo.value;
  }
  const value = features.some((f) => f.id === featureId && f.kind === FEATURE_KIND.Aggregate)
    ? build(featureId, features, store)
    : undefined;
  memo = { features, store, featureId, value };
  return value;
}

function build(
  featureId: FeatureId,
  features: Parameters<typeof planAggregateMove>[1],
  store: VertexStore,
): LiveAggregateMove {
  const plan = planAggregateMove(featureId, features);
  const bodies: Vertex[] = [];
  for (const id of [...plan.movingVertexIds, ...plan.fixedVertexIds]) {
    const body = getVertex(store, id);
    if (body !== undefined) bodies.push(body);
  }
  return { plan, vertices: createVertexStore(bodies) };
}

/** 引いて離したのに動かせないときの理由。動かせるなら null。 */
export const AGGREGATE_MOVE_BLOCK = {
  /** その年に下位領域が 1 つも居ない。 */
  NoLeaves: 'no-leaves',
  /** 下位領域の頂点が全部、外の地物と共有している。 */
  AllFixed: 'all-fixed',
} as const;
export type AggregateMoveBlock = (typeof AGGREGATE_MOVE_BLOCK)[keyof typeof AGGREGATE_MOVE_BLOCK];

export function aggregateMoveBlock(plan: AggregateMovePlan): AggregateMoveBlock | null {
  if (plan.leaves.length === 0) return AGGREGATE_MOVE_BLOCK.NoLeaves;
  if (plan.movingVertexIds.length === 0) return AGGREGATE_MOVE_BLOCK.AllFixed;
  return null;
}
