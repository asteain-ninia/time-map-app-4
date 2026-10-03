// B39 の直し — 分け残し（直轄領）の中に新しい子を描いたとき、分け残しのほうを削る。
//
// **何のためにあるか**: 面の中に 1 人目の子を描いて確定すると、その面は形を持たない
// まとめ役になり、残りの土地は **分け残し**（印 `directDomain` のある末端）へ移る
// （FR-37。所属変更と同じ経路）。2 人目の子は分け残しの中に描くことになるが、親にするのは
// 分け残しではなく **まとめ役**である（入れ子の既定。分け残しを親にすると「分け残しの
// 分け残し」の鎖ができる ―― `docs/現状.md` の旧 B39）。そのままだと、2 人目と分け残しが
// 兄弟の末端どうしで **面積を持って重なる**（FR-26 の末端排他に反する）ので、次に開いた
// ときの整合の検査が「重なり」を出し、修復は片方を外そうとする。
//
// だから 2 人目以降の確定では、**分け残し ← 分け残し − 新しい子** に削る。これは読み込み時の
// 修復が子を全部足し終えてから 1 回だけ作る分け残し（元の形 − 子の和）と同じ形になる ――
// 1 人目で「元の形 − 子1」、2 人目で「(元の形 − 子1) − 子2」…と、順に引いていくだけである。
//
// 純粋（入力を壊さない）。差分の計算と輪の組み立ては直轄領の生成と同じ 1 本
// （`buildDirectDomainShape` と U06 の差分）を通す（教訓 5.29）。

import {
  FEATURE_KIND,
  commonOptionalOf,
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import { alignMultiPolygon, referenceLonForMultiPolygon } from '../geo/index';
import {
  difference as geoDifference,
  intersection as geoIntersection,
  isMultiPolygonEmpty,
  isOk,
} from '../geometry/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { asRingId, asVertexId, type FeatureId } from '../ids';
import { nextRawId, type IdGeneratorState, type TimeSource } from '../id-generator';
import type { Vertex, VertexStore } from '../vertex';

import { buildDirectDomainShape } from './direct-domain';

/** 分け残し 1 つぶんの削り。 */
export interface DirectDomainCarve {
  readonly directDomainId: FeatureId;
  /**
   * 削ったあとの分け残し（id・名前・色・印・上位領域はそのまま、形だけが変わる）。
   * **null なら新しい子が分け残しを覆い尽くした**ので、その年から分け残しを消す
   * （空の末端は残せない）。
   */
  readonly after: LeafFeature | null;
  /** 削ったあとの形が引く頂点の体（使い回した元の頂点も含む）。 */
  readonly newVertices: readonly Vertex[];
}

export interface PlanDirectDomainCarveOptions {
  readonly idState: IdGeneratorState;
  readonly now: TimeSource;
  /**
   * 採番で避ける id の集合（共有して使い回す）。渡せば、その年の地物・頂点に加えてここに
   * 載っている id も避け、新しく採った id をここへ足す。複数の年の錨を続けて削るとき、
   * 年をまたいで同じ id を 2 度採らないために使う（B39 の手直し 2 回目）。
   */
  readonly reserved?: Set<string>;
}

/**
 * `childId`（いま足した末端）が **まとめ役の子**で、同じまとめ役の分け残しと面積を持って
 * 重なっているなら、その分け残しを削る案を返す。重なりが無い・形が解けない・親が
 * まとめ役でないときは空配列（何もしない）。
 *
 * `features` / `vertices` は **子を足したあと**のその年の姿である。
 */
export function planDirectDomainCarves(
  features: readonly Feature[],
  vertices: VertexStore,
  childId: FeatureId,
  options: PlanDirectDomainCarveOptions,
): readonly DirectDomainCarve[] {
  const child = features.find((f) => f.id === childId);
  if (child === undefined || child.kind !== FEATURE_KIND.Leaf) return [];
  const parentId = child.parentId;
  if (parentId === undefined) return [];
  const parent = features.find((f) => f.id === parentId);
  if (parent === undefined || parent.kind !== FEATURE_KIND.Aggregate) return [];
  const childShape = resolveLeafShape(child.shape, vertices);
  if (childShape === undefined) return [];

  // 採番の衝突を避ける（教訓 5.37。所属変更の採番と同じ形）。
  const existing = options.reserved ?? new Set<string>();
  for (const f of features) existing.add(f.id);
  for (const v of vertices.byId.keys()) existing.add(v);
  let gen = options.idState;
  const mint = (prefix: string): string => {
    const r = nextRawId(prefix, gen, options.now, existing);
    gen = r.state;
    existing.add(r.value);
    return r.value;
  };

  const carves: DirectDomainCarve[] = [];
  for (const f of features) {
    if (f.id === childId || f.parentId !== parentId || !isDirectDomainLeaf(f)) continue;
    if (f.kind !== FEATURE_KIND.Leaf) continue; // 型の絞り込み（印は末端にしか立たない）。
    const ddShape = resolveLeafShape(f.shape, vertices);
    if (ddShape === undefined) continue;
    // 経度の継ぎ目を揃えてから比べる（直轄領の生成と同じ。継ぎ目を跨がなければ恒等）。
    const ref = referenceLonForMultiPolygon(ddShape);
    const dd = alignMultiPolygon(ddShape, ref);
    const cut = alignMultiPolygon(childShape, ref);
    const overlap = geoIntersection(dd, cut);
    // 面積を持って重ならない（境界で接するだけ・離れている）なら削らない。
    if (!isOk(overlap) || isMultiPolygonEmpty(overlap.result)) continue;
    const diff = geoDifference(dd, cut);
    if (!isOk(diff)) continue; // 差分が解けなければ触らない（壊すより残す）。
    if (isMultiPolygonEmpty(diff.result)) {
      carves.push({ directDomainId: f.id, after: null, newVertices: [] });
      continue;
    }
    const own: Vertex[] = [];
    for (const ring of f.shape.rings) {
      for (const vid of ring.vertexIds) {
        const body = vertices.byId.get(vid);
        if (body !== undefined) own.push(body);
      }
    }
    const built = buildDirectDomainShape(
      diff.result,
      { nextVertexId: () => asVertexId(mint('v')), nextRingId: () => asRingId(mint('r')) },
      own,
    );
    if (built === undefined) continue;
    carves.push({
      directDomainId: f.id,
      after: createLeafFeature(f.id, f.attributes, f.color, built.shape, commonOptionalOf(f)),
      newVertices: built.vertices,
    });
  }
  return carves;
}
