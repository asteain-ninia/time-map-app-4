// B39 — 面を足した確定の **後始末の決め方**と、まとめ役の下に足したときの後始末の組み立て。
//
// 追加の確定（直接の確定・重なりの板を通った確定の両方）は、ここで決めた 1 つの答えに従う
// （B39 の手直し 2 回目 / 検証 3-1: 入口が 2 つあると、片方だけ後始末を通らず、重なりの検出から
// 外したのに分け残しを削らない、が起きた）。重なりの検出から外すか（`consistency-binding.ts`）も
// 同じ答えを読む ―― 後始末が分け残しを削るときだけ外す。
//
//   - 親が形を持つ末端 → 集約化（所属変更と同じ経路。分け残しを作る）。ただし親が **それより
//     後ろの年に** 印のある分け残しを既に持っていたら（1 人目より前の年へさかのぼって描いた）、
//     後始末はせず従来の形に落とす（開き直しの修復で整える。検証 2-2）。
//   - 親がまとめ役 → 分け残しを削り、子の並びを揃える（{@link settleAddUnderAggregate}）。
//   - それ以外（上位領域なし・点や線） → 何もしない。
//
// 純粋。年ごとの姿は全系列の束（その年に効いている錨の地物と頂点）で読む。

import { resolveAt } from '../anchor-series';
import { FEATURE_KIND, isDirectDomainLeaf, type Feature } from '../feature';
import type { FeatureId } from '../ids';
import type { IdGeneratorState, TimeSource } from '../id-generator';
import type { DomainProject } from '../persistence/serialize';
import { planDirectDomainCarves } from '../promotion/carve';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import { createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { applyAddUnderAggregate, type DirectDomainCarveStep } from './apply-proposal';

export const ADD_FOLLOW_UP = {
  /** 後始末なし。 */
  None: 'none',
  /** 親（形を持つ末端）を集約化する。 */
  Promote: 'promote',
  /** 親（まとめ役）の分け残しを削り、子の並びを揃える。 */
  Settle: 'settle',
  /** 後始末をせず、開き直しの修復に任せる（さかのぼって描いた形）。 */
  Defer: 'defer',
} as const;

export type AddFollowUpKind = (typeof ADD_FOLLOW_UP)[keyof typeof ADD_FOLLOW_UP];

/** その年の姿（全系列の束）。 */
export function stateAt(
  root: DomainProject,
  at: TimePoint,
  calendar: Calendar,
): { readonly features: readonly Feature[]; readonly vertices: VertexStore } {
  const features: Feature[] = [];
  const vertices: Vertex[] = [];
  for (const history of root.histories) {
    const r = resolveAt(history.series, at, calendar);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) features.push(f);
    for (const v of r.entry.anchor.snapshot.vertices.byId.values()) vertices.push(v);
  }
  return { features, vertices: createVertexStore(vertices) };
}

/** `parentId` の印のある分け残しが載っている錨の始まりのうち、`at` より後ろのもの（昇順・重複なし）。 */
function laterDirectDomainStarts(
  root: DomainProject,
  parentId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): TimePoint[] {
  const out: TimePoint[] = [];
  for (const history of root.histories) {
    for (const entry of history.series.entries) {
      if (compare(entry.start, at, calendar) <= 0) continue;
      const has = entry.anchor.snapshot.features.some(
        (f) => isDirectDomainLeaf(f) && f.parentId === parentId,
      );
      if (!has) continue;
      if (out.some((t) => compare(t, entry.start, calendar) === 0)) continue;
      out.push(entry.start);
    }
  }
  return out.sort((a, b) => compare(a, b, calendar));
}

/**
 * `childId`（`root` には既に足してある）の確定の後始末を決める。`root` は追加を当てた後の状態、
 * `at` は追加の年。
 */
export function addFollowUpKind(
  root: DomainProject,
  childId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): AddFollowUpKind {
  return followUpFrom(stateAt(root, at, calendar).features, root, childId, at, calendar);
}

/** {@link addFollowUpKind} の本体（その年の地物を既に持っている呼び手のため）。 */
export function followUpFrom(
  featuresAtT: readonly Feature[],
  root: DomainProject,
  childId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): AddFollowUpKind {
  const child = featuresAtT.find((f) => f.id === childId);
  const parentId = child?.parentId;
  if (parentId === undefined) return ADD_FOLLOW_UP.None;
  const parent = featuresAtT.find((f) => f.id === parentId);
  if (parent === undefined) return ADD_FOLLOW_UP.None;
  if (parent.kind === FEATURE_KIND.Aggregate) return ADD_FOLLOW_UP.Settle;
  if (parent.kind !== FEATURE_KIND.Leaf) return ADD_FOLLOW_UP.None;
  // 1 人目より前の年へさかのぼって描いた: この年ではまだ形を持つ末端だが、後ろの年には既に
  // 分け残しがある。ここで集約化すると分け残しが 2 つになって重なる（検証 2-2）ので、直さずに
  // 従来の形（開き直しの修復で整える）へ落とす。
  if (laterDirectDomainStarts(root, parentId, at, calendar).length > 0) return ADD_FOLLOW_UP.Defer;
  return ADD_FOLLOW_UP.Promote;
}

/**
 * **まとめ役の下に足した面の後始末**を組み立てて当てる（{@link ADD_FOLLOW_UP.Settle}）。
 *
 * 1. 子を描いた年 `at` に、重なった分け残しを削る。
 * 2. 分け残しの **後ろの錨**のうち、新しい子がまだ居る錨の始まりにも同じ削りを入れる
 *    （検証 2-1: 100・300・200 年の順に描くと、200 年の削りが 300 年の錨に入らず重なった）。
 *    子が居なくなった年から先へは持ち込まない。
 * 3. 子の並びを揃える（居候の親は先に自分の系列へ起こす）。
 *
 * 親が `at` にまとめ役でなければ null。新しく採る id は、プロジェクトの全部の年の地物・頂点の
 * id と、年をまたいで採った id のどれとも重ならない。
 */
export function settleAddUnderAggregate(
  root: DomainProject,
  childId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
  ids: { readonly idState: IdGeneratorState; readonly now: TimeSource },
): DomainProject | null {
  const atT = stateAt(root, at, calendar);
  if (followUpFrom(atT.features, root, childId, at, calendar) !== ADD_FOLLOW_UP.Settle) return null;
  const parentId = atT.features.find((f) => f.id === childId)!.parentId!;

  const reserved = new Set<string>();
  for (const history of root.histories) {
    reserved.add(history.featureId);
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) reserved.add(f.id);
      for (const v of entry.anchor.snapshot.vertices.byId.keys()) reserved.add(v);
    }
  }
  const options = { idState: ids.idState, now: ids.now, reserved };

  const steps: DirectDomainCarveStep[] = [
    { at, carves: planDirectDomainCarves(atT.features, atT.vertices, childId, options) },
  ];
  for (const s of laterDirectDomainStarts(root, parentId, at, calendar)) {
    const later = stateAt(root, s, calendar);
    if (!later.features.some((f) => f.id === childId)) break; // 子が居なくなった年から先へは持ち込まない
    steps.push({ at: s, carves: planDirectDomainCarves(later.features, later.vertices, childId, options) });
  }
  return applyAddUnderAggregate(root, parentId, steps, calendar);
}
