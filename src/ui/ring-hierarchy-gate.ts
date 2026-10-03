// UI layer (U44 binding): 穴・飛び地の形を壊す編集を **確定の前に** 止める関門（増分 8E / G-14）。
//
// **これが直すもの**（現状分析 §6.2 の G-14、§11-5 の申し送り）: 穴・飛び地の頂点の移動・
// 追加・削除は `domain/editing/edit-ops` を直接呼ぶので、U07 の環の整合（包含・非交差・
// 非重複）を確定前に通っていなかった。増分 8E の探針（実機の E2E）で確かめた結果:
//   - 穴の頂点を **親の外周の外** へ引き出す → 通らない（ドラッグ中の拘束が外周の縁で止める）
//   - 穴の頂点を **隣の穴の中** へ入れる → **通ってしまう**。穴どうしの辺が交わった形が
//     「素性の変更を行いました」で記録された（ドラッグ中の拘束は外周しか見ていない）
// 編集の束ね（`createLiveEditBinding`）の `checkConstraints` が空を返していたのが根で、
// 確定の手続き（U13）の「編集制約の再検証」が素通りだった。ここがその中身である。
//
// 判定は輪郭の道具と **同じ 1 本**（`validateCandidate` → U07 `validateRingHierarchy`）を通す
// （教訓 5.26 / 5.29: 実時間の判定と確定前の判定を同じ関数にする）。
//
// **新しく壊したものだけを止める。** 編集の前から整合していなかった形（古いデータ）は、
// 名前を直しただけで保存できなくなると困るので止めない ―― 「この編集で壊れたか」を
// 編集の前の同じ地物と比べて決める（所有者の裁定「削除以外でデータが勝手に消えるのは
// 良くない」の裏側: 直していないものを理由に、関係のない編集を断らない）。

import type { RejectedResult } from '../domain/consistency/index';
import { FEATURE_KIND, type LeafFeature } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import { validateCandidate } from '../domain/ring-edit/index';
import type { RingViolation } from '../domain/ring-hierarchy';
import type { TimePoint } from '../domain/time/time-point';

import { featuresAt, verticesAt } from './live-lookup';

/** 違反の印（確定の手続きの `detail` に入る。画面の文を選ぶのに使う）。 */
export const RING_HIERARCHY_GATE_KIND = 'ring-hierarchy' as const;

/** この編集で新しく壊れた面 1 つぶんの違反。 */
export interface RingHierarchyGateViolation {
  readonly kind: typeof RING_HIERARCHY_GATE_KIND;
  readonly featureId: FeatureId;
  readonly at: TimePoint;
  readonly violations: readonly RingViolation[];
}

/** 画面に出す文（何が起きたか → なぜか → 次に何をするか。設計書 §H.5）。 */
export const RING_HIERARCHY_GATE_STRINGS = {
  refused:
    '動かした形を確定しませんでした。穴・飛び地が外周や別の穴・飛び地と交わる形になるためです。交わらない位置まで動かしてください。',
} as const;

function isLeaf(feature: { readonly kind: string }): feature is LeafFeature {
  return feature.kind === FEATURE_KIND.Leaf;
}

/**
 * 環が 2 つ以上ある面だけが、環どうしの関係（包含・交差・重なり）を持つ。外周 1 つだけの
 * 面は調べても違反が出ないので、ここで飛ばす（実データの大半はこれで、確定のたびに
 * 全頂点を引き直す費用を払わずに済む）。
 */
function hasRingRelations(feature: LeafFeature): boolean {
  return feature.shape.rings.length >= 2;
}

/**
 * `before`（編集の前）から `after`（確定しようとしている姿）で **新しく壊れた面** を返す。
 * 空なら通す。
 *
 * 見るのは「参照が変わった系列の、参照が変わった錨」だけである（ドメインは不変なので、
 * 触っていない系列・錨は同じ参照のまま残る）。その錨に載っている面のうち環を 2 つ以上
 * 持つものを、その錨の年の姿で U07 に掛ける。壊れていたら、編集の前の同じ年の同じ面も
 * 掛け、そちらも壊れていたら（古いデータ）止めない。
 */
export function ringHierarchyViolationsIntroduced(
  before: DomainProject,
  after: DomainProject,
): RingHierarchyGateViolation[] {
  if (before === after) return [];
  const beforeById = new Map<FeatureId, FeatureHistory>();
  for (const h of before.histories) beforeById.set(h.featureId, h);

  const out: RingHierarchyGateViolation[] = [];
  for (const history of after.histories) {
    const prior = beforeById.get(history.featureId);
    if (prior === history) continue;
    const priorAnchors = new Set(prior?.series.entries.map((e) => e.anchor) ?? []);
    for (const entry of history.series.entries) {
      if (priorAnchors.has(entry.anchor)) continue;
      const candidates = entry.anchor.snapshot.features.filter(
        (f): f is LeafFeature => isLeaf(f) && hasRingRelations(f),
      );
      if (candidates.length === 0) continue;
      const at = entry.start;
      // 頂点は系列をまたいで共有されうるので、その年に効いている頂点全体で引く
      // （地図に描くのと同じ引き方。教訓 5.29）。
      const effective = new Map(featuresAt(after, at).map((f) => [f.id, f]));
      const store = verticesAt(after, at);
      for (const candidate of candidates) {
        const live = effective.get(candidate.id);
        const leaf = live !== undefined && isLeaf(live) ? live : candidate;
        const result = validateCandidate(leaf.shape, store);
        if (result.valid) continue;
        if (wasAlreadyBroken(before, candidate.id, at)) continue;
        out.push({
          kind: RING_HIERARCHY_GATE_KIND,
          featureId: candidate.id,
          at,
          violations: result.violations,
        });
      }
    }
  }
  return out;
}

/** 編集の前の同じ年の同じ面が、もともと壊れていたか（無ければ「壊れていなかった」）。 */
function wasAlreadyBroken(before: DomainProject, featureId: FeatureId, at: TimePoint): boolean {
  const prior = featuresAt(before, at).find((f) => f.id === featureId);
  if (prior === undefined || !isLeaf(prior)) return false;
  return !validateCandidate(prior.shape, verticesAt(before, at)).valid;
}

/** 確定の手続きが返した違反の中に、この関門のものがあるか。 */
export function isRingHierarchyRejection(rejected: RejectedResult): boolean {
  const detail = rejected.detail;
  return (
    Array.isArray(detail) &&
    detail.some(
      (v: unknown) =>
        typeof v === 'object' &&
        v !== null &&
        (v as { kind?: unknown }).kind === RING_HIERARCHY_GATE_KIND,
    )
  );
}

/**
 * 編集が断られたときに状態行へ出す文。この関門で断ったなら具体的な理由を、そうでなければ
 * 確定の手続きの文をそのまま出す。
 */
export function editRejectionMessage(rejected: RejectedResult): string {
  return isRingHierarchyRejection(rejected) ? RING_HIERARCHY_GATE_STRINGS.refused : rejected.message;
}
