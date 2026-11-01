// 地物一覧（台帳）の材料を、いまのドメインから組み立てる（増分 4）。
//
// **ここが「一覧の母集団」の唯一の作り手**である。母集団は **その年に居る地物ぜんぶ**で、
// 表示条件で隠れているものは **行を残して 🚫 を付ける**（増分 4 の手直し B1 / 決定 (2)）。
// 一覧は「探す」ための場所なので、隠したものが消えると **隠したこと自体を取り消せなくなる**
// （設計書 §C.5「設定も解除もこの 1 か所」／ N-40 の再発）。隠れているかどうかの判定は
// 描画・当たり判定と同じ 1 本（`hiddenReasonsUnderFilter`）で、ここに別の規則を書かない
// （教訓 5.3 / 5.29）。「地物を検索」を一覧の絞り込みへ統合した（E-6）ので、母集団が
// 2 つある状態（N-41）は構造的に消えたままである。
//
// **代表点は重複名のものだけ計算する。** 775 件ぶんの頂点を毎回平均すると、行を
// 組み立てるたびに全頂点を走ることになる（実データで 5 万頂点級）。重複名は 12 件しか
// 無いので、そこだけ計算すれば足りる（設計書 §C.5 の 3 段目でしか使わない）。

import { FEATURE_KIND, featureDisplayName, type Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { getVertex, type VertexStore } from '../../domain/vertex';

import type { DomainFeatureKind } from './axes';
import type { LedgerFeature } from './ledger';
import type { HiddenReason } from './visibility';

/** 錨の本数を地物ごとに数える（自分の系列を持たない地物は 0）。 */
export function anchorCountsOf(root: DomainProject): Map<FeatureId, number> {
  const out = new Map<FeatureId, number>();
  for (const history of root.histories) {
    out.set(history.featureId, history.series.entries.length);
  }
  return out;
}

/**
 * 台帳の材料を組み立てる。**行は 1 つも落とさない**（渡された地物がそのまま行になる）。
 *
 * `hiddenReasons` は呼び出し側が渡す **単一の表示判定**（`hiddenReasonsUnderFilter`）の
 * 結果で、ここで別の判定を書かない。入っていれば「隠れている」、無ければ「見えている」。
 */
export function buildLedgerFeatures(input: {
  readonly features: readonly Feature[];
  readonly anchorCounts: ReadonlyMap<FeatureId, number>;
  readonly hiddenReasons: ReadonlyMap<FeatureId, HiddenReason>;
  readonly points: ReadonlyMap<FeatureId, { readonly lon: number; readonly lat: number }>;
}): LedgerFeature[] {
  const { features, anchorCounts, hiddenReasons, points } = input;
  const out: LedgerFeature[] = [];
  for (const f of features) {
    const reason = hiddenReasons.get(f.id) ?? null;
    out.push({
      id: f.id,
      name: featureDisplayName(f),
      kind: f.kind as DomainFeatureKind,
      kindLabel: f.kindLabel ?? '',
      parentId: f.parentId ?? null,
      color: f.color.fillColor,
      anchorCount: anchorCounts.get(f.id) ?? 0,
      hidden: reason !== null,
      hiddenReason: reason,
      point: points.get(f.id) ?? null,
    });
  }
  return out;
}

/** 表示名が 2 件以上ある名前を持つ地物の id（重複名の見分けが要るものだけ）。 */
export function duplicateNamedIds(features: readonly Feature[]): Set<FeatureId> {
  const counts = new Map<string, number>();
  for (const f of features) {
    const name = featureDisplayName(f);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const out = new Set<FeatureId>();
  for (const f of features) {
    if ((counts.get(featureDisplayName(f)) ?? 0) >= 2) out.add(f.id);
  }
  return out;
}

/**
 * 指定した地物の代表点を出す（重複名の 3 段目でだけ使う）。
 *
 * - 点情報 … その頂点
 * - 線情報 … 頂点の平均
 * - 面情報（末端） … いちばん外側のリングの頂点の平均
 * - 集約地物 … 子の代表点の平均（子が居なければ null）
 *
 * **正確な重心ではない**（面積重み付けをしない）。ここで要るのは「10 件の ???州 を
 * 目で見分けられる位置」であって測量値ではないので、頂点の平均で足りる。測量の
 * 数字を出す場所（`domain/survey`）とは目的が違うので、そちらの精度規則は持ち込まない。
 */
export function representativePoints(
  features: readonly Feature[],
  vertices: VertexStore,
  targets: ReadonlySet<FeatureId>,
): Map<FeatureId, { lon: number; lat: number }> {
  const byId = new Map<FeatureId, Feature>();
  for (const f of features) byId.set(f.id, f);
  const childrenOf = new Map<FeatureId, FeatureId[]>();
  for (const f of features) {
    const parentId = f.parentId;
    if (parentId === undefined) continue;
    const bucket = childrenOf.get(parentId);
    if (bucket === undefined) childrenOf.set(parentId, [f.id]);
    else bucket.push(f.id);
  }

  const memo = new Map<FeatureId, { lon: number; lat: number } | null>();

  const resolve = (
    id: FeatureId,
    seen: Set<FeatureId>,
  ): { lon: number; lat: number } | null => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // 教訓 5.28: 循環しても止まる。
    if (seen.has(id)) return null;
    seen.add(id);
    const feature = byId.get(id);
    if (feature === undefined) {
      memo.set(id, null);
      return null;
    }
    let point: { lon: number; lat: number } | null = null;
    switch (feature.kind) {
      case FEATURE_KIND.Point: {
        const v = getVertex(vertices, feature.vertexId);
        point = v === undefined ? null : { lon: v.coordinate.lon, lat: v.coordinate.lat };
        break;
      }
      case FEATURE_KIND.Line:
        point = averageOf(
          feature.vertexIds.map((vid) => getVertex(vertices, vid)?.coordinate ?? null),
        );
        break;
      case FEATURE_KIND.Leaf: {
        const ring = feature.shape.rings[0];
        point =
          ring === undefined
            ? null
            : averageOf(
                ring.vertexIds.map((vid) => getVertex(vertices, vid)?.coordinate ?? null),
              );
        break;
      }
      case FEATURE_KIND.Aggregate:
        point = averageOf(
          (childrenOf.get(id) ?? []).map((child) => resolve(child, seen)),
        );
        break;
    }
    memo.set(id, point);
    return point;
  };

  const out = new Map<FeatureId, { lon: number; lat: number }>();
  for (const id of targets) {
    const point = resolve(id, new Set());
    if (point !== null) out.set(id, point);
  }
  return out;
}

/** 平均（null は飛ばす。1 つも無ければ null）。 */
function averageOf(
  points: readonly ({ readonly lon: number; readonly lat: number } | null)[],
): { lon: number; lat: number } | null {
  let lon = 0;
  let lat = 0;
  let n = 0;
  for (const p of points) {
    if (p === null) continue;
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    lon += p.lon;
    lat += p.lat;
    n += 1;
  }
  if (n === 0) return null;
  return { lon: lon / n, lat: lat / n };
}
