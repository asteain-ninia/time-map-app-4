// U30 — 結合後の上位領域・プロパティ決定のための候補集合算出 (FR-52, 4.5).
//
// UI ダイアログへ供給する構造化データ (選択肢の候補集合) を純粋関数で算出する。
// ダイアログの描画自体は UI 層の責務 (スコープ外)。本 module は:
//   1. 親候補列挙: 対象時間に存在し、結果地物の上位領域として整合する (循環を生まず、
//      存在期間が両立する) 既存面情報を列挙する。結合対象 (畳まれる側・継続する下位側)
//      は上位候補に含めない (結果地物の上位がその下位になると階層が壊れるため)。
//   2. プロパティ引き継ぎ元候補列挙: 結合対象のうちプロパティ引き継ぎ元として選べる
//      地物を列挙する。
//
// 親候補の循環・存在期間整合判定は U28 の {@link existencePeriodsCompatible} を再利用
// する (教訓 5.30: 同型の整合判定は単一実装を共有)。ただし結合では「結果地物」は新規
// なので循環の起点が異なる: 結果地物の下位になるのは結合対象 (とその下位) なので、親
// 候補から結合対象とその全下位領域を除外する (結果地物→親→…→結合対象 という縦の
// 巻き込みを防ぐ)。

import type { Feature } from '../feature';
import { buildForest, descendantIds, type Forest } from '../hierarchy/forest';
import type { FeatureId } from '../ids';
import { existsAtTime } from './precondition';

/**
 * 存在期間 (閉区間) の両立判定。U28 の existencePeriodsCompatible と同型 (区間重なり)
 * だが、結合では「結果地物の包絡 (年スカラー)」対「候補地物」を比較するため、Feature を
 * 仮構せずスカラー区間で判定する (教訓 5.30: 同型の区間重なりロジック)。両者が少なくとも
 * 一点で重なれば、親領域＝下位の和を将来満たせる位置にある。
 */
function periodsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** 候補 1 件: 候補 ID とその表示名 (UI ピッカー用)。 */
export interface MergeCandidate {
  readonly featureId: FeatureId;
  /** UI 表示名 (面情報の名称属性)。 */
  readonly displayName: string;
}

/**
 * 結果地物の存在期間 (結合対象群の包絡)。親候補の存在期間整合判定に用いる。集約は
 * 下位領域の和なので、下位を包含できる存在期間が必要 (U28 と同じ考え方)。
 */
function resultPeriod(
  byId: ReadonlyMap<FeatureId, Feature>,
  targetIds: readonly FeatureId[],
): { readonly startYear: number; readonly endYear: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of targetIds) {
    const f = byId.get(id);
    if (f === undefined) continue;
    start = Math.min(start, f.attributes.startYear);
    end = Math.max(end, f.attributes.endYear);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { startYear: 0, endYear: 0 };
  return { startYear: start, endYear: end };
}

/**
 * 親候補から除外すべき ID 集合: 結合対象すべてと、その全下位領域 (循環安全に列挙)。
 * 結果地物の下位になる集合を上位候補に含めると、結果地物→親→…→結合対象 という縦の
 * 巻き込み (循環/包含破壊) を生むため除外する。descendantIds は visited 集合で再入を
 * 遮断し壊れたデータでも有限終了する (教訓 5.28)。
 */
function excludedParentIds(forest: Forest, targetIds: readonly FeatureId[]): ReadonlySet<FeatureId> {
  const excluded = new Set<FeatureId>();
  for (const id of targetIds) {
    excluded.add(id);
    for (const d of descendantIds(forest, id)) excluded.add(d);
  }
  return excluded;
}

/**
 * 親候補列挙 (公開する主関数の一つ): `(現在状態, 結合対象, 対象時間) → 合法な既存上位
 * 領域候補の ID と表示名のリスト` (FR-52)。
 *
 * 候補は次をすべて満たす既存面情報:
 *   - 対象時間に存在する,
 *   - 結合対象でない・結合対象の下位領域でない (縦の巻き込み防止),
 *   - 結果地物の存在期間 (対象群の包絡) と存在期間が両立する (親領域＝下位の和を将来
 *     満たせる位置にある, FR-48 と同型)。
 *
 * UI が候補を隠していても、確定前検証は別途事前条件 (precondition.ts) と確定後整合性
 * (U13 委譲) が走るため、不正候補が入っても拒否される (教訓 5.26)。
 */
export function allowedMergeParentCandidates(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
  atTime: number,
): MergeCandidate[] {
  const forest = buildForest(features);
  const period = resultPeriod(forest.byId, targetIds);
  const excluded = excludedParentIds(forest, targetIds);

  const out: MergeCandidate[] = [];
  for (const id of forest.orderedIds) {
    if (excluded.has(id)) continue;
    const f = forest.byId.get(id);
    if (f === undefined) continue;
    if (!existsAtTime(f, atTime)) continue;
    if (
      !periodsOverlap(
        period.startYear,
        period.endYear,
        f.attributes.startYear,
        f.attributes.endYear,
      )
    ) {
      continue;
    }
    out.push({ featureId: id, displayName: f.attributes.name });
  }
  return out;
}

/**
 * プロパティ引き継ぎ元候補列挙 (公開する主関数の一つ): 結合対象のうちプロパティ引き
 * 継ぎ元として選べる地物を列挙する (FR-52)。結合対象すべてが引き継ぎ元になりうる
 * (末端・集約・継続下位を問わない: プロパティは名称・色・種別ラベル・存在期間であり
 * 種別に依らない)。対象集合に存在しない ID は除外する。
 */
export function propertyInheritCandidates(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
): MergeCandidate[] {
  const byId = new Map<FeatureId, Feature>(features.map((f) => [f.id, f] as const));
  const out: MergeCandidate[] = [];
  for (const id of targetIds) {
    const f = byId.get(id);
    if (f === undefined) continue;
    out.push({ featureId: id, displayName: f.attributes.name });
  }
  return out;
}
