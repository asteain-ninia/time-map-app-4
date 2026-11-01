// ［動かす］で集約地物を引くときの計画を、地図の結線へ渡す 1 か所（所有者の裁定 2026-11-01）。
//
// 分類そのものは中核の `planAggregateMove`。ここはその年に居る地物を渡すのと、計画の覚えだけを持つ。
// 計画は全部の地物の参照を 1 回見る（実データで約 10 万件）。引いている間は毎コマ読むので、同じ地物の
// 並びと同じ集約地物なら計算し直さない。`featuresAt` は (根, 年) が同じなら同じ配列を返すので、
// 配列の同一性を鍵にすれば古い計画を返さない（読み方は `live-lookup.ts` の覚えと同じ）。

import { planAggregateMove, type AggregateMovePlan } from '../../domain/editing/move';
import { FEATURE_KIND, referencedVertexIds } from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { createVertexStore, getVertex, type Vertex, type VertexStore } from '../../domain/vertex';
import { featuresAt, verticesAt } from '../live-lookup';
import { APP_STRINGS } from '../shell/strings';

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

/** 集約地物を動かした確定の、実際の結果の数。 */
export interface AggregateMoveResult {
  /** 動いて、重なりの解決で削られなかった下位領域の数。 */
  readonly movedLeafCount: number;
  /** 重なりの解決で形を削られた下位領域の数。 */
  readonly trimmedLeafCount: number;
  /** 動かさなかった共有頂点のうち、確定の形がまだ引いている数。 */
  readonly fixedVertexCount: number;
}

/** 重なりの解決を通らない確定の結果（計画のとおり）。 */
export function directAggregateMoveResult(plan: AggregateMovePlan): AggregateMoveResult {
  return {
    movedLeafCount: plan.movedLeafCount,
    trimmedLeafCount: 0,
    fixedVertexCount: plan.fixedVertexIds.length,
  };
}

/**
 * 重なりの解決を通った確定の結果を、確定の前後の根から数える。頂点が動くだけなら面の `shape` は同じ
 * オブジェクトのままで、解決が削ると新しい `shape` になる。押した年だけでなく、書き換わった後の年の
 * 錨も見る（後の年にだけ重なる相手のために、その年から削ることがある）。
 */
export function resolvedAggregateMoveResult(
  before: DomainProject,
  after: DomainProject,
  time: TimePoint,
  plan: AggregateMovePlan,
): AggregateMoveResult {
  const leafIds = new Set<FeatureId>(plan.leaves.map((leaf) => leaf.id));
  const trimmed = new Set<FeatureId>();
  const beforeById = new Map(before.histories.map((h) => [h.featureId, h]));
  for (const history of after.histories) {
    const priorHistory = beforeById.get(history.featureId);
    if (priorHistory === history) continue;
    const priorAnchors = new Set(priorHistory?.series.entries.map((e) => e.anchor) ?? []);
    for (const entry of history.series.entries) {
      if (priorAnchors.has(entry.anchor)) continue;
      for (const feature of entry.anchor.snapshot.features) {
        if (!leafIds.has(feature.id) || feature.kind !== FEATURE_KIND.Leaf || trimmed.has(feature.id)) continue;
        const prior = featuresAt(before, entry.start).find((f) => f.id === feature.id);
        if (prior === undefined || prior.kind !== FEATURE_KIND.Leaf || prior.shape !== feature.shape) {
          trimmed.add(feature.id);
        }
      }
    }
  }
  const moving = new Set<VertexId>(plan.movingVertexIds);
  const movedLeafCount = plan.leaves.filter(
    (leaf) => !trimmed.has(leaf.id) && referencedVertexIds(leaf).some((id) => moving.has(id)),
  ).length;
  const cited = new Set<VertexId>();
  for (const feature of featuresAt(after, time)) {
    if (leafIds.has(feature.id)) for (const id of referencedVertexIds(feature)) cited.add(id);
  }
  return {
    movedLeafCount,
    trimmedLeafCount: trimmed.size,
    fixedVertexCount: plan.fixedVertexIds.filter((id) => cited.has(id)).length,
  };
}

/**
 * 頂点や面を動かした確定に添える文。直接の確定と重なりの解決を通った確定が同じ 1 本を通るので、言うことが
 * 揃う。`carried` は後の年の記録へ引き継いだ本数（無ければ null）。
 */
export function editCommitNote(
  aggregate: AggregateMoveResult | null,
  carried: { readonly fromYear: number; readonly toYear: number; readonly anchorCount: number } | null,
): string {
  const parts: string[] = [];
  if (aggregate !== null) {
    parts.push(APP_STRINGS.moveAggregateDone(aggregate.movedLeafCount, aggregate.fixedVertexCount));
    if (aggregate.trimmedLeafCount > 0) parts.push(APP_STRINGS.moveAggregateTrimmed(aggregate.trimmedLeafCount));
  }
  if (carried !== null) {
    parts.push(APP_STRINGS.vertexCarriedForwardSentence(carried.fromYear, carried.toYear, carried.anchorCount));
  }
  return parts.join('');
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
